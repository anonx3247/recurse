/**
 * Reviewer runner: drive one `pi` Reviewer agent inside a sandbox to review a
 * change. See ARCHITECTURE.md "Agents → Reviewer".
 *
 * Flow: create sandbox → clone repo → checkout the change branch → invoke the
 * agent with the reviewer prompt → read + validate `.recurse/review.json` →
 * return a {@link ReviewResult}. Malformed agent output degrades to a safe
 * `comment` verdict carrying the raw log, never throwing. The sandbox is
 * disposed before returning; `handleId` is kept for correlation only.
 */

import type { Change, Project, ReviewComment, ReviewVerdict } from "../core/types.js";
import { type SandboxHandle, type SandboxRunner, cloneRepo } from "../sandbox/index.js";
import type { AgentInvoker } from "./invoker.js";
import { REVIEW_PATH, buildReviewerPrompt } from "./prompts.js";

/** Structured review (the store ids are assigned by the caller). */
export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  comments: ReviewComment[];
  /** Combined agent log. */
  log: string;
  /** Sandbox id the run executed in (already disposed), for correlation. */
  handleId: string;
}

/** Inputs to {@link runReviewer}. */
export interface RunReviewerInput {
  runner: SandboxRunner;
  invoker: AgentInvoker;
  project: Project;
  /** The change under review (its `branch` is checked out). */
  change: Change;
  /** Unified diff of the change, shown to the agent. */
  diff: string;
  env?: Record<string, string>;
  snapshot?: string;
  /** Repo checkout dir inside the sandbox. Defaults to `/workspace`. */
  workdir?: string;
  /** Forwarded to the agent invoker for streamed output. */
  onChunk?: (chunk: string) => void;
}

/** Run one reviewer agent end to end and return its structured verdict. */
export async function runReviewer(input: RunReviewerInput): Promise<ReviewResult> {
  const { runner, invoker, project, change, diff, env, snapshot } = input;
  const workdir = input.workdir ?? "/workspace";

  const handle = await runner.create({ snapshot, envVars: env });
  try {
    await cloneRepo(handle, project.repoUrl, workdir, change.branch);

    const metricDeltas = buildMetricDeltas(change);
    const prompt = buildReviewerPrompt({ project, diff, metricDeltas });
    const { log } = await invoker.run(handle, {
      prompt,
      cwd: workdir,
      env,
      onChunk: input.onChunk,
    });

    const review = await readReview(handle, `${workdir}/${REVIEW_PATH}`);
    return { ...(review ?? fallbackReview(log)), log, handleId: handle.id };
  } finally {
    await handle.dispose();
  }
}

/** Derive before→after metric deltas from a change, when both sides are known. */
function buildMetricDeltas(
  change: Change,
): Record<string, { base?: number; next: number }> | undefined {
  const next = change.newMetrics;
  if (!next) return undefined;
  const deltas: Record<string, { base?: number; next: number }> = {};
  for (const [key, value] of Object.entries(next)) {
    deltas[key] = { base: change.baseMetrics?.[key], next: value };
  }
  return deltas;
}

/** A safe neutral verdict used when the agent produced no usable review. */
function fallbackReview(log: string): Pick<ReviewResult, "verdict" | "summary" | "comments"> {
  return {
    verdict: "comment",
    summary: `Reviewer produced no valid ${REVIEW_PATH}; see log.\n${log}`.trim(),
    comments: [],
  };
}

/**
 * Read and validate `.recurse/review.json`. Returns the parsed review, or
 * `undefined` if the file is missing, unparseable, or fails validation (the
 * caller falls back to a neutral verdict).
 */
async function readReview(
  handle: SandboxHandle,
  path: string,
): Promise<Pick<ReviewResult, "verdict" | "summary" | "comments"> | undefined> {
  let raw: string;
  try {
    raw = await handle.readFile(path);
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return parseReview(parsed);
}

const VERDICTS: readonly ReviewVerdict[] = ["approve", "request_changes", "comment"];
const SEVERITIES: readonly ReviewComment["severity"][] = ["info", "nit", "major", "blocker"];

/** Validate an unknown value against the review contract. */
function parseReview(
  value: unknown,
): Pick<ReviewResult, "verdict" | "summary" | "comments"> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;

  if (!isOneOf(obj.verdict, VERDICTS)) return undefined;
  if (typeof obj.summary !== "string") return undefined;

  const rawComments = obj.comments ?? [];
  if (!Array.isArray(rawComments)) return undefined;
  const comments: ReviewComment[] = [];
  for (const c of rawComments) {
    const comment = parseComment(c);
    if (!comment) return undefined;
    comments.push(comment);
  }

  return { verdict: obj.verdict, summary: obj.summary, comments };
}

/** Validate a single review comment. */
function parseComment(value: unknown): ReviewComment | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;

  if (typeof obj.body !== "string") return undefined;
  if (!isOneOf(obj.severity, SEVERITIES)) return undefined;
  if (obj.path !== undefined && typeof obj.path !== "string") return undefined;
  if (obj.line !== undefined && typeof obj.line !== "number") return undefined;

  const comment: ReviewComment = { body: obj.body, severity: obj.severity };
  if (typeof obj.path === "string") comment.path = obj.path;
  if (typeof obj.line === "number") comment.line = obj.line;
  return comment;
}

/** Narrowing membership check against a literal-union allowlist. */
function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
