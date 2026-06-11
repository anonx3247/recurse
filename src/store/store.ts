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

/** Inputs are entities without store-managed fields (id, timestamps). */
export type NewProject = Omit<Project, "id" | "createdAt">;
export type NewTask = Omit<Task, "id" | "createdAt" | "status"> & {
  status?: TaskStatus;
};
export type NewChange = Omit<Change, "id" | "createdAt">;
export type NewReview = Omit<Review, "id" | "createdAt">;
export type NewAgentRun = Omit<AgentRun, "id" | "startedAt">;
export type NewPointer = Omit<Pointer, "id" | "createdAt" | "fromHuman">;
export type NewQuestion = Omit<Question, "id" | "createdAt" | "status">;
export type NewMetricSample = Omit<MetricSample, "id" | "recordedAt">;
export type NewEvent = Omit<EventLogEntry, "id" | "at">;

/**
 * Pragmatic CRUD + query surface over recurse's domain entities and event log.
 * Implemented by both {@link SqliteStore} and {@link MemoryStore}; all methods
 * are asynchronous (the Postgres-backed implementation talks to the database).
 */
export interface Store {
  // Projects
  createProject(input: NewProject): Promise<Project>;
  getProject(id: string): Promise<Project | undefined>;
  listProjects(): Promise<Project[]>;

  // Tasks
  createTask(input: NewTask): Promise<Task>;
  getTask(id: string): Promise<Task | undefined>;
  updateTaskStatus(id: string, status: TaskStatus): Promise<Task>;
  listTasks(projectId: string, filter?: { status?: TaskStatus }): Promise<Task[]>;

  // Changes
  createChange(input: NewChange): Promise<Change>;
  getChange(id: string): Promise<Change | undefined>;
  updateChange(id: string, patch: Partial<NewChange>): Promise<Change>;
  listChanges(projectId: string): Promise<Change[]>;

  // Reviews
  createReview(input: NewReview): Promise<Review>;
  listReviews(changeId: string): Promise<Review[]>;

  // Agent runs
  createAgentRun(input: NewAgentRun): Promise<AgentRun>;
  updateAgentRun(id: string, patch: Partial<NewAgentRun>): Promise<AgentRun>;
  listAgentRuns(projectId: string): Promise<AgentRun[]>;

  // Pointers (human inbox)
  createPointer(input: NewPointer): Promise<Pointer>;
  listPointers(projectId: string, filter?: { consumed?: boolean }): Promise<Pointer[]>;

  // Questions (kernel → human)
  createQuestion(input: NewQuestion): Promise<Question>;
  answerQuestion(id: string, answer: string): Promise<Question>;
  listQuestions(projectId: string): Promise<Question[]>;

  // Metrics
  recordMetricSample(input: NewMetricSample): Promise<MetricSample>;
  listMetricSamples(projectId: string, metricKey: string): Promise<MetricSample[]>;

  // Event log (append-only)
  appendEvent(entry: NewEvent): Promise<EventLogEntry>;
  listEvents(projectId: string, filter?: { sinceId?: string }): Promise<EventLogEntry[]>;

  /** Release any underlying resources (no-op for in-memory). */
  close(): Promise<void>;
}
