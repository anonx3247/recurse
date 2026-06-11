import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
} from "drizzle-orm/pg-core";
import type {
  AgentRole,
  AgentRunStatus,
  ChangeStatus,
  MetricSpec,
  QuestionStatus,
  ReviewComment,
  ReviewVerdict,
  TaskKind,
  TaskSource,
  TaskStatus,
} from "../core/types";

/**
 * Drizzle ORM schema for the Postgres-backed state store. JSON-valued columns
 * use `jsonb` so drizzle serializes/parses them automatically. Timestamps are
 * stored as ISO-8601 `text` to match the string timestamps in the domain types.
 */

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  objective: text("objective").notNull(),
  evalCommand: text("eval_command").notNull(),
  metrics: jsonb("metrics").$type<MetricSpec[]>().notNull(),
  concurrency: integer("concurrency").notNull(),
  createdAt: text("created_at").notNull(),
});

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  kind: text("kind").$type<TaskKind>().notNull(),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  status: text("status").$type<TaskStatus>().notNull(),
  priority: integer("priority").notNull(),
  source: text("source").$type<TaskSource>().notNull(),
  createdAt: text("created_at").notNull(),
  parentChangeId: text("parent_change_id"),
});

export const changes = pgTable("changes", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  taskId: text("task_id").notNull(),
  branch: text("branch").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  status: text("status").$type<ChangeStatus>().notNull(),
  baseMetrics: jsonb("base_metrics").$type<Record<string, number>>(),
  newMetrics: jsonb("new_metrics").$type<Record<string, number>>(),
  createdAt: text("created_at").notNull(),
});

export const reviews = pgTable("reviews", {
  id: text("id").primaryKey(),
  changeId: text("change_id").notNull(),
  reviewerRunId: text("reviewer_run_id").notNull(),
  verdict: text("verdict").$type<ReviewVerdict>().notNull(),
  summary: text("summary").notNull(),
  comments: jsonb("comments").$type<ReviewComment[]>().notNull(),
  createdAt: text("created_at").notNull(),
});

export const agentRuns = pgTable("agent_runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  taskId: text("task_id"),
  changeId: text("change_id"),
  role: text("role").$type<AgentRole>().notNull(),
  status: text("status").$type<AgentRunStatus>().notNull(),
  sandboxId: text("sandbox_id"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
  logPath: text("log_path"),
});

export const pointers = pgTable("pointers", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  body: text("body").notNull(),
  fromHuman: boolean("from_human").notNull(),
  createdAt: text("created_at").notNull(),
  consumedAt: text("consumed_at"),
});

export const questions = pgTable("questions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  body: text("body").notNull(),
  status: text("status").$type<QuestionStatus>().notNull(),
  answer: text("answer"),
  createdAt: text("created_at").notNull(),
  answeredAt: text("answered_at"),
});

export const metricSamples = pgTable("metric_samples", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  changeId: text("change_id"),
  metricKey: text("metric_key").notNull(),
  value: doublePrecision("value").notNull(),
  recordedAt: text("recorded_at").notNull(),
});

export const events = pgTable("events", {
  seq: serial("seq").primaryKey(),
  id: text("id").notNull().unique(),
  projectId: text("project_id"),
  type: text("type").notNull(),
  payload: jsonb("payload").$type<unknown>(),
  at: text("at").notNull(),
});

/** Idempotent DDL run at store init; valid on both real Postgres and PGlite. */
export const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_url TEXT NOT NULL,
    default_branch TEXT NOT NULL, objective TEXT NOT NULL, eval_command TEXT NOT NULL,
    metrics JSONB NOT NULL, concurrency INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
    prompt TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL, source TEXT NOT NULL,
    created_at TEXT NOT NULL, parent_change_id TEXT
  );
  CREATE TABLE IF NOT EXISTS changes (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, branch TEXT NOT NULL,
    title TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL, base_metrics JSONB,
    new_metrics JSONB, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY, change_id TEXT NOT NULL, reviewer_run_id TEXT NOT NULL,
    verdict TEXT NOT NULL, summary TEXT NOT NULL, comments JSONB NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, change_id TEXT, role TEXT NOT NULL,
    status TEXT NOT NULL, sandbox_id TEXT, started_at TEXT NOT NULL, ended_at TEXT, log_path TEXT
  );
  CREATE TABLE IF NOT EXISTS pointers (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL, from_human BOOLEAN NOT NULL,
    created_at TEXT NOT NULL, consumed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
    answer TEXT, created_at TEXT NOT NULL, answered_at TEXT
  );
  CREATE TABLE IF NOT EXISTS metric_samples (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, change_id TEXT, metric_key TEXT NOT NULL,
    value DOUBLE PRECISION NOT NULL, recorded_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    seq SERIAL PRIMARY KEY, id TEXT NOT NULL UNIQUE, project_id TEXT,
    type TEXT NOT NULL, payload JSONB, at TEXT NOT NULL
  );
`;
