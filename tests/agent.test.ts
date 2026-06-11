import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeAgentInvoker, parseEvalOutput, runReviewer, runWorker } from "../src/agent/index";
import type { Change, Project, Task } from "../src/core/index";
import { LocalSandboxRunner } from "../src/sandbox/index";

/**
 * Offline tests: a real `LocalSandboxRunner` plus a `FakeAgentInvoker`, against
 * a throwaway git fixture repo. No model and no network are used anywhere.
 */

/** An eval script that prints log noise, then the metric JSON on its own line. */
const EVAL_SH = `echo "running eval..."
echo '{"score": 0.9}'
`;

/** Run git in `cwd`, throwing on failure. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Create a tiny git repo with an eval script and a file to modify. */
async function makeFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "recurse-fixture-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "a@b.c");
  git(dir, "config", "user.name", "test");
  await writeFile(join(dir, "eval.sh"), EVAL_SH);
  await writeFile(join(dir, "target.txt"), "original\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init fixture");
  return dir;
}

/** A minimal project pointing at a local fixture repo. */
function fixtureProject(repoUrl: string): Project {
  return {
    id: "proj-1",
    name: "fixture",
    repoUrl,
    defaultBranch: "main",
    objective: "Improve the score.",
    evalCommand: "sh eval.sh",
    metrics: [{ key: "score", label: "Score", direction: "maximize" }],
    concurrency: 1,
    createdAt: new Date().toISOString(),
  };
}

const improveTask: Task = {
  id: "task-abcdef12",
  projectId: "proj-1",
  kind: "improve",
  title: "tweak target",
  prompt: "Edit target.txt.",
  status: "running",
  priority: 0,
  source: "human",
  createdAt: new Date().toISOString(),
};

test("runWorker: produces a branch, diff, changed files, and metrics", async () => {
  const repo = await makeFixtureRepo();
  try {
    const project = fixtureProject(repo);
    // The fake agent edits a file and commits, configuring git identity in the
    // fresh clone (clones do not inherit the origin's local git config).
    const invoker = FakeAgentInvoker(async (handle, opts) => {
      await handle.exec("git config user.email a@b.c && git config user.name test", {
        cwd: opts.cwd,
      });
      await handle.writeFile(`${opts.cwd}/target.txt`, "improved by worker\n");
      const commit = await handle.exec('git add -A && git commit -m "feat: improve target"', {
        cwd: opts.cwd,
      });
      assert.equal(commit.exitCode, 0, commit.stderr);
    });

    const result = await runWorker({
      runner: new LocalSandboxRunner(),
      invoker,
      project,
      task: improveTask,
      workdir: "workspace",
      push: async () => {}, // no remote in tests
    });

    assert.equal(result.branch, "recurse/taskabcd");
    assert.equal(result.commitSubject, "feat: improve target");
    assert.match(result.diff, /improved by worker/);
    assert.deepEqual(result.changedFiles, ["target.txt"]);
    assert.deepEqual(result.metrics, { score: 0.9 });
    assert.ok(result.log.includes("Edit target.txt"));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

/** Add a `recurse/review-me` branch with a change for the reviewer to inspect. */
function addChangeBranch(repo: string): Change {
  const branch = "recurse/review-me";
  git(repo, "checkout", "-q", "-b", branch);
  execFileSync("sh", ["-c", 'echo "changed" > target.txt'], { cwd: repo });
  git(repo, "commit", "-aq", "-m", "change for review");
  git(repo, "checkout", "-q", "main");
  return {
    id: "change-1",
    projectId: "proj-1",
    taskId: "task-1",
    branch,
    title: "change for review",
    summary: "",
    status: "in_review",
    baseMetrics: { score: 0.5 },
    newMetrics: { score: 0.9 },
    createdAt: new Date().toISOString(),
  };
}

test("runReviewer: parses a valid review.json verdict and comments", async () => {
  const repo = await makeFixtureRepo();
  try {
    const project = fixtureProject(repo);
    const change = addChangeBranch(repo);
    const invoker = FakeAgentInvoker(async (handle, opts) => {
      const review = {
        verdict: "approve",
        summary: "Looks good and improves the score.",
        comments: [{ path: "target.txt", line: 1, body: "nice", severity: "nit" }],
      };
      await handle.writeFile(`${opts.cwd}/.recurse/review.json`, JSON.stringify(review));
    });

    const result = await runReviewer({
      runner: new LocalSandboxRunner(),
      invoker,
      project,
      change,
      diff: "fake diff",
      workdir: "workspace",
    });

    assert.equal(result.verdict, "approve");
    assert.equal(result.summary, "Looks good and improves the score.");
    assert.deepEqual(result.comments, [
      { path: "target.txt", line: 1, body: "nice", severity: "nit" },
    ]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("runReviewer: malformed review.json falls back to a comment verdict", async () => {
  const repo = await makeFixtureRepo();
  try {
    const project = fixtureProject(repo);
    const change = addChangeBranch(repo);
    const invoker = FakeAgentInvoker(async (handle, opts) => {
      await handle.writeFile(`${opts.cwd}/.recurse/review.json`, "{ not valid json");
    });

    const result = await runReviewer({
      runner: new LocalSandboxRunner(),
      invoker,
      project,
      change,
      diff: "fake diff",
      workdir: "workspace",
    });

    assert.equal(result.verdict, "comment");
    assert.match(result.summary, /no valid \.recurse\/review\.json/);
    assert.deepEqual(result.comments, []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("parseEvalOutput: clean JSON", () => {
  assert.deepEqual(parseEvalOutput('{"score": 0.42, "lintErrors": 3}'), {
    score: 0.42,
    lintErrors: 3,
  });
});

test("parseEvalOutput: tolerates log lines before the JSON", () => {
  const stdout = 'building...\nrunning tests\n{"a": 1}\n{"score": 2}\n';
  assert.deepEqual(parseEvalOutput(stdout), { score: 2 });
});

test("parseEvalOutput: throws when there is no JSON object", () => {
  assert.throws(() => parseEvalOutput("no json here"), /no JSON object/);
});

test("parseEvalOutput: throws on non-finite metric values", () => {
  assert.throws(() => parseEvalOutput('{"score": "high"}'), /not a finite number/);
});

test("parseEvalOutput: throws on invalid JSON", () => {
  assert.throws(() => parseEvalOutput("{ broken"), /no JSON object|not valid JSON/);
});
