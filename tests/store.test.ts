import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStore, type Store } from "../src/store/index.js";
import { SqliteStore } from "../src/store/index.js";

/** Build a project with metrics and exercise the full store surface. */
function runSuite(name: string, makeStore: () => Store) {
  test(`${name}: round-trips entities and the event log`, () => {
    const store = makeStore();
    try {
      // Project
      const project = store.createProject({
        name: "demo",
        repoUrl: "https://example.com/demo.git",
        defaultBranch: "main",
        objective: "improve",
        evalCommand: "node eval.mjs",
        metrics: [{ key: "coverage", label: "Coverage", direction: "maximize" }],
        concurrency: 2,
      });
      assert.ok(project.id);
      assert.deepEqual(store.getProject(project.id), project);
      assert.equal(store.listProjects().length, 1);

      // Task
      const task = store.createTask({
        projectId: project.id,
        kind: "improve",
        title: "raise coverage",
        prompt: "add tests",
        priority: 1,
        source: "human",
      });
      assert.equal(task.status, "queued");
      store.updateTaskStatus(task.id, "running");
      assert.equal(store.getTask(task.id)?.status, "running");
      assert.equal(store.listTasks(project.id, { status: "running" }).length, 1);
      assert.equal(store.listTasks(project.id, { status: "done" }).length, 0);

      // Change
      const change = store.createChange({
        projectId: project.id,
        taskId: task.id,
        branch: "recurse/raise-coverage",
        title: "Raise coverage",
        summary: "added tests",
        status: "in_review",
        baseMetrics: { coverage: 0.42 },
        newMetrics: { coverage: 0.61 },
      });
      assert.deepEqual(store.getChange(change.id)?.newMetrics, { coverage: 0.61 });
      const merged = store.updateChange(change.id, { status: "merged" });
      assert.equal(merged.status, "merged");
      assert.equal(store.listChanges(project.id).length, 1);

      // Review
      const run = store.createAgentRun({
        projectId: project.id,
        changeId: change.id,
        role: "reviewer",
        status: "running",
      });
      const review = store.createReview({
        changeId: change.id,
        reviewerRunId: run.id,
        verdict: "approve",
        summary: "looks good",
        comments: [{ body: "nice tests", severity: "info" }],
      });
      assert.equal(store.listReviews(change.id)[0].comments[0].severity, "info");
      assert.equal(review.verdict, "approve");

      // Agent run update
      store.updateAgentRun(run.id, { status: "succeeded", endedAt: new Date().toISOString() });
      assert.equal(store.listAgentRuns(project.id)[0].status, "succeeded");

      // Metric samples
      store.recordMetricSample({
        projectId: project.id,
        changeId: change.id,
        metricKey: "coverage",
        value: 0.42,
      });
      store.recordMetricSample({
        projectId: project.id,
        metricKey: "coverage",
        value: 0.61,
      });
      const samples = store.listMetricSamples(project.id, "coverage");
      assert.equal(samples.length, 2);
      assert.deepEqual(
        samples.map((s) => s.value),
        [0.42, 0.61],
      );

      // Pointer
      const pointer = store.createPointer({ projectId: project.id, body: "try property tests" });
      assert.equal(pointer.fromHuman, true);
      assert.equal(store.listPointers(project.id, { consumed: false }).length, 1);
      assert.equal(store.listPointers(project.id, { consumed: true }).length, 0);

      // Question
      const question = store.createQuestion({ projectId: project.id, body: "which module first?" });
      assert.equal(question.status, "open");
      const answered = store.answerQuestion(question.id, "the parser");
      assert.equal(answered.status, "answered");
      assert.equal(answered.answer, "the parser");
      assert.equal(store.listQuestions(project.id)[0].status, "answered");

      // Event log
      const e1 = store.appendEvent({
        projectId: project.id,
        type: "task.created",
        payload: { id: task.id },
      });
      const e2 = store.appendEvent({
        projectId: project.id,
        type: "change.merged",
        payload: { id: change.id },
      });
      const all = store.listEvents(project.id);
      assert.equal(all.length, 2);
      assert.deepEqual(all[0].payload, { id: task.id });
      const since = store.listEvents(project.id, { sinceId: e1.id });
      assert.equal(since.length, 1);
      assert.equal(since[0].id, e2.id);
    } finally {
      store.close();
    }
  });
}

runSuite("MemoryStore", () => new MemoryStore());

runSuite("SqliteStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "recurse-store-"));
  const dbPath = join(dir, "test.sqlite");
  const store = new SqliteStore(dbPath);
  const origClose = store.close.bind(store);
  store.close = () => {
    origClose();
    rmSync(dir, { recursive: true, force: true });
  };
  return store;
});
