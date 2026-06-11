import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  AgentRun,
  Change,
  EventLogEntry,
  MetricSample,
  Pointer,
  Project,
  Question,
  Review,
  Task,
  TaskStatus,
} from "../core/types.js";
import type {
  NewAgentRun,
  NewChange,
  NewEvent,
  NewMetricSample,
  NewPointer,
  NewProject,
  NewQuestion,
  NewReview,
  NewTask,
  Store,
} from "./store.js";

/** Columns stored as JSON-encoded TEXT, by table. */
const JSON_COLUMNS: Record<string, string[]> = {
  projects: ["metrics"],
  changes: ["baseMetrics", "newMetrics"],
  reviews: ["comments"],
  events: ["payload"],
};

type Row = Record<string, unknown>;

/** Persistent {@link Store} backed by better-sqlite3 (synchronous). */
export class SqliteStore implements Store {
  private db: Database.Database;

  constructor(path = ":memory:") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT, repoUrl TEXT, defaultBranch TEXT,
        objective TEXT, evalCommand TEXT, metrics TEXT, concurrency INTEGER,
        createdAt TEXT
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, projectId TEXT, kind TEXT, title TEXT, prompt TEXT,
        status TEXT, priority INTEGER, source TEXT, createdAt TEXT,
        parentChangeId TEXT
      );
      CREATE TABLE IF NOT EXISTS changes (
        id TEXT PRIMARY KEY, projectId TEXT, taskId TEXT, branch TEXT,
        title TEXT, summary TEXT, status TEXT, baseMetrics TEXT, newMetrics TEXT,
        createdAt TEXT
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, changeId TEXT, reviewerRunId TEXT, verdict TEXT,
        summary TEXT, comments TEXT, createdAt TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY, projectId TEXT, taskId TEXT, changeId TEXT,
        role TEXT, status TEXT, sandboxId TEXT, startedAt TEXT, endedAt TEXT,
        logPath TEXT
      );
      CREATE TABLE IF NOT EXISTS pointers (
        id TEXT PRIMARY KEY, projectId TEXT, body TEXT, fromHuman INTEGER,
        createdAt TEXT, consumedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY, projectId TEXT, body TEXT, status TEXT,
        answer TEXT, createdAt TEXT, answeredAt TEXT
      );
      CREATE TABLE IF NOT EXISTS metric_samples (
        id TEXT PRIMARY KEY, projectId TEXT, changeId TEXT, metricKey TEXT,
        value REAL, recordedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, projectId TEXT,
        type TEXT, payload TEXT, at TEXT
      );
    `);
  }

  private now(): string {
    return new Date().toISOString();
  }

  /** Encode an entity to a DB row: JSON-stringify json columns, drop undefined. */
  private encode(table: string, entity: Row): Row {
    const jsonCols = JSON_COLUMNS[table] ?? [];
    const row: Row = {};
    for (const [key, value] of Object.entries(entity)) {
      if (value === undefined) {
        row[key] = null;
      } else if (jsonCols.includes(key)) {
        row[key] = JSON.stringify(value);
      } else if (typeof value === "boolean") {
        row[key] = value ? 1 : 0;
      } else {
        row[key] = value;
      }
    }
    return row;
  }

  /** Decode a DB row to an entity: JSON-parse json columns, drop nulls. */
  private decode<T>(table: string, row: Row | undefined): T | undefined {
    if (!row) return undefined;
    const jsonCols = JSON_COLUMNS[table] ?? [];
    const entity: Row = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === "seq") continue;
      if (value === null) continue;
      entity[key] = jsonCols.includes(key) ? JSON.parse(value as string) : value;
    }
    return entity as T;
  }

  private insert(table: string, entity: Row): void {
    const row = this.encode(table, entity);
    const keys = Object.keys(row);
    const placeholders = keys.map((k) => `@${k}`).join(", ");
    this.db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`).run(row);
  }

  /** UPDATE every column of `entity` (keyed by `id`) in `table`. */
  private update(table: string, entity: Row): void {
    const row = this.encode(table, entity);
    const assignments = Object.keys(row)
      .filter((k) => k !== "id")
      .map((k) => `${k} = @${k}`)
      .join(", ");
    this.db.prepare(`UPDATE ${table} SET ${assignments} WHERE id = @id`).run(row);
  }

  createProject(input: NewProject): Project {
    const project: Project = { ...input, id: randomUUID(), createdAt: this.now() };
    this.insert("projects", project as unknown as Row);
    return project;
  }

  getProject(id: string): Project | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row;
    return this.decode<Project>("projects", row);
  }

  listProjects(): Project[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY createdAt").all() as Row[];
    return rows.map((r) => this.decode<Project>("projects", r) as Project);
  }

  createTask(input: NewTask): Task {
    const task: Task = {
      ...input,
      status: input.status ?? "queued",
      id: randomUUID(),
      createdAt: this.now(),
    };
    this.insert("tasks", task as unknown as Row);
    return task;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row;
    return this.decode<Task>("tasks", row);
  }

  updateTaskStatus(id: string, status: TaskStatus): Task {
    this.db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  listTasks(projectId: string, filter?: { status?: TaskStatus }): Task[] {
    const rows = filter?.status
      ? (this.db
          .prepare("SELECT * FROM tasks WHERE projectId = ? AND status = ? ORDER BY createdAt")
          .all(projectId, filter.status) as Row[])
      : (this.db
          .prepare("SELECT * FROM tasks WHERE projectId = ? ORDER BY createdAt")
          .all(projectId) as Row[]);
    return rows.map((r) => this.decode<Task>("tasks", r) as Task);
  }

  createChange(input: NewChange): Change {
    const change: Change = { ...input, id: randomUUID(), createdAt: this.now() };
    this.insert("changes", change as unknown as Row);
    return change;
  }

  getChange(id: string): Change | undefined {
    const row = this.db.prepare("SELECT * FROM changes WHERE id = ?").get(id) as Row;
    return this.decode<Change>("changes", row);
  }

  updateChange(id: string, patch: Partial<NewChange>): Change {
    const existing = this.getChange(id);
    if (!existing) throw new Error(`Change not found: ${id}`);
    const updated = { ...existing, ...patch };
    this.update("changes", updated as unknown as Row);
    return updated;
  }

  listChanges(projectId: string): Change[] {
    const rows = this.db
      .prepare("SELECT * FROM changes WHERE projectId = ? ORDER BY createdAt")
      .all(projectId) as Row[];
    return rows.map((r) => this.decode<Change>("changes", r) as Change);
  }

  createReview(input: NewReview): Review {
    const review: Review = { ...input, id: randomUUID(), createdAt: this.now() };
    this.insert("reviews", review as unknown as Row);
    return review;
  }

  listReviews(changeId: string): Review[] {
    const rows = this.db
      .prepare("SELECT * FROM reviews WHERE changeId = ? ORDER BY createdAt")
      .all(changeId) as Row[];
    return rows.map((r) => this.decode<Review>("reviews", r) as Review);
  }

  createAgentRun(input: NewAgentRun): AgentRun {
    const run: AgentRun = { ...input, id: randomUUID(), startedAt: this.now() };
    this.insert("agent_runs", run as unknown as Row);
    return run;
  }

  updateAgentRun(id: string, patch: Partial<NewAgentRun>): AgentRun {
    const existing = this.db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as Row;
    const decoded = this.decode<AgentRun>("agent_runs", existing);
    if (!decoded) throw new Error(`Agent run not found: ${id}`);
    const updated = { ...decoded, ...patch };
    this.update("agent_runs", updated as unknown as Row);
    return updated;
  }

  listAgentRuns(projectId: string): AgentRun[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_runs WHERE projectId = ? ORDER BY startedAt")
      .all(projectId) as Row[];
    return rows.map((r) => this.decode<AgentRun>("agent_runs", r) as AgentRun);
  }

  createPointer(input: NewPointer): Pointer {
    const pointer: Pointer = {
      ...input,
      fromHuman: true,
      id: randomUUID(),
      createdAt: this.now(),
    };
    this.insert("pointers", pointer as unknown as Row);
    return pointer;
  }

  listPointers(projectId: string, filter?: { consumed?: boolean }): Pointer[] {
    let rows = this.db
      .prepare("SELECT * FROM pointers WHERE projectId = ? ORDER BY createdAt")
      .all(projectId) as Row[];
    if (filter?.consumed === true) rows = rows.filter((r) => r.consumedAt !== null);
    if (filter?.consumed === false) rows = rows.filter((r) => r.consumedAt === null);
    return rows.map((r) => this.decode<Pointer>("pointers", r) as Pointer);
  }

  createQuestion(input: NewQuestion): Question {
    const question: Question = {
      ...input,
      status: "open",
      id: randomUUID(),
      createdAt: this.now(),
    };
    this.insert("questions", question as unknown as Row);
    return question;
  }

  answerQuestion(id: string, answer: string): Question {
    this.db
      .prepare("UPDATE questions SET answer = ?, status = 'answered', answeredAt = ? WHERE id = ?")
      .run(answer, this.now(), id);
    const row = this.db.prepare("SELECT * FROM questions WHERE id = ?").get(id) as Row;
    const question = this.decode<Question>("questions", row);
    if (!question) throw new Error(`Question not found: ${id}`);
    return question;
  }

  listQuestions(projectId: string): Question[] {
    const rows = this.db
      .prepare("SELECT * FROM questions WHERE projectId = ? ORDER BY createdAt")
      .all(projectId) as Row[];
    return rows.map((r) => this.decode<Question>("questions", r) as Question);
  }

  recordMetricSample(input: NewMetricSample): MetricSample {
    const sample: MetricSample = { ...input, id: randomUUID(), recordedAt: this.now() };
    this.insert("metric_samples", sample as unknown as Row);
    return sample;
  }

  listMetricSamples(projectId: string, metricKey: string): MetricSample[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM metric_samples WHERE projectId = ? AND metricKey = ? ORDER BY recordedAt",
      )
      .all(projectId, metricKey) as Row[];
    return rows.map((r) => this.decode<MetricSample>("metric_samples", r) as MetricSample);
  }

  appendEvent(entry: NewEvent): EventLogEntry {
    const event: EventLogEntry = { ...entry, id: randomUUID(), at: this.now() };
    this.insert("events", event as unknown as Row);
    return event;
  }

  listEvents(projectId: string, filter?: { sinceId?: string }): EventLogEntry[] {
    let minSeq = 0;
    if (filter?.sinceId) {
      const sinceRow = this.db.prepare("SELECT seq FROM events WHERE id = ?").get(filter.sinceId) as
        | { seq: number }
        | undefined;
      if (sinceRow) minSeq = sinceRow.seq;
    }
    const rows = this.db
      .prepare("SELECT * FROM events WHERE projectId = ? AND seq > ? ORDER BY seq")
      .all(projectId, minSeq) as Row[];
    return rows.map((r) => this.decode<EventLogEntry>("events", r) as EventLogEntry);
  }

  close(): void {
    this.db.close();
  }
}
