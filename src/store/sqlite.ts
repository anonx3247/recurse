import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq, gt } from "drizzle-orm";
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
} from "../core/types";
import * as schema from "./schema";
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
} from "./store";

/** Drop keys whose value is `null` so rows match the optional-field domain types. */
function clean<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null) out[key] = value;
  }
  return out as T;
}

function cleanAll<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map((row) => clean<T>(row));
}

/** Persistent {@link Store} backed by better-sqlite3 via drizzle ORM (synchronous). */
export class SqliteStore implements Store {
  private sqlite: Database.Database;
  private db: BetterSQLite3Database<typeof schema>;

  constructor(path = ":memory:") {
    this.sqlite = new Database(path);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.exec(schema.CREATE_TABLES_SQL);
    this.db = drizzle(this.sqlite, { schema });
  }

  private now(): string {
    return new Date().toISOString();
  }

  createProject(input: NewProject): Project {
    const project: Project = { ...input, id: randomUUID(), createdAt: this.now() };
    this.db.insert(schema.projects).values(project).run();
    return project;
  }

  getProject(id: string): Project | undefined {
    const row = this.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    return row ? clean<Project>(row) : undefined;
  }

  listProjects(): Project[] {
    return cleanAll<Project>(
      this.db.select().from(schema.projects).orderBy(schema.projects.createdAt).all(),
    );
  }

  createTask(input: NewTask): Task {
    const task: Task = {
      ...input,
      status: input.status ?? "queued",
      id: randomUUID(),
      createdAt: this.now(),
    };
    this.db.insert(schema.tasks).values(task).run();
    return task;
  }

  getTask(id: string): Task | undefined {
    const row = this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
    return row ? clean<Task>(row) : undefined;
  }

  updateTaskStatus(id: string, status: TaskStatus): Task {
    this.db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, id)).run();
    const task = this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  listTasks(projectId: string, filter?: { status?: TaskStatus }): Task[] {
    const where = filter?.status
      ? and(eq(schema.tasks.projectId, projectId), eq(schema.tasks.status, filter.status))
      : eq(schema.tasks.projectId, projectId);
    return cleanAll<Task>(
      this.db.select().from(schema.tasks).where(where).orderBy(schema.tasks.createdAt).all(),
    );
  }

  createChange(input: NewChange): Change {
    const change: Change = { ...input, id: randomUUID(), createdAt: this.now() };
    this.db.insert(schema.changes).values(change).run();
    return change;
  }

  getChange(id: string): Change | undefined {
    const row = this.db.select().from(schema.changes).where(eq(schema.changes.id, id)).get();
    return row ? clean<Change>(row) : undefined;
  }

  updateChange(id: string, patch: Partial<NewChange>): Change {
    this.db.update(schema.changes).set(patch).where(eq(schema.changes.id, id)).run();
    const change = this.getChange(id);
    if (!change) throw new Error(`Change not found: ${id}`);
    return change;
  }

  listChanges(projectId: string): Change[] {
    return cleanAll<Change>(
      this.db
        .select()
        .from(schema.changes)
        .where(eq(schema.changes.projectId, projectId))
        .orderBy(schema.changes.createdAt)
        .all(),
    );
  }

  createReview(input: NewReview): Review {
    const review: Review = { ...input, id: randomUUID(), createdAt: this.now() };
    this.db.insert(schema.reviews).values(review).run();
    return review;
  }

  listReviews(changeId: string): Review[] {
    return cleanAll<Review>(
      this.db
        .select()
        .from(schema.reviews)
        .where(eq(schema.reviews.changeId, changeId))
        .orderBy(schema.reviews.createdAt)
        .all(),
    );
  }

  createAgentRun(input: NewAgentRun): AgentRun {
    const run: AgentRun = { ...input, id: randomUUID(), startedAt: this.now() };
    this.db.insert(schema.agentRuns).values(run).run();
    return run;
  }

  updateAgentRun(id: string, patch: Partial<NewAgentRun>): AgentRun {
    this.db.update(schema.agentRuns).set(patch).where(eq(schema.agentRuns.id, id)).run();
    const row = this.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)).get();
    if (!row) throw new Error(`Agent run not found: ${id}`);
    return clean<AgentRun>(row);
  }

  listAgentRuns(projectId: string): AgentRun[] {
    return cleanAll<AgentRun>(
      this.db
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.projectId, projectId))
        .orderBy(schema.agentRuns.startedAt)
        .all(),
    );
  }

  createPointer(input: NewPointer): Pointer {
    const pointer: Pointer = {
      ...input,
      fromHuman: true,
      id: randomUUID(),
      createdAt: this.now(),
    };
    this.db.insert(schema.pointers).values(pointer).run();
    return pointer;
  }

  listPointers(projectId: string, filter?: { consumed?: boolean }): Pointer[] {
    let rows = cleanAll<Pointer>(
      this.db
        .select()
        .from(schema.pointers)
        .where(eq(schema.pointers.projectId, projectId))
        .orderBy(schema.pointers.createdAt)
        .all(),
    );
    if (filter?.consumed === true) rows = rows.filter((p) => p.consumedAt !== undefined);
    if (filter?.consumed === false) rows = rows.filter((p) => p.consumedAt === undefined);
    return rows;
  }

  createQuestion(input: NewQuestion): Question {
    const question: Question = {
      ...input,
      status: "open",
      id: randomUUID(),
      createdAt: this.now(),
    };
    this.db.insert(schema.questions).values(question).run();
    return question;
  }

  answerQuestion(id: string, answer: string): Question {
    this.db
      .update(schema.questions)
      .set({ answer, status: "answered", answeredAt: this.now() })
      .where(eq(schema.questions.id, id))
      .run();
    const row = this.db.select().from(schema.questions).where(eq(schema.questions.id, id)).get();
    if (!row) throw new Error(`Question not found: ${id}`);
    return clean<Question>(row);
  }

  listQuestions(projectId: string): Question[] {
    return cleanAll<Question>(
      this.db
        .select()
        .from(schema.questions)
        .where(eq(schema.questions.projectId, projectId))
        .orderBy(schema.questions.createdAt)
        .all(),
    );
  }

  recordMetricSample(input: NewMetricSample): MetricSample {
    const sample: MetricSample = { ...input, id: randomUUID(), recordedAt: this.now() };
    this.db.insert(schema.metricSamples).values(sample).run();
    return sample;
  }

  listMetricSamples(projectId: string, metricKey: string): MetricSample[] {
    return cleanAll<MetricSample>(
      this.db
        .select()
        .from(schema.metricSamples)
        .where(
          and(
            eq(schema.metricSamples.projectId, projectId),
            eq(schema.metricSamples.metricKey, metricKey),
          ),
        )
        .orderBy(schema.metricSamples.recordedAt)
        .all(),
    );
  }

  appendEvent(entry: NewEvent): EventLogEntry {
    const event: EventLogEntry = { ...entry, id: randomUUID(), at: this.now() };
    this.db.insert(schema.events).values(event).run();
    return event;
  }

  listEvents(projectId: string, filter?: { sinceId?: string }): EventLogEntry[] {
    let minSeq = 0;
    if (filter?.sinceId) {
      const since = this.db
        .select({ seq: schema.events.seq })
        .from(schema.events)
        .where(eq(schema.events.id, filter.sinceId))
        .get();
      if (since) minSeq = since.seq;
    }
    const rows = this.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.projectId, projectId), gt(schema.events.seq, minSeq)))
      .orderBy(schema.events.seq)
      .all();
    return rows.map(({ seq: _seq, ...rest }) => clean<EventLogEntry>(rest));
  }

  close(): void {
    this.sqlite.close();
  }
}
