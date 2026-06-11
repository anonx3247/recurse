import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { MemoryStore, PgStore, type Store } from "../src/store/index";
import * as schema from "../src/store/schema";

/** Build a project with metrics and exercise the full store surface. */
function runSuite(name: string, makeStore: () => Promise<Store>) {
  test(`${name}: round-trips entities and the event log`, async () => {
    const store = await makeStore();
    try {
      // Project
      const project = await store.createProject({
        name: "demo",
        repoUrl: "https://example.com/demo.git",
        defaultBranch: "main",
        objective: "improve",
        evalCommand: "node eval.mjs",
        metrics: [{ key: "coverage", label: "Coverage", direction: "maximize" }],
        concurrency: 2,
      });
      assert.ok(project.id);
      assert.deepEqual(await store.getProject(project.id), project);
      assert.equal((await store.listProjects()).length, 1);

      // Task
      const task = await store.createTask({
        projectId: project.id,
        kind: "improve",
        title: "raise coverage",
        prompt: "add tests",
        priority: 1,
        source: "human",
      });
      assert.equal(task.status, "queued");
      await store.updateTaskStatus(task.id, "running");
      assert.equal((await store.getTask(task.id))?.status, "running");
      assert.equal((await store.listTasks(project.id, { status: "running" })).length, 1);
      assert.equal((await store.listTasks(project.id, { status: "done" })).length, 0);

      // Change
      const change = await store.createChange({
        projectId: project.id,
        taskId: task.id,
        branch: "recurse/raise-coverage",
        title: "Raise coverage",
        summary: "added tests",
        status: "in_review",
        baseMetrics: { coverage: 0.42 },
        newMetrics: { coverage: 0.61 },
      });
      assert.deepEqual((await store.getChange(change.id))?.newMetrics, { coverage: 0.61 });
      const merged = await store.updateChange(change.id, { status: "merged" });
      assert.equal(merged.status, "merged");
      assert.equal((await store.listChanges(project.id)).length, 1);

      // Review
      const run = await store.createAgentRun({
        projectId: project.id,
        changeId: change.id,
        role: "reviewer",
        status: "running",
      });
      const review = await store.createReview({
        changeId: change.id,
        reviewerRunId: run.id,
        verdict: "approve",
        summary: "looks good",
        comments: [{ body: "nice tests", severity: "info" }],
      });
      assert.equal((await store.listReviews(change.id))[0].comments[0].severity, "info");
      assert.equal(review.verdict, "approve");

      // Agent run update
      await store.updateAgentRun(run.id, {
        status: "succeeded",
        endedAt: new Date().toISOString(),
      });
      assert.equal((await store.listAgentRuns(project.id))[0].status, "succeeded");

      // Metric samples
      await store.recordMetricSample({
        projectId: project.id,
        changeId: change.id,
        metricKey: "coverage",
        value: 0.42,
      });
      await store.recordMetricSample({
        projectId: project.id,
        metricKey: "coverage",
        value: 0.61,
      });
      const samples = await store.listMetricSamples(project.id, "coverage");
      assert.equal(samples.length, 2);
      assert.deepEqual(
        samples.map((s) => s.value),
        [0.42, 0.61],
      );

      // Pointer
      const pointer = await store.createPointer({
        projectId: project.id,
        body: "try property tests",
      });
      assert.equal(pointer.fromHuman, true);
      assert.equal((await store.listPointers(project.id, { consumed: false })).length, 1);
      assert.equal((await store.listPointers(project.id, { consumed: true })).length, 0);

      // Question
      const question = await store.createQuestion({
        projectId: project.id,
        body: "which module first?",
      });
      assert.equal(question.status, "open");
      const answered = await store.answerQuestion(question.id, "the parser");
      assert.equal(answered.status, "answered");
      assert.equal(answered.answer, "the parser");
      assert.equal((await store.listQuestions(project.id))[0].status, "answered");

      // Event log
      const e1 = await store.appendEvent({
        projectId: project.id,
        type: "task.created",
        payload: { id: task.id },
      });
      const e2 = await store.appendEvent({
        projectId: project.id,
        type: "change.merged",
        payload: { id: change.id },
      });
      const all = await store.listEvents(project.id);
      assert.equal(all.length, 2);
      assert.deepEqual(all[0].payload, { id: task.id });
      const since = await store.listEvents(project.id, { sinceId: e1.id });
      assert.equal(since.length, 1);
      assert.equal(since[0].id, e2.id);
    } finally {
      await store.close();
    }
  });
}

runSuite("MemoryStore", async () => new MemoryStore());

runSuite("PgStore (PGlite)", async () => {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  return PgStore.fromDrizzle(db, () => client.close());
});
