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

  createProject(input: NewProject): Project {
    const project: Project = { ...input, id: randomUUID(), createdAt: this.now() };
    this.projects.push(project);
    return project;
  }

  getProject(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  listProjects(): Project[] {
    return [...this.projects];
  }

  createTask(input: NewTask): Task {
    const task: Task = {
      ...input,
      status: input.status ?? "queued",
      id: randomUUID(),
      createdAt: this.now(),
    };
    this.tasks.push(task);
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  updateTaskStatus(id: string, status: TaskStatus): Task {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`Task not found: ${id}`);
    task.status = status;
    return task;
  }

  listTasks(projectId: string, filter?: { status?: TaskStatus }): Task[] {
    return this.tasks.filter(
      (t) => t.projectId === projectId && (!filter?.status || t.status === filter.status),
    );
  }

  createChange(input: NewChange): Change {
    const change: Change = { ...input, id: randomUUID(), createdAt: this.now() };
    this.changes.push(change);
    return change;
  }

  getChange(id: string): Change | undefined {
    return this.changes.find((c) => c.id === id);
  }

  updateChange(id: string, patch: Partial<NewChange>): Change {
    const change = this.changes.find((c) => c.id === id);
    if (!change) throw new Error(`Change not found: ${id}`);
    Object.assign(change, patch);
    return change;
  }

  listChanges(projectId: string): Change[] {
    return this.changes.filter((c) => c.projectId === projectId);
  }

  createReview(input: NewReview): Review {
    const review: Review = { ...input, id: randomUUID(), createdAt: this.now() };
    this.reviews.push(review);
    return review;
  }

  listReviews(changeId: string): Review[] {
    return this.reviews.filter((r) => r.changeId === changeId);
  }

  createAgentRun(input: NewAgentRun): AgentRun {
    const run: AgentRun = { ...input, id: randomUUID(), startedAt: this.now() };
    this.agentRuns.push(run);
    return run;
  }

  updateAgentRun(id: string, patch: Partial<NewAgentRun>): AgentRun {
    const run = this.agentRuns.find((r) => r.id === id);
    if (!run) throw new Error(`Agent run not found: ${id}`);
    Object.assign(run, patch);
    return run;
  }

  listAgentRuns(projectId: string): AgentRun[] {
    return this.agentRuns.filter((r) => r.projectId === projectId);
  }

  createPointer(input: NewPointer): Pointer {
    const pointer: Pointer = {
      ...input,
      fromHuman: true,
      id: randomUUID(),
      createdAt: this.now(),
    };
    this.pointers.push(pointer);
    return pointer;
  }

  listPointers(projectId: string, filter?: { consumed?: boolean }): Pointer[] {
    return this.pointers.filter((p) => {
      if (p.projectId !== projectId) return false;
      if (filter?.consumed === true) return p.consumedAt !== undefined;
      if (filter?.consumed === false) return p.consumedAt === undefined;
      return true;
    });
  }

  createQuestion(input: NewQuestion): Question {
    const question: Question = {
      ...input,
      status: "open",
      id: randomUUID(),
      createdAt: this.now(),
    };
    this.questions.push(question);
    return question;
  }

  answerQuestion(id: string, answer: string): Question {
    const question = this.questions.find((q) => q.id === id);
    if (!question) throw new Error(`Question not found: ${id}`);
    question.answer = answer;
    question.status = "answered";
    question.answeredAt = this.now();
    return question;
  }

  listQuestions(projectId: string): Question[] {
    return this.questions.filter((q) => q.projectId === projectId);
  }

  recordMetricSample(input: NewMetricSample): MetricSample {
    const sample: MetricSample = { ...input, id: randomUUID(), recordedAt: this.now() };
    this.metricSamples.push(sample);
    return sample;
  }

  listMetricSamples(projectId: string, metricKey: string): MetricSample[] {
    return this.metricSamples.filter((s) => s.projectId === projectId && s.metricKey === metricKey);
  }

  appendEvent(entry: NewEvent): EventLogEntry {
    const event: EventLogEntry = { ...entry, id: randomUUID(), at: this.now() };
    this.events.push(event);
    return event;
  }

  listEvents(projectId: string, filter?: { sinceId?: string }): EventLogEntry[] {
    let events = this.events.filter((e) => e.projectId === projectId);
    if (filter?.sinceId) {
      const index = events.findIndex((e) => e.id === filter.sinceId);
      if (index >= 0) events = events.slice(index + 1);
    }
    return events;
  }

  close(): void {
    // no-op
  }
}
