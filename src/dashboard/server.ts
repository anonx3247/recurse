/**
 * Minimal web dashboard server — zero frameworks, only `node:http`.
 *
 * The dashboard is a thin, READ-mostly view over the same async {@link Store}
 * the kernel writes to. It never drives the kernel directly: its two write
 * endpoints append a {@link Pointer} or answer a {@link Question}, which the
 * running kernel observes on its next cycle. Answering a question additionally
 * goes through the kernel's {@link answerQuestion} helper so the Absurd event is
 * emitted and the suspended agent task actually resumes. Live updates use
 * Server-Sent Events backed by polling the append-only event log (no pub/sub).
 */

import { readFile } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Absurd } from "absurd-sdk";
import type { Change, EventLogEntry, Project } from "../core/types";
import { answerQuestion as resumeQuestion } from "../kernel/human";
import type { Store } from "../store/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(HERE, "index.html");

/** How often the SSE loop polls the event log for new entries. */
const STREAM_POLL_MS = 1000;
/** How often SSE sends a keep-alive comment so proxies don't drop the socket. */
const STREAM_PING_MS = 15000;
/** How many trailing events to replay on a fresh `/api/events` or SSE connect. */
const RECENT_EVENTS = 100;

export interface DashboardOptions {
  store: Store;
  port?: number;
  host?: string;
  /** Default project for endpoints called without an explicit `projectId`. */
  projectId?: string;
  /**
   * Absurd client sharing the kernel's pool + queue. When present, answering a
   * question emits the wake-up event so the suspended agent task resumes; when
   * absent (e.g. a unit test), the answer is only persisted to the store.
   */
  app?: Absurd;
}

export interface DashboardHandle {
  close(): Promise<void>;
  port: number;
}

/** Start the dashboard HTTP server, resolving once it is listening. */
export async function startDashboard(options: DashboardOptions): Promise<DashboardHandle> {
  const { store, port = 7777, host = "127.0.0.1", projectId: defaultProjectId, app } = options;
  const server = createServer((req, res) => {
    handle(req, res, store, defaultProjectId, app).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;

  return {
    port: boundPort,
    close: () => closeServer(server),
  };
}

/** Route one request. All API responses are JSON unless noted. */
async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  defaultProjectId?: string,
  app?: Absurd,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";
  const projectId = url.searchParams.get("projectId") ?? defaultProjectId;

  if (method === "GET" && path === "/") return serveIndex(res);
  if (method === "GET" && path === "/api/projects") {
    return sendJson(res, 200, await store.listProjects());
  }
  if (method === "GET" && path === "/api/state") {
    return withProject(res, store, projectId, async (id) =>
      sendJson(res, 200, await buildState(store, id)),
    );
  }
  if (method === "GET" && path === "/api/metrics") {
    const key = url.searchParams.get("key");
    if (!key) return sendJson(res, 400, { error: "missing ?key=" });
    return withProject(res, store, projectId, async (id) =>
      sendJson(res, 200, await store.listMetricSamples(id, key)),
    );
  }
  if (method === "GET" && path === "/api/events") {
    const sinceId = url.searchParams.get("sinceId") ?? undefined;
    return withProject(res, store, projectId, async (id) =>
      sendJson(res, 200, await recentEvents(store, id, sinceId)),
    );
  }
  if (method === "GET" && path === "/api/stream") {
    return withProject(res, store, projectId, async (id) => streamEvents(req, res, store, id));
  }
  if (method === "POST" && path === "/api/pointers") {
    return createPointer(req, res, store, defaultProjectId);
  }
  const answer = method === "POST" && matchAnswer(path);
  if (answer) return answerQuestion(req, res, store, answer, app);

  return sendJson(res, 404, { error: `not found: ${method} ${path}` });
}

// ── snapshot ────────────────────────────────────────────────────────────────

export interface DashboardState {
  project: Project | undefined;
  baseline: Record<string, number>;
  taskCounts: { queued: number; running: number; done: number; failed: number };
  inFlightRuns: Awaited<ReturnType<Store["listAgentRuns"]>>;
  changes: Change[];
  openQuestions: Awaited<ReturnType<Store["listQuestions"]>>;
  pointers: Awaited<ReturnType<Store["listPointers"]>>;
  recentEvents: EventLogEntry[];
}

/** Assemble the dashboard snapshot from the store (no business logic). */
export async function buildState(store: Store, projectId: string): Promise<DashboardState> {
  const [project, tasks, changes, runs, questions, pointers, events] = await Promise.all([
    store.getProject(projectId),
    store.listTasks(projectId),
    store.listChanges(projectId),
    store.listAgentRuns(projectId),
    store.listQuestions(projectId),
    store.listPointers(projectId),
    recentEvents(store, projectId),
  ]);
  return {
    project,
    baseline: latestBaseline(changes),
    taskCounts: {
      queued: tasks.filter((t) => t.status === "queued").length,
      running: tasks.filter((t) => t.status === "running").length,
      done: tasks.filter((t) => t.status === "done").length,
      failed: tasks.filter((t) => t.status === "failed").length,
    },
    inFlightRuns: runs.filter((r) => r.status === "running"),
    changes: changes.slice(-20).reverse(),
    openQuestions: questions.filter((q) => q.status === "open"),
    pointers: pointers.slice(-20).reverse(),
    recentEvents: events,
  };
}

/** The metrics of the most recently merged change are the current baseline. */
function latestBaseline(changes: Change[]): Record<string, number> {
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    if (change.status === "merged" && change.newMetrics) return change.newMetrics;
  }
  return {};
}

/** Last {@link RECENT_EVENTS} events, optionally only those after `sinceId`. */
async function recentEvents(
  store: Store,
  projectId: string,
  sinceId?: string,
): Promise<EventLogEntry[]> {
  const events = await store.listEvents(projectId, sinceId ? { sinceId } : undefined);
  return sinceId ? events : events.slice(-RECENT_EVENTS);
}

// ── SSE stream ───────────────────────────────────────────────────────────────

/** Stream events via SSE: replay a backlog, then poll the log for new ids. */
function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  projectId: string,
): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  let lastId: string | undefined;
  const send = (event: EventLogEntry) => {
    res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    lastId = event.id;
  };
  const flush = async () => {
    for (const event of await store.listEvents(
      projectId,
      lastId ? { sinceId: lastId } : undefined,
    )) {
      send(event);
    }
  };

  // Replay only the recent backlog so a fresh client isn't flooded with history.
  recentEvents(store, projectId)
    .then((backlog) => {
      for (const event of backlog) send(event);
    })
    .catch(() => {});

  const poll = setInterval(() => void flush(), STREAM_POLL_MS);
  const ping = setInterval(() => res.write(": ping\n\n"), STREAM_PING_MS);
  const cleanup = () => {
    clearInterval(poll);
    clearInterval(ping);
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

// ── write endpoints ──────────────────────────────────────────────────────────

/** `POST /api/pointers` — drop a non-blocking human pointer into the inbox. */
async function createPointer(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  defaultProjectId?: string,
): Promise<void> {
  const body = await readJson(req);
  const projectId = typeof body.projectId === "string" ? body.projectId : defaultProjectId;
  if (!projectId || !(await store.getProject(projectId))) {
    return sendJson(res, 400, { error: "unknown or missing projectId" });
  }
  if (typeof body.body !== "string" || body.body.trim() === "") {
    return sendJson(res, 400, { error: "body must be a non-empty string" });
  }
  return sendJson(res, 201, await store.createPointer({ projectId, body: body.body.trim() }));
}

/**
 * `POST /api/questions/:id/answer` — record the answer AND wake the suspended
 * agent. When an Absurd client is wired, this goes through the kernel's
 * {@link resumeQuestion} (store write + `emitEvent`); otherwise it only writes.
 */
async function answerQuestion(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  questionId: string,
  app?: Absurd,
): Promise<void> {
  const body = await readJson(req);
  if (typeof body.answer !== "string" || body.answer.trim() === "") {
    return sendJson(res, 400, { error: "answer must be a non-empty string" });
  }
  const answer = body.answer.trim();
  try {
    if (app) await resumeQuestion(app, store, questionId, answer);
    else await store.answerQuestion(questionId, answer);
    return sendJson(res, 200, await currentQuestion(store, questionId));
  } catch {
    return sendJson(res, 404, { error: `question not found: ${questionId}` });
  }
}

/** Re-read a question by id (the store has no get-by-id), or throw if absent. */
async function currentQuestion(store: Store, questionId: string) {
  const projects = await store.listProjects();
  for (const project of projects) {
    const found = (await store.listQuestions(project.id)).find((q) => q.id === questionId);
    if (found) return found;
  }
  throw new Error(`question not found: ${questionId}`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Match `/api/questions/:id/answer`, returning the id or undefined. */
function matchAnswer(path: string): string | undefined {
  const match = /^\/api\/questions\/([^/]+)\/answer$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
}

/** Run `fn` with a validated project id, or reply 400/404. */
async function withProject(
  res: ServerResponse,
  store: Store,
  projectId: string | undefined | null,
  fn: (id: string) => Promise<void>,
): Promise<void> {
  if (!projectId) {
    sendJson(res, 400, { error: "missing projectId" });
    return;
  }
  if (!(await store.getProject(projectId))) {
    sendJson(res, 404, { error: `project not found: ${projectId}` });
    return;
  }
  await fn(projectId);
}

async function serveIndex(res: ServerResponse): Promise<void> {
  const html = await readFile(INDEX_HTML, "utf8");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

/** Read and JSON-parse a request body, throwing a clear error on bad input. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    throw new Error("invalid JSON body");
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
