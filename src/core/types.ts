/**
 * Core domain types for recurse.
 *
 * Conventions:
 * - ids are opaque strings (UUIDs).
 * - timestamps are ISO-8601 strings (e.g. `new Date().toISOString()`).
 * - statuses and other closed sets are string-literal unions.
 */

/** Direction in which a metric is considered "better". */
export type MetricDirection = "maximize" | "minimize";

/** Declares a single measurable metric a project's eval emits. */
export interface MetricSpec {
  key: string;
  label: string;
  direction: MetricDirection;
  unit?: string;
}

/** A git-repo-backed project recurse improves against an objective. */
export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  objective: string;
  evalCommand: string;
  metrics: MetricSpec[];
  concurrency: number;
  createdAt: string;
}

/** A single recorded value for one metric, optionally tied to a change. */
export interface MetricSample {
  id: string;
  projectId: string;
  changeId?: string;
  metricKey: string;
  value: number;
  recordedAt: string;
}

export type TaskKind = "improve" | "idea" | "review" | "distill";
export type TaskStatus = "queued" | "running" | "done" | "failed";
export type TaskSource = "ideator" | "human" | "scheduler" | "review";

/** A unit of work in the kernel queue. */
export interface Task {
  id: string;
  projectId: string;
  kind: TaskKind;
  title: string;
  prompt: string;
  status: TaskStatus;
  priority: number;
  source: TaskSource;
  createdAt: string;
  parentChangeId?: string;
}

export type ChangeStatus = "draft" | "in_review" | "approved" | "rejected" | "merged" | "abandoned";

/** A proposed improvement on a branch, with before/after metrics. */
export interface Change {
  id: string;
  projectId: string;
  taskId: string;
  branch: string;
  title: string;
  summary: string;
  status: ChangeStatus;
  baseMetrics?: Record<string, number>;
  newMetrics?: Record<string, number>;
  createdAt: string;
}

export type ReviewVerdict = "approve" | "request_changes" | "comment";
export type ReviewSeverity = "info" | "nit" | "major" | "blocker";

/** A single structured comment within a review. */
export interface ReviewComment {
  path?: string;
  line?: number;
  body: string;
  severity: ReviewSeverity;
}

/** A structured review of a change, like a PR review. */
export interface Review {
  id: string;
  changeId: string;
  reviewerRunId: string;
  verdict: ReviewVerdict;
  summary: string;
  comments: ReviewComment[];
  createdAt: string;
}

export type AgentRole = "worker" | "reviewer" | "ideator" | "distiller";
export type AgentRunStatus = "running" | "succeeded" | "failed";

/** A single sandboxed `pi` agent execution. */
export interface AgentRun {
  id: string;
  projectId: string;
  taskId?: string;
  changeId?: string;
  role: AgentRole;
  status: AgentRunStatus;
  sandboxId?: string;
  startedAt: string;
  endedAt?: string;
  logPath?: string;
}

/** A human-supplied direction/hint dropped into the pointers inbox. */
export interface Pointer {
  id: string;
  projectId: string;
  body: string;
  fromHuman: true;
  createdAt: string;
  consumedAt?: string;
}

export type QuestionStatus = "open" | "answered" | "dismissed";

/** A question the kernel asks a human; answered non-blockingly. */
export interface Question {
  id: string;
  projectId: string;
  body: string;
  status: QuestionStatus;
  answer?: string;
  createdAt: string;
  answeredAt?: string;
}

/** An append-only event powering the dashboard and audit log. */
export interface EventLogEntry {
  id: string;
  projectId?: string;
  type: string;
  payload: unknown;
  at: string;
}
