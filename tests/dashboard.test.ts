import assert from "node:assert/strict";
import { after, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Absurd } from "absurd-sdk";
import { drizzle } from "drizzle-orm/pglite";
import type { Project } from "../src/core/index";
import { type DashboardHandle, type DashboardState, startDashboard } from "../src/dashboard/server";
import { PgStore } from "../src/store/index";
import * as schema from "../src/store/schema";

/**
 * Offline dashboard tests: a real async {@link PgStore} on PGlite behind the
 * `node:http` server on an ephemeral port, exercised with `fetch`. No browser,
 * no real Postgres, no kernel. The answer endpoint is wired to a tiny fake
 * Absurd whose `emitEvent` we spy on, so we assert both the store write AND the
 * wake-up event without standing up the durable engine.
 */

const PROJECT: Omit<Project, "id" | "createdAt"> = {
  name: "demo",
  repoUrl: "https://example.com/demo.git",
  defaultBranch: "main",
  objective: "Maximize the score.",
  evalCommand: "sh eval.sh",
  metrics: [{ key: "score", label: "Score", direction: "maximize" }],
  concurrency: 1,
};

/** A fake Absurd that only records the events the answer path emits. */
function fakeAbsurd(): { app: Absurd; events: { channel: string; payload: unknown }[] } {
  const events: { channel: string; payload: unknown }[] = [];
  const app = {
    emitEvent: async (channel: string, payload: unknown) => {
      events.push({ channel, payload });
    },
  } as unknown as Absurd;
  return { app, events };
}

interface Seeded {
  store: PgStore;
  projectId: string;
  questionId: string;
}

/** Build a PGlite-backed store seeded with data for every dashboard panel. */
async function seed(): Promise<Seeded> {
  const client = new PGlite();
  const store = await PgStore.fromDrizzle(drizzle(client, { schema }), () => client.close());
  const project = await store.createProject(PROJECT);
  const change = await store.createChange({
    projectId: project.id,
    taskId: "t1",
    branch: "recurse/improve-1",
    title: "Improve scoring",
    summary: "bump score",
    status: "merged",
    baseMetrics: { score: 0.4 },
    newMetrics: { score: 0.7 },
  });
  await store.recordMetricSample({ projectId: project.id, metricKey: "score", value: 0.4 });
  await store.recordMetricSample({
    projectId: project.id,
    changeId: change.id,
    metricKey: "score",
    value: 0.7,
  });
  await store.createTask({
    projectId: project.id,
    kind: "improve",
    title: "next",
    prompt: "go",
    priority: 1,
    source: "scheduler",
  });
  await store.appendEvent({
    projectId: project.id,
    type: "change.merged",
    payload: { changeId: change.id },
  });
  const question = await store.createQuestion({ projectId: project.id, body: "Which direction?" });
  return { store, projectId: project.id, questionId: question.id };
}

/** Start the server on an ephemeral port; always closed via the test `after`. */
async function startOn(seeded: Seeded, app?: Absurd): Promise<DashboardHandle & { base: string }> {
  const handle = await startDashboard({
    store: seeded.store,
    port: 0,
    projectId: seeded.projectId,
    app,
  });
  return Object.assign(handle, { base: `http://127.0.0.1:${handle.port}` });
}

/** Fetch and JSON-parse a URL, returning a caller-asserted shape. */
async function getJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(url, init);
  return { status: res.status, body: (await res.json()) as T };
}

test("GET / serves the HTML page", async () => {
  const seeded = await seed();
  const srv = await startOn(seeded);
  after(() => Promise.all([srv.close(), seeded.store.close()]));
  const res = await fetch(`${srv.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await res.text(), /<!doctype html>/i);
});

test("GET /api/state returns the seeded snapshot shape", async () => {
  const seeded = await seed();
  const srv = await startOn(seeded);
  after(() => Promise.all([srv.close(), seeded.store.close()]));
  const { body: state } = await getJson<DashboardState>(
    `${srv.base}/api/state?projectId=${seeded.projectId}`,
  );
  assert.equal(state.project?.id, seeded.projectId);
  assert.deepEqual(state.baseline, { score: 0.7 });
  assert.equal(state.taskCounts.queued, 1);
  assert.equal(state.changes.length, 1);
  assert.equal(state.changes[0].title, "Improve scoring");
  assert.equal(state.openQuestions.length, 1);
  assert.ok(state.recentEvents.some((e) => e.type === "change.merged"));
});

test("GET /api/metrics returns the time series", async () => {
  const seeded = await seed();
  const srv = await startOn(seeded);
  after(() => Promise.all([srv.close(), seeded.store.close()]));
  const { body: series } = await getJson<{ value: number }[]>(
    `${srv.base}/api/metrics?projectId=${seeded.projectId}&key=score`,
  );
  assert.equal(series.length, 2);
  assert.deepEqual(
    series.map((s) => s.value),
    [0.4, 0.7],
  );
});

test("POST /api/pointers creates a pointer visible via state", async () => {
  const seeded = await seed();
  const srv = await startOn(seeded);
  after(() => Promise.all([srv.close(), seeded.store.close()]));
  const { status, body: pointer } = await getJson<{ body: string; fromHuman: boolean }>(
    `${srv.base}/api/pointers`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: seeded.projectId, body: "try property tests" }),
    },
  );
  assert.equal(status, 201);
  assert.equal(pointer.body, "try property tests");
  assert.equal(pointer.fromHuman, true);
  const { body: state } = await getJson<DashboardState>(
    `${srv.base}/api/state?projectId=${seeded.projectId}`,
  );
  assert.ok(state.pointers.some((p) => p.body === "try property tests"));
});

test("POST /api/pointers rejects an empty body", async () => {
  const seeded = await seed();
  const srv = await startOn(seeded);
  after(() => Promise.all([srv.close(), seeded.store.close()]));
  const res = await fetch(`${srv.base}/api/pointers`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: seeded.projectId, body: "   " }),
  });
  assert.equal(res.status, 400);
});

test("POST /api/questions/:id/answer marks it answered and wakes the agent", async () => {
  const seeded = await seed();
  const { app, events } = fakeAbsurd();
  const srv = await startOn(seeded, app);
  after(() => Promise.all([srv.close(), seeded.store.close()]));
  const { status, body: answered } = await getJson<{ status: string; answer: string }>(
    `${srv.base}/api/questions/${seeded.questionId}/answer`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: "go for coverage" }),
    },
  );
  assert.equal(status, 200);
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "go for coverage");
  assert.equal((await seeded.store.listQuestions(seeded.projectId))[0].status, "answered");
  // The Absurd wake-up event was emitted on the question's channel.
  assert.deepEqual(events, [
    { channel: `answer:${seeded.questionId}`, payload: { answer: "go for coverage" } },
  ]);
});

test("unknown route returns 404 JSON", async () => {
  const seeded = await seed();
  const srv = await startOn(seeded);
  after(() => Promise.all([srv.close(), seeded.store.close()]));
  const { status, body } = await getJson<{ error: string }>(`${srv.base}/api/nope`);
  assert.equal(status, 404);
  assert.ok(body.error);
});

test("GET /api/stream replays backlog and pushes a new event via SSE", async () => {
  const seeded = await seed();
  const srv = await startOn(seeded);
  after(() => Promise.all([srv.close(), seeded.store.close()]));

  const controller = new AbortController();
  const res = await fetch(`${srv.base}/api/stream?projectId=${seeded.projectId}`, {
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  // Read until we observe an event of the given type, or time out.
  async function waitForType(type: string): Promise<void> {
    const deadline = Date.now() + 4000;
    let buffer = "";
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(`"type":"${type}"`)) return;
    }
    throw new Error(`timed out waiting for SSE event ${type}`);
  }

  // Backlog: the seeded merge event replays on connect.
  await waitForType("change.merged");
  // Live: a freshly appended event arrives within the poll interval.
  await seeded.store.appendEvent({
    projectId: seeded.projectId,
    type: "task.started",
    payload: { taskId: "t2" },
  });
  await waitForType("task.started");

  controller.abort();
  await reader.cancel().catch(() => {});
});
