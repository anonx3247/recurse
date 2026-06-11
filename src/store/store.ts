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
 * are synchronous.
 */
export interface Store {
  // Projects
  createProject(input: NewProject): Project;
  getProject(id: string): Project | undefined;
  listProjects(): Project[];

  // Tasks
  createTask(input: NewTask): Task;
  getTask(id: string): Task | undefined;
  updateTaskStatus(id: string, status: TaskStatus): Task;
  listTasks(projectId: string, filter?: { status?: TaskStatus }): Task[];

  // Changes
  createChange(input: NewChange): Change;
  getChange(id: string): Change | undefined;
  updateChange(id: string, patch: Partial<NewChange>): Change;
  listChanges(projectId: string): Change[];

  // Reviews
  createReview(input: NewReview): Review;
  listReviews(changeId: string): Review[];

  // Agent runs
  createAgentRun(input: NewAgentRun): AgentRun;
  updateAgentRun(id: string, patch: Partial<NewAgentRun>): AgentRun;
  listAgentRuns(projectId: string): AgentRun[];

  // Pointers (human inbox)
  createPointer(input: NewPointer): Pointer;
  listPointers(projectId: string, filter?: { consumed?: boolean }): Pointer[];

  // Questions (kernel → human)
  createQuestion(input: NewQuestion): Question;
  answerQuestion(id: string, answer: string): Question;
  listQuestions(projectId: string): Question[];

  // Metrics
  recordMetricSample(input: NewMetricSample): MetricSample;
  listMetricSamples(projectId: string, metricKey: string): MetricSample[];

  // Event log (append-only)
  appendEvent(entry: NewEvent): EventLogEntry;
  listEvents(projectId: string, filter?: { sinceId?: string }): EventLogEntry[];

  /** Release any underlying resources (no-op for in-memory). */
  close(): void;
}
