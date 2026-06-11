import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AgentInvoker, FakeAgentInvoker, parseIdeas, runIdeator } from "../src/agent/index";
import type { Project } from "../src/core/index";
import {
  type CycleDeps,
  ensureWork,
  ensureWorkWithIdeator,
  runCycle,
  runIdeatorPhase,
} from "../src/kernel/index";
import { LocalSandboxRunner } from "../src/sandbox/index";
import { MemoryStore } from "../src/store/index";

/**
 * Fully offline tests of the Ideator: a real `LocalSandboxRunner` + a
 * `FakeAgentInvoker` against a throwaway git fixture, plus pure parser tests.
 * No model, no network. They assert the ideator turns fake structured output
 * into `Task`s, that the never-idle seam only runs it when the queue is empty
 * and respects the cap, and that generated tasks are picked up by the cycle.
 */

/** Run git in `cwd`, throwing on failure. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Fixture repo whose eval prints `{"score": <contents of score.txt>}`. */
async function makeFixtureRepo(initialScore: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "recurse-ideator-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "a@b.c");
  git(dir, "config", "user.name", "test");
  await writeFile(join(dir, "eval.sh"), 'printf \'{"score": %s}\\n\' "$(cat score.txt)"\n');
  await writeFile(join(dir, "score.txt"), `${initialScore}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init fixture");
  return dir;
}

function fixtureProject(repoUrl: string): Omit<Project, "id" | "createdAt"> {
  return {
    name: "fixture",
    repoUrl,
    defaultBranch: "main",
    objective: "Maximize the score.",
    evalCommand: "sh eval.sh",
    metrics: [{ key: "score", label: "Score", direction: "maximize" }],
    concurrency: 1,
  };
}

/** Two example ideas the fake ideator proposes (wrapped in prose, to test tolerance). */
const IDEAS = [
  { title: "Raise the score", prompt: "Bump score.txt to 0.9.", priority: 2 },
  { title: "Add a test", prompt: "Add a regression test.", priority: 0 },
];

/** A fake ideator that writes `.recurse/ideas.json` (optionally surrounded by prose). */
function ideatorWriting(ideas: unknown, prose = false): AgentInvoker {
  return FakeAgentInvoker(async (handle, opts) => {
    const body = JSON.stringify({ ideas });
    const content = prose ? `Here are my ideas:\n${body}\nHope that helps!` : body;
    await handle.writeFile(`${opts.cwd}/.recurse/ideas.json`, content);
  });
}

/** Build cycle deps wired for tests, with an optional ideator invoker. */
function makeDeps(store: MemoryStore, ideatorInvoker?: AgentInvoker): CycleDeps {
  return {
    store,
    runner: new LocalSandboxRunner(),
    workerInvoker: FakeAgentInvoker(() => {}),
    reviewerInvoker: FakeAgentInvoker(() => {}),
    ideatorInvoker,
    sandboxEnv: () => ({}),
    options: { workdir: "workspace" },
  };
}

// ── pure parser ──────────────────────────────────────────────────────────────

test("parseIdeas: tolerates prose around the JSON and skips invalid entries", () => {
  const text = `blah blah\n${JSON.stringify({
    ideas: [
      { title: "ok", prompt: "do it", priority: 5 },
      { title: "", prompt: "no title", priority: 1 }, // invalid: empty title
      { title: "no prompt", prompt: "", priority: 1 }, // invalid: empty prompt
      { title: "default prio", prompt: "x" }, // priority defaults to 0
    ],
  })}\ntrailing`;
  assert.deepEqual(parseIdeas(text, 10), [
    { title: "ok", prompt: "do it", priority: 5 },
    { title: "default prio", prompt: "x", priority: 0 },
  ]);
});

test("parseIdeas: caps to the limit and returns [] on garbage", () => {
  const text = JSON.stringify({ ideas: IDEAS });
  assert.equal(parseIdeas(text, 1).length, 1);
  assert.deepEqual(parseIdeas("no json here", 5), []);
  assert.deepEqual(parseIdeas('{"notIdeas": 1}', 5), []);
});

// ── runIdeator (end to end, offline) ─────────────────────────────────────────

test("runIdeator: parses ideas from a fake response wrapped in prose", async () => {
  const repo = await makeFixtureRepo("0.5");
  try {
    const project: Project = {
      ...fixtureProject(repo),
      id: "proj-1",
      createdAt: new Date().toISOString(),
    };
    const result = await runIdeator({
      runner: new LocalSandboxRunner(),
      invoker: ideatorWriting(IDEAS, true),
      project,
      workdir: "workspace",
      count: 3,
    });
    assert.deepEqual(result.ideas, IDEAS);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("runIdeator: missing ideas file degrades to an empty list", async () => {
  const repo = await makeFixtureRepo("0.5");
  try {
    const project: Project = {
      ...fixtureProject(repo),
      id: "proj-1",
      createdAt: new Date().toISOString(),
    };
    const result = await runIdeator({
      runner: new LocalSandboxRunner(),
      invoker: FakeAgentInvoker(() => {}), // writes nothing
      project,
      workdir: "workspace",
    });
    assert.deepEqual(result.ideas, []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ── runIdeatorPhase (persists tasks + events) ────────────────────────────────

test("runIdeatorPhase: persists ideas as ideator improve tasks and emits events", async () => {
  const repo = await makeFixtureRepo("0.5");
  try {
    const store = new MemoryStore();
    const project = await store.createProject(fixtureProject(repo));
    const tasks = await runIdeatorPhase(makeDeps(store, ideatorWriting(IDEAS)), project);

    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((t) => t.kind === "improve" && t.source === "ideator"));
    assert.deepEqual(
      tasks.map((t) => t.title),
      ["Raise the score", "Add a test"],
    );

    const queued = await store.listTasks(project.id, { status: "queued" });
    assert.equal(queued.length, 2);
    const events = (await store.listEvents(project.id)).filter((e) => e.type === "idea.generated");
    assert.equal(events.length, 2);
    // The ideator AgentRun is recorded and succeeded.
    const runs = await store.listAgentRuns(project.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].role, "ideator");
    assert.equal(runs[0].status, "succeeded");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ── ensureWorkWithIdeator (the never-idle seam) ──────────────────────────────

test("ensureWorkWithIdeator: runs the ideator only when no improve work is queued", async () => {
  const repo = await makeFixtureRepo("0.5");
  try {
    const store = new MemoryStore();
    const project = await store.createProject(fixtureProject(repo));
    const deps = makeDeps(store, ideatorWriting(IDEAS));
    const ideator = { generate: () => runIdeatorPhase(deps, project) };

    // Empty queue → ideator generates tasks.
    const created = await ensureWorkWithIdeator(store, project, ideator);
    assert.equal(created.length, 2);
    assert.ok(created.every((t) => t.source === "ideator"));

    // Work now queued → no-op (no extra generation).
    const again = await ensureWorkWithIdeator(store, project, ideator);
    assert.deepEqual(again, []);
    assert.equal((await store.listTasks(project.id, { status: "queued" })).length, 2);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("ensureWorkWithIdeator: respects the cap and falls back to a generic seed", async () => {
  const repo = await makeFixtureRepo("0.5");
  try {
    const store = new MemoryStore();
    const project = await store.createProject(fixtureProject(repo));
    const deps = makeDeps(store, ideatorWriting(IDEAS));
    // Cap of 1: pre-seed one running ideator task so the cap is already reached.
    await store.createTask({
      projectId: project.id,
      kind: "improve",
      title: "in-flight idea",
      prompt: "x",
      priority: 0,
      source: "ideator",
      status: "running",
    });
    const ideator = { generate: () => runIdeatorPhase(deps, project), cap: 1 };

    const created = await ensureWorkWithIdeator(store, project, ideator);
    // At cap → ideator is skipped; a single generic scheduler seed is returned.
    assert.equal(created.length, 1);
    assert.equal(created[0].source, "scheduler");
    // No ideator events were emitted (the ideator never ran).
    assert.equal((await store.listEvents(project.id)).length, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("ensureWorkWithIdeator: with no ideator, falls back to the generic seed", async () => {
  const store = new MemoryStore();
  const project = await store.createProject(fixtureProject("x"));
  const created = await ensureWorkWithIdeator(store, project);
  assert.equal(created.length, 1);
  assert.equal(created[0].source, "scheduler");
  // Same as the bare ensureWork no-op once work exists.
  assert.equal(await ensureWork(store, project), undefined);
});

// ── integration: a generated task is picked up by the cycle ──────────────────

test("a generated ideator task is picked up and run by the cycle", async () => {
  const repo = await makeFixtureRepo("0.5");
  try {
    const store = new MemoryStore();
    const project = await store.createProject(fixtureProject(repo));

    // The worker fake raises the score; the reviewer approves → the change merges.
    const deps: CycleDeps = {
      store,
      runner: new LocalSandboxRunner(),
      workerInvoker: FakeAgentInvoker(async (handle, opts) => {
        await handle.exec("git config user.email a@b.c && git config user.name test", {
          cwd: opts.cwd,
        });
        await handle.writeFile(`${opts.cwd}/score.txt`, "0.9\n");
        await handle.exec('git add -A && git commit -m "chore: set score"', { cwd: opts.cwd });
      }),
      reviewerInvoker: FakeAgentInvoker(async (handle, opts) => {
        await handle.writeFile(
          `${opts.cwd}/.recurse/review.json`,
          JSON.stringify({ verdict: "approve", summary: "good", comments: [] }),
        );
      }),
      ideatorInvoker: ideatorWriting([{ title: "Raise score", prompt: "set 0.9", priority: 1 }]),
      sandboxEnv: () => ({}),
      options: { workdir: "workspace" },
    };

    const ideator = { generate: () => runIdeatorPhase(deps, project) };
    const created = await ensureWorkWithIdeator(store, project, ideator);
    assert.equal(created.length, 1);

    const outcome = await runCycle(deps, project, created[0]);
    assert.equal(outcome?.merged, true);
    assert.equal((await store.getTask(created[0].id))?.status, "done");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
