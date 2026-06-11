import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
 * Drizzle ORM schema for the SQLite-backed state store. JSON-valued columns use
 * `text({ mode: "json" })` so drizzle serializes/parses them automatically.
 */

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  objective: text("objective").notNull(),
  evalCommand: text("eval_command").notNull(),
  metrics: text("metrics", { mode: "json" }).$type<MetricSpec[]>().notNull(),
  concurrency: integer("concurrency").notNull(),
  createdAt: text("created_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
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

export const changes = sqliteTable("changes", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  taskId: text("task_id").notNull(),
  branch: text("branch").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  status: text("status").$type<ChangeStatus>().notNull(),
  baseMetrics: text("base_metrics", { mode: "json" }).$type<Record<string, number>>(),
  newMetrics: text("new_metrics", { mode: "json" }).$type<Record<string, number>>(),
  createdAt: text("created_at").notNull(),
});

export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  changeId: text("change_id").notNull(),
  reviewerRunId: text("reviewer_run_id").notNull(),
  verdict: text("verdict").$type<ReviewVerdict>().notNull(),
  summary: text("summary").notNull(),
  comments: text("comments", { mode: "json" }).$type<ReviewComment[]>().notNull(),
  createdAt: text("created_at").notNull(),
});

export const agentRuns = sqliteTable("agent_runs", {
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

export const pointers = sqliteTable("pointers", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  body: text("body").notNull(),
  fromHuman: integer("from_human", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
  consumedAt: text("consumed_at"),
});

export const questions = sqliteTable("questions", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  body: text("body").notNull(),
  status: text("status").$type<QuestionStatus>().notNull(),
  answer: text("answer"),
  createdAt: text("created_at").notNull(),
  answeredAt: text("answered_at"),
});

export const metricSamples = sqliteTable("metric_samples", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  changeId: text("change_id"),
  metricKey: text("metric_key").notNull(),
  value: real("value").notNull(),
  recordedAt: text("recorded_at").notNull(),
});

export const events = sqliteTable("events", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  id: text("id").notNull().unique(),
  projectId: text("project_id"),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }).$type<unknown>(),
  at: text("at").notNull(),
});

/** Idempotent DDL run at store init (drizzle queries assume these tables exist). */
export const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_url TEXT NOT NULL,
    default_branch TEXT NOT NULL, objective TEXT NOT NULL, eval_command TEXT NOT NULL,
    metrics TEXT NOT NULL, concurrency INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
    prompt TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL, source TEXT NOT NULL,
    created_at TEXT NOT NULL, parent_change_id TEXT
  );
  CREATE TABLE IF NOT EXISTS changes (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, branch TEXT NOT NULL,
    title TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL, base_metrics TEXT,
    new_metrics TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY, change_id TEXT NOT NULL, reviewer_run_id TEXT NOT NULL,
    verdict TEXT NOT NULL, summary TEXT NOT NULL, comments TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, change_id TEXT, role TEXT NOT NULL,
    status TEXT NOT NULL, sandbox_id TEXT, started_at TEXT NOT NULL, ended_at TEXT, log_path TEXT
  );
  CREATE TABLE IF NOT EXISTS pointers (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL, from_human INTEGER NOT NULL,
    created_at TEXT NOT NULL, consumed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
    answer TEXT, created_at TEXT NOT NULL, answered_at TEXT
  );
  CREATE TABLE IF NOT EXISTS metric_samples (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, change_id TEXT, metric_key TEXT NOT NULL,
    value REAL NOT NULL, recorded_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT,
    type TEXT NOT NULL, payload TEXT, at TEXT NOT NULL
  );
`;
