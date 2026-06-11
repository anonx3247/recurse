import { randomUUID } from "node:crypto";
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

/** In-memory {@link Store} implementation for tests and ephemeral runs. */
export class MemoryStore implements Store {
  private projects: Project[] = [];
  private tasks: Task[] = [];
  private changes: Change[] = [];
  private reviews: Review[] = [];
  private agentRuns: AgentRun[] = [];
  private pointers: Pointer[] = [];
  private questions: Question[] = [];
  private metricSamples: MetricSample[] = [];
  private events: EventLogEntry[] = [];

  private now(): string {
    return new Date().toISOString();
  }

  async createProject(input: NewProject): Promise<Project> {
    const project: Project = { ...input, id: randomUUID(), createdAt: this.now() };
    this.projects.push(project);
    return project;
  }

  async getProject(id: string): Promise<Project | undefined> {
    return this.projects.find((p) => p.id === id);
  }

  async listProjects(): Promise<Project[]> {
    return [...this.projects];
  }

  async createTask(input: NewTask): Promise<Task> {
    const task: Task = {
      ...input,
      status: input.status ?? "queued",
      id: randomUUID(),
      createdAt: this.now(),
    };
    this.tasks.push(task);
    return task;
  }

  async getTask(id: string): Promise<Task | undefined> {
    return this.tasks.find((t) => t.id === id);
  }

  async updateTaskStatus(id: string, status: TaskStatus): Promise<Task> {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`Task not found: ${id}`);
    task.status = status;
    return task;
  }

  async listTasks(projectId: string, filter?: { status?: TaskStatus }): Promise<Task[]> {
    return this.tasks.filter(
      (t) => t.projectId === projectId && (!filter?.status || t.status === filter.status),
    );
  }

  async createChange(input: NewChange): Promise<Change> {
    const change: Change = { ...input, id: randomUUID(), createdAt: this.now() };
    this.changes.push(change);
    return change;
  }

  async getChange(id: string): Promise<Change | undefined> {
    return this.changes.find((c) => c.id === id);
  }

  async updateChange(id: string, patch: Partial<NewChange>): Promise<Change> {
    const change = this.changes.find((c) => c.id === id);
    if (!change) throw new Error(`Change not found: ${id}`);
    Object.assign(change, patch);
    return change;
  }

  async listChanges(projectId: string): Promise<Change[]> {
    return this.changes.filter((c) => c.projectId === projectId);
  }

  async createReview(input: NewReview): Promise<Review> {
    const review: Review = { ...input, id: randomUUID(), createdAt: this.now() };
    this.reviews.push(review);
    return review;
  }

  async listReviews(changeId: string): Promise<Review[]> {
    return this.reviews.filter((r) => r.changeId === changeId);
  }

  async createAgentRun(input: NewAgentRun): Promise<AgentRun> {
    const run: AgentRun = { ...input, id: randomUUID(), startedAt: this.now() };
    this.agentRuns.push(run);
    return run;
  }

  async updateAgentRun(id: string, patch: Partial<NewAgentRun>): Promise<AgentRun> {
    const run = this.agentRuns.find((r) => r.id === id);
    if (!run) throw new Error(`Agent run not found: ${id}`);
    Object.assign(run, patch);
    return run;
  }

  async listAgentRuns(projectId: string): Promise<AgentRun[]> {
    return this.agentRuns.filter((r) => r.projectId === projectId);
  }

  async createPointer(input: NewPointer): Promise<Pointer> {
    const pointer: Pointer = {
      ...input,
      fromHuman: true,
      id: randomUUID(),
      createdAt: this.now(),
    };
    this.pointers.push(pointer);
    return pointer;
  }

  async listPointers(projectId: string, filter?: { consumed?: boolean }): Promise<Pointer[]> {
    return this.pointers.filter((p) => {
      if (p.projectId !== projectId) return false;
      if (filter?.consumed === true) return p.consumedAt !== undefined;
      if (filter?.consumed === false) return p.consumedAt === undefined;
      return true;
    });
  }

  async createQuestion(input: NewQuestion): Promise<Question> {
    const question: Question = {
      ...input,
      status: "open",
      id: randomUUID(),
      createdAt: this.now(),
    };
    this.questions.push(question);
    return question;
  }

  async answerQuestion(id: string, answer: string): Promise<Question> {
    const question = this.questions.find((q) => q.id === id);
    if (!question) throw new Error(`Question not found: ${id}`);
    question.answer = answer;
    question.status = "answered";
    question.answeredAt = this.now();
    return question;
  }

  async listQuestions(projectId: string): Promise<Question[]> {
    return this.questions.filter((q) => q.projectId === projectId);
  }

  async recordMetricSample(input: NewMetricSample): Promise<MetricSample> {
    const sample: MetricSample = { ...input, id: randomUUID(), recordedAt: this.now() };
    this.metricSamples.push(sample);
    return sample;
  }

  async listMetricSamples(projectId: string, metricKey: string): Promise<MetricSample[]> {
    return this.metricSamples.filter((s) => s.projectId === projectId && s.metricKey === metricKey);
  }

  async appendEvent(entry: NewEvent): Promise<EventLogEntry> {
    const event: EventLogEntry = { ...entry, id: randomUUID(), at: this.now() };
    this.events.push(event);
    return event;
  }

  async listEvents(projectId: string, filter?: { sinceId?: string }): Promise<EventLogEntry[]> {
    let events = this.events.filter((e) => e.projectId === projectId);
    if (filter?.sinceId) {
      const index = events.findIndex((e) => e.id === filter.sinceId);
      if (index >= 0) events = events.slice(index + 1);
    }
    return events;
  }

  async close(): Promise<void> {
    // no-op
  }
}
