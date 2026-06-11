import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AgentInvoker, FakeAgentInvoker } from "../src/agent/index";
import type { MetricSpec, Project, Review } from "../src/core/index";
import {
  Kernel,
  type KernelOptions,
  compareMetrics,
  ensureWork,
  evaluateGate,
  isReviewApproved,
  pickNextTask,
} from "../src/kernel/index";
import { LocalSandboxRunner } from "../src/sandbox/index";
import { MemoryStore } from "../src/store/index";

/**
 * Fully offline kernel tests: a real `MemoryStore` + `LocalSandboxRunner` plus
 * `FakeAgentInvoker`s against a throwaway git fixture. No model, no Daytona, no
 * network, no real sleeps.
 */

const MAXIMIZE: MetricSpec[] = [{ key: "score", label: "Score", direction: "maximize" }];

/** Run git in `cwd`, throwing on failure. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * A fixture repo whose eval prints `{"score": <contents of score.txt>}`, so a
 * fake worker controls the metric by writing `score.txt`.
 */
async function makeFixtureRepo(initialScore: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "recurse-kernel-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "a@b.c");
  git(dir, "config", "user.name", "test");
  await writeFile(join(dir, "eval.sh"), 'printf \'{"score": %s}\\n\' "$(cat score.txt)"\n');
  await writeFile(join(dir, "score.txt"), `${initialScore}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init fixture");
  return dir;
}

function fixtureProject(repoUrl: string, concurrency = 1): Omit<Project, "id" | "createdAt"> {
  return {
    name: "fixture",
    repoUrl,
    defaultBranch: "main",
    objective: "Maximize the score.",
    evalCommand: "sh eval.sh",
    metrics: MAXIMIZE,
    concurrency,
  };
}

/** A worker fake that sets score.txt to `score` and commits in the clone. */
function workerSetting(score: number): AgentInvoker {
  return FakeAgentInvoker(async (handle, opts) => {
    await handle.exec("git config user.email a@b.c && git config user.name test", {
      cwd: opts.cwd,
    });
    await handle.writeFile(`${opts.cwd}/score.txt`, `${score}\n`);
    const commit = await handle.exec('git add -A && git commit -m "chore: set score"', {
      cwd: opts.cwd,
    });
    assert.equal(commit.exitCode, 0, commit.stderr);
  });
}

/** A reviewer fake that writes a fixed verdict to `.recurse/review.json`. */
function reviewerWith(review: Pick<Review, "verdict" | "summary" | "comments">): AgentInvoker {
  return FakeAgentInvoker(async (handle, opts) => {
    await handle.writeFile(`${opts.cwd}/.recurse/review.json`, JSON.stringify(review));
  });
}

/**
 * Build a kernel wired for tests: zero idle delay and a relative workdir. The
 * worker pushes its branch to the fixture repo (a non-bare repo accepts a new,
 * non-checked-out branch) so the reviewer can clone it, mirroring production.
 */
function makeKernel(
  store: MemoryStore,
  workerInvoker: AgentInvoker,
  reviewerInvoker: AgentInvoker,
  options: KernelOptions = {},
): Kernel {
  return new Kernel({
    store,
    runner: new LocalSandboxRunner(),
    workerInvoker,
    reviewerInvoker,
    sandboxEnv: () => ({}),
    options: { idleDelayMs: 0, workdir: "workspace", ...options },
  });
}

// ── merge-gate unit tests (pure) ────────────────────────────────────────────

test("compareMetrics: maximize improvement and regression", () => {
  const maximize: MetricSpec[] = [{ key: "s", label: "S", direction: "maximize" }];
  assert.deepEqual(compareMetrics(maximize, { s: 1 }, { s: 2 }), {
    regressed: [],
    improved: ["s"],
    equalOnly: false,
  });
  assert.deepEqual(compareMetrics(maximize, { s: 2 }, { s: 1 }), {
    regressed: ["s"],
    improved: [],
    equalOnly: false,
  });
});

test("compareMetrics: minimize flips the direction", () => {
  const minimize: MetricSpec[] = [{ key: "e", label: "E", direction: "minimize" }];
  assert.deepEqual(compareMetrics(minimize, { e: 5 }, { e: 2 }).improved, ["e"]);
  assert.deepEqual(compareMetrics(minimize, { e: 2 }, { e: 5 }).regressed, ["e"]);
});

test("compareMetrics: equal-only and missing baseline counts as improvement", () => {
  const m: MetricSpec[] = [{ key: "s", label: "S", direction: "maximize" }];
  assert.equal(compareMetrics(m, { s: 1 }, { s: 1 }).equalOnly, true);
  assert.deepEqual(compareMetrics(m, undefined, { s: 1 }).improved, ["s"]);
});

test("evaluateGate: blocks regression, requires strict improvement by default", () => {
  const approve: Review["verdict"] = "approve";
  const ok = evaluateGate({
    review: { verdict: approve, comments: [] },
    comparison: { regressed: [], improved: ["s"], equalOnly: false },
  });
  assert.equal(ok.merge, true);

  const regressed = evaluateGate({
    review: { verdict: approve, comments: [] },
    comparison: { regressed: ["s"], improved: [], equalOnly: false },
  });
  assert.equal(regressed.merge, false);

  const equal = evaluateGate({
    review: { verdict: approve, comments: [] },
    comparison: { regressed: [], improved: [], equalOnly: true },
  });
  assert.equal(equal.merge, false);
  assert.equal(
    evaluateGate({
      review: { verdict: approve, comments: [] },
      comparison: { regressed: [], improved: [], equalOnly: true },
      policy: { allowEqual: true },
    }).merge,
    true,
  );
});

test("evaluateGate / isReviewApproved: blocker comments block approval", () => {
  const review = {
    verdict: "approve" as const,
    comments: [{ body: "no", severity: "blocker" as const }],
  };
  assert.equal(isReviewApproved(review), false);
  assert.equal(
    evaluateGate({ review, comparison: { regressed: [], improved: ["s"], equalOnly: false } })
      .merge,
    false,
  );
});

// ── scheduler (never-idle) ──────────────────────────────────────────────────

test("ensureWork: seeds a task only when the queue is empty", async () => {
  const store = new MemoryStore();
  const project = await store.createProject(fixtureProject("x"));
  const seeded = await ensureWork(store, project);
  assert.ok(seeded);
  assert.equal(seeded.source, "scheduler");
  assert.equal((await store.listTasks(project.id, { status: "queued" })).length, 1);
  // Already has queued work → no-op.
  assert.equal(await ensureWork(store, project), undefined);
  assert.equal((await pickNextTask(store, project.id))?.id, seeded.id);
});

// ── kernel cycles (end to end, offline) ─────────────────────────────────────

test("runCycle happy path: improving change merges and updates baseline", async () => {
  const repo = await makeFixtureRepo("0.5");
  try {
    const store = new MemoryStore();
    const project = await store.createProject(fixtureProject(repo));
    const kernel = makeKernel(
      store,
      workerSetting(0.9),
      reviewerWith({ verdict: "approve", summary: "good", comments: [] }),
    );

    await kernel.runCycle(project.id);

    const changes = await store.listChanges(project.id);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].status, "merged");
    assert.deepEqual(changes[0].newMetrics, { score: 0.9 });
    // Baseline was empty on first run; the merged change now sets it.
    const samples = await store.listMetricSamples(project.id, "score");
    assert.equal(samples.length, 1);
    assert.equal(samples[0].changeId, changes[0].id);
    const types = (await store.listEvents(project.id)).map((e) => e.type);
    assert.ok(types.includes("change.merged"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("runCycle: regression is blocked even when the review approves", async () => {
  const repo = await makeFixtureRepo("0.5");
  try {
    const store = new MemoryStore();
    const project = await store.createProject(fixtureProject(repo));
    // Seed a baseline by recording a prior merged change at score 0.8.
    await store.createChange({
      projectId: project.id,
      taskId: "seed",
      branch: "recurse/seed",
      title: "seed",
      summary: "",
      status: "merged",
      newMetrics: { score: 0.8 },
    });

    const kernel = makeKernel(
      store,
      workerSetting(0.2), // worse than baseline 0.8
      reviewerWith({ verdict: "approve", summary: "lgtm", comments: [] }),
    );
    await kernel.runCycle(project.id);

    const change = (await store.listChanges(project.id)).find((c) => c.branch !== "recurse/seed");
    assert.ok(change);
    assert.notEqual(change.status, "merged");
    assert.equal(change.status, "abandoned");
    assert.ok((await store.listEvents(project.id)).some((e) => e.type === "change.rejected"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("runCycle: request_changes enqueues a capped follow-up loop", async () => {
  const repo = await makeFixtureRepo("0.5");
  try {
    const store = new MemoryStore();
    const project = await store.createProject(fixtureProject(repo));
    const kernel = makeKernel(
      store,
      workerSetting(0.9),
      reviewerWith({ verdict: "request_changes", summary: "fix it", comments: [] }),
      { maxReviewIterations: 2 },
    );

    // Drive one lineage to its cap: seed → follow-up → follow-up, then stop.
    for (let i = 0; i < 3; i++) await kernel.runCycle(project.id);

    const reviewTasks = (await store.listTasks(project.id)).filter((t) => t.source === "review");
    assert.ok(reviewTasks.length > 0);
    assert.ok(reviewTasks.every((t) => t.parentChangeId));
    // Lineage capped at maxReviewIterations follow-ups.
    assert.equal(reviewTasks.length, 2);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("start: bounded by maxCycles and stoppable", async () => {
  const repo = await makeFixtureRepo("0.5");
  try {
    const store = new MemoryStore();
    const project = await store.createProject(fixtureProject(repo, 1));
    const kernel = makeKernel(
      store,
      workerSetting(0.9),
      reviewerWith({ verdict: "approve", summary: "good", comments: [] }),
    );

    await kernel.start(project.id, { maxCycles: 2 });
    // Two cycles ran sequentially; the first merged and set the baseline.
    assert.equal((await store.listChanges(project.id)).length, 2);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
