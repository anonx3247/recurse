import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { Absurd } from "absurd-sdk";
import { FakeAgentInvoker } from "../src/agent/index";
import type { Project } from "../src/core/index";
import { TASK_IMPROVE_CYCLE, ensureWork, registerTasks } from "../src/kernel/index";
import { LocalSandboxRunner } from "../src/sandbox/index";
import { MemoryStore } from "../src/store/index";

/**
 * Absurd integration test — runs the durable engine fully OFFLINE on PGlite by
 * applying the vendored `vendor/absurd.sql` schema (with the `uuid_ossp` contrib
 * extension that absurd.sql requires). It exercises the primitives the kernel's
 * durable shell relies on: a checkpointed `ctx.step`, `ctx.sleepFor`, and an
 * `awaitEvent` / `emitEvent` round-trip, end to end through a real worker batch.
 *
 * PGlite path CHOSEN: PGlite + the `uuid_ossp` contrib applies absurd.sql and
 * runs the SDK without a real Postgres, so this is a true offline CI test (no
 * env flag, no Docker, no network).
 */

test("absurd on PGlite: vendored schema installs and the namespace exists", async () => {
  const db = await PGlite.create({ extensions: { uuid_ossp } });
  try {
    const sql = await readFile(new URL("../vendor/absurd.sql", import.meta.url), "utf8");
    await db.exec(sql);
    const { rows } = await db.query<{ present: boolean }>(
      "SELECT to_regnamespace('absurd') IS NOT NULL AS present",
    );
    assert.equal(rows[0]?.present, true);
  } finally {
    await db.close();
  }
});

test("absurd on PGlite: step checkpoint, sleepFor, and event round-trip", async () => {
  const db = await PGlite.create({ extensions: { uuid_ossp } });
  try {
    const sql = await readFile(new URL("../vendor/absurd.sql", import.meta.url), "utf8");
    await db.exec(sql);
    const app = new Absurd({ db: db as never, queueName: "recurse" });

    // createQueue is idempotent: a second call must not throw.
    await app.createQueue("recurse");
    await app.createQueue("recurse");
    assert.ok((await app.listQueues()).includes("recurse"));

    let stepRuns = 0;
    app.registerTask({ name: "smoke" }, async (params: { x: number }, ctx) => {
      // A checkpointed step: its result is cached and it runs exactly once.
      const doubled = await ctx.step("double", async () => {
        stepRuns++;
        return params.x * 2;
      });
      // A durable sleep (0s) suspends and resumes via the worker loop.
      await ctx.sleepFor("nap", 0);
      // Suspend until a human/event wakes us — the non-blocking pattern.
      const evt = (await ctx.awaitEvent("go", { timeout: 5 })) as { ok: boolean };
      return { doubled, ok: evt.ok };
    });

    const { taskID } = await app.spawn("smoke", { x: 21 });

    // Drive the worker in batches, emitting the awaited event each round, until
    // the task reaches a terminal state.
    let result: unknown;
    for (let i = 0; i < 40; i++) {
      await app.workBatch("test-worker", 60, 5);
      await app.emitEvent("go", { ok: true });
      const snap = await app.fetchTaskResult(taskID);
      if (snap?.state === "completed") {
        result = snap.result;
        break;
      }
      assert.notEqual(snap?.state, "failed", `task failed: ${JSON.stringify(snap)}`);
    }

    assert.deepEqual(result, { doubled: 42, ok: true });
    assert.equal(stepRuns, 1, "checkpointed step must run exactly once");
  } finally {
    await db.close();
  }
});

/** Run git in `cwd`, throwing on failure. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Fixture repo whose eval prints `{"score": <contents of score.txt>}`. */
async function makeFixtureRepo(initialScore: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "recurse-absurd-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "a@b.c");
  git(dir, "config", "user.name", "test");
  await writeFile(join(dir, "eval.sh"), 'printf \'{"score": %s}\\n\' "$(cat score.txt)"\n');
  await writeFile(join(dir, "score.txt"), `${initialScore}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init fixture");
  return dir;
}

test("absurd on PGlite: the durable improve-cycle task runs a full cycle to merge", async () => {
  const db = await PGlite.create({ extensions: { uuid_ossp } });
  const repo = await makeFixtureRepo("0.5");
  try {
    const sql = await readFile(new URL("../vendor/absurd.sql", import.meta.url), "utf8");
    await db.exec(sql);
    const app = new Absurd({ db: db as never, queueName: "recurse" });
    await app.createQueue("recurse");

    const store = new MemoryStore();
    const project: Project = await store.createProject({
      name: "fixture",
      repoUrl: repo,
      defaultBranch: "main",
      objective: "Maximize the score.",
      evalCommand: "sh eval.sh",
      metrics: [{ key: "score", label: "Score", direction: "maximize" }],
      concurrency: 1,
    });

    // Same fakes as the offline tests; the worker pushes to the fixture repo so
    // the reviewer can clone its branch.
    const workerInvoker = FakeAgentInvoker(async (handle, opts) => {
      await handle.exec("git config user.email a@b.c && git config user.name test", {
        cwd: opts.cwd,
      });
      await handle.writeFile(`${opts.cwd}/score.txt`, "0.9\n");
      await handle.exec('git add -A && git commit -m "chore: set score"', { cwd: opts.cwd });
    });
    const reviewerInvoker = FakeAgentInvoker(async (handle, opts) => {
      await handle.writeFile(
        `${opts.cwd}/.recurse/review.json`,
        JSON.stringify({ verdict: "approve", summary: "good", comments: [] }),
      );
    });

    registerTasks(
      app,
      {
        store,
        runner: new LocalSandboxRunner(),
        workerInvoker,
        reviewerInvoker,
        sandboxEnv: () => ({}),
        options: { workdir: "workspace" },
      },
      project,
    );

    const seeded = await ensureWork(store, project);
    assert.ok(seeded);
    await app.spawn(TASK_IMPROVE_CYCLE, { projectId: project.id, taskId: seeded.id });

    // Drive the worker until the cycle's task completes (worker + reviewer steps
    // each suspend/resume the durable run).
    let merged = false;
    for (let i = 0; i < 60 && !merged; i++) {
      await app.workBatch("test-worker", 600, 5);
      const changes = await store.listChanges(project.id);
      merged = changes.some((c) => c.status === "merged");
    }

    assert.ok(merged, "the durable cycle should merge the improving change");
    assert.equal((await store.getTask(seeded.id))?.status, "done");
    assert.ok((await store.listEvents(project.id)).some((e) => e.type === "change.merged"));
  } finally {
    await db.close();
    await rm(repo, { recursive: true, force: true });
  }
});
