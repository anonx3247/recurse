import { randomUUID } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
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

/**
 * Any drizzle Postgres database — a `node-postgres` pool (production) or a
 * PGlite instance (offline tests). Both satisfy this base class.
 */
export type PgDb = PgDatabase<PgQueryResultHKT, typeof schema>;

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

/** Persistent {@link Store} backed by Postgres via drizzle ORM. */
export class PgStore implements Store {
  private constructor(
    private readonly db: PgDb,
    private readonly disposer?: () => Promise<void>,
  ) {}

  /**
   * Build a store from an existing drizzle Postgres connection (e.g. PGlite in
   * tests). `disposer` is invoked by {@link close} to release the connection.
   */
  static async fromDrizzle(db: PgDb, disposer?: () => Promise<void>): Promise<PgStore> {
    const store = new PgStore(db, disposer);
    await store.init();
    return store;
  }

  /** Build a production store from a `pg` pool. Requires `DATABASE_URL`. */
  static async fromDatabaseUrl(databaseUrl = process.env.DATABASE_URL): Promise<PgStore> {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required to construct PgStore");
    }
    const pool = new Pool({ connectionString: databaseUrl });
    const db = drizzle(pool, { schema });
    return PgStore.fromDrizzle(db, () => pool.end());
  }

  /** Create tables idempotently. Statements run individually for PGlite compat. */
  private async init(): Promise<void> {
    const statements = schema.CREATE_TABLES_SQL.split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await this.db.execute(sql.raw(statement));
    }
  }

  private now(): string {
    return new Date().toISOString();
  }

  async createProject(input: NewProject): Promise<Project> {
    const project: Project = { ...input, id: randomUUID(), createdAt: this.now() };
    await this.db.insert(schema.projects).values(project);
    return project;
  }

  async getProject(id: string): Promise<Project | undefined> {
    const [row] = await this.db.select().from(schema.projects).where(eq(schema.projects.id, id));
    return row ? clean<Project>(row) : undefined;
  }

  async listProjects(): Promise<Project[]> {
    return cleanAll<Project>(
      await this.db.select().from(schema.projects).orderBy(schema.projects.createdAt),
    );
  }

  async createTask(input: NewTask): Promise<Task> {
    const task: Task = {
      ...input,
      status: input.status ?? "queued",
      id: randomUUID(),
      createdAt: this.now(),
    };
    await this.db.insert(schema.tasks).values(task);
    return task;
  }

  async getTask(id: string): Promise<Task | undefined> {
    const [row] = await this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    return row ? clean<Task>(row) : undefined;
  }

  async updateTaskStatus(id: string, status: TaskStatus): Promise<Task> {
    await this.db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, id));
    const task = await this.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  async listTasks(projectId: string, filter?: { status?: TaskStatus }): Promise<Task[]> {
    const where = filter?.status
      ? and(eq(schema.tasks.projectId, projectId), eq(schema.tasks.status, filter.status))
      : eq(schema.tasks.projectId, projectId);
    return cleanAll<Task>(
      await this.db.select().from(schema.tasks).where(where).orderBy(schema.tasks.createdAt),
    );
  }

  async createChange(input: NewChange): Promise<Change> {
    const change: Change = { ...input, id: randomUUID(), createdAt: this.now() };
    await this.db.insert(schema.changes).values(change);
    return change;
  }

  async getChange(id: string): Promise<Change | undefined> {
    const [row] = await this.db.select().from(schema.changes).where(eq(schema.changes.id, id));
    return row ? clean<Change>(row) : undefined;
  }

  async updateChange(id: string, patch: Partial<NewChange>): Promise<Change> {
    await this.db.update(schema.changes).set(patch).where(eq(schema.changes.id, id));
    const change = await this.getChange(id);
    if (!change) throw new Error(`Change not found: ${id}`);
    return change;
  }

  async listChanges(projectId: string): Promise<Change[]> {
    return cleanAll<Change>(
      await this.db
        .select()
        .from(schema.changes)
        .where(eq(schema.changes.projectId, projectId))
        .orderBy(schema.changes.createdAt),
    );
  }

  async createReview(input: NewReview): Promise<Review> {
    const review: Review = { ...input, id: randomUUID(), createdAt: this.now() };
    await this.db.insert(schema.reviews).values(review);
    return review;
  }

  async listReviews(changeId: string): Promise<Review[]> {
    return cleanAll<Review>(
      await this.db
        .select()
        .from(schema.reviews)
        .where(eq(schema.reviews.changeId, changeId))
        .orderBy(schema.reviews.createdAt),
    );
  }

  async createAgentRun(input: NewAgentRun): Promise<AgentRun> {
    const run: AgentRun = { ...input, id: randomUUID(), startedAt: this.now() };
    await this.db.insert(schema.agentRuns).values(run);
    return run;
  }

  async updateAgentRun(id: string, patch: Partial<NewAgentRun>): Promise<AgentRun> {
    await this.db.update(schema.agentRuns).set(patch).where(eq(schema.agentRuns.id, id));
    const [row] = await this.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id));
    if (!row) throw new Error(`Agent run not found: ${id}`);
    return clean<AgentRun>(row);
  }

  async listAgentRuns(projectId: string): Promise<AgentRun[]> {
    return cleanAll<AgentRun>(
      await this.db
        .select()
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.projectId, projectId))
        .orderBy(schema.agentRuns.startedAt),
    );
  }

  async createPointer(input: NewPointer): Promise<Pointer> {
    const pointer: Pointer = {
      ...input,
      fromHuman: true,
      id: randomUUID(),
      createdAt: this.now(),
    };
    await this.db.insert(schema.pointers).values(pointer);
    return pointer;
  }

  async listPointers(projectId: string, filter?: { consumed?: boolean }): Promise<Pointer[]> {
    let rows = cleanAll<Pointer>(
      await this.db
        .select()
        .from(schema.pointers)
        .where(eq(schema.pointers.projectId, projectId))
        .orderBy(schema.pointers.createdAt),
    );
    if (filter?.consumed === true) rows = rows.filter((p) => p.consumedAt !== undefined);
    if (filter?.consumed === false) rows = rows.filter((p) => p.consumedAt === undefined);
    return rows;
  }

  async createQuestion(input: NewQuestion): Promise<Question> {
    const question: Question = {
      ...input,
      status: "open",
      id: randomUUID(),
      createdAt: this.now(),
    };
    await this.db.insert(schema.questions).values(question);
    return question;
  }

  async answerQuestion(id: string, answer: string): Promise<Question> {
    await this.db
      .update(schema.questions)
      .set({ answer, status: "answered", answeredAt: this.now() })
      .where(eq(schema.questions.id, id));
    const [row] = await this.db.select().from(schema.questions).where(eq(schema.questions.id, id));
    if (!row) throw new Error(`Question not found: ${id}`);
    return clean<Question>(row);
  }

  async listQuestions(projectId: string): Promise<Question[]> {
    return cleanAll<Question>(
      await this.db
        .select()
        .from(schema.questions)
        .where(eq(schema.questions.projectId, projectId))
        .orderBy(schema.questions.createdAt),
    );
  }

  async recordMetricSample(input: NewMetricSample): Promise<MetricSample> {
    const sample: MetricSample = { ...input, id: randomUUID(), recordedAt: this.now() };
    await this.db.insert(schema.metricSamples).values(sample);
    return sample;
  }

  async listMetricSamples(projectId: string, metricKey: string): Promise<MetricSample[]> {
    return cleanAll<MetricSample>(
      await this.db
        .select()
        .from(schema.metricSamples)
        .where(
          and(
            eq(schema.metricSamples.projectId, projectId),
            eq(schema.metricSamples.metricKey, metricKey),
          ),
        )
        .orderBy(schema.metricSamples.recordedAt),
    );
  }

  async appendEvent(entry: NewEvent): Promise<EventLogEntry> {
    const event: EventLogEntry = { ...entry, id: randomUUID(), at: this.now() };
    await this.db.insert(schema.events).values(event);
    return event;
  }

  async listEvents(projectId: string, filter?: { sinceId?: string }): Promise<EventLogEntry[]> {
    let minSeq = 0;
    if (filter?.sinceId) {
      const [since] = await this.db
        .select({ seq: schema.events.seq })
        .from(schema.events)
        .where(eq(schema.events.id, filter.sinceId));
      if (since) minSeq = since.seq;
    }
    const rows = await this.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.projectId, projectId), gt(schema.events.seq, minSeq)))
      .orderBy(schema.events.seq);
    return rows.map(({ seq: _seq, ...rest }) => clean<EventLogEntry>(rest));
  }

  async close(): Promise<void> {
    await this.disposer?.();
  }
}
