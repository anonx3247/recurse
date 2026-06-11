/**
 * Prompt builders for the agent roles.
 *
 * Prompts are plain strings handed to {@link AgentInvoker.run}. They encode the
 * two machine-readable contracts the runners depend on:
 * - the eval-output contract (a single JSON metrics object on stdout), and
 * - the reviewer's `.recurse/review.json` verdict file (see {@link REVIEW_PATH}).
 */

import type { Project } from "../core/types";

/** Sandbox-relative path where the reviewer must write its verdict. */
export const REVIEW_PATH = ".recurse/review.json";

/** Sandbox-relative path where the ideator must write its proposed ideas. */
export const IDEAS_PATH = ".recurse/ideas.json";

/** Render a project's metric specs as a readable bullet list for prompts. */
function describeMetrics(project: Project): string {
  return project.metrics
    .map((m) => `  - ${m.key} (${m.label}): ${m.direction}${m.unit ? ` [${m.unit}]` : ""}`)
    .join("\n");
}

/** Inputs to {@link buildWorkerPrompt}. */
export interface WorkerPromptInput {
  project: Project;
  /** The task's natural-language instruction for this run. */
  taskPrompt: string;
}

/**
 * Build the worker prompt: make a small, focused change toward the objective,
 * re-run the eval, and commit. The eval contract is restated so the agent
 * preserves valid metric JSON.
 */
export function buildWorkerPrompt({ project, taskPrompt }: WorkerPromptInput): string {
  return `You are a Worker agent improving the project "${project.name}".

OBJECTIVE
${project.objective}

YOUR TASK
${taskPrompt}

METRICS (the eval measures these; respect each direction)
${describeMetrics(project)}

EVAL CONTRACT
Running \`${project.evalCommand}\` in the repo root prints a SINGLE JSON object
of {"metricKey": number} as the last line on stdout, and nothing else after it.
Your change MUST keep that command working and emitting valid metric JSON.

INSTRUCTIONS
1. Make focused changes that move the metrics in the right direction. Keep the
   diff as small as possible — touch only what the task needs.
2. Run \`${project.evalCommand}\` and confirm it still prints valid metric JSON.
3. Commit your work with a clear, conventional commit message that summarizes
   the change in its subject line.

Do not push; the runner handles branching and pushing.`;
}

/** A change outcome summarized for the ideator's context. */
export interface ChangeOutcome {
  title: string;
  status: string;
  newMetrics?: Record<string, number>;
}

/** Inputs to {@link buildIdeatorPrompt}. */
export interface IdeatorPromptInput {
  project: Project;
  /** Current baseline metrics (latest merged change), when known. */
  baseline?: Record<string, number>;
  /** Recent merged/rejected change outcomes, newest last. */
  recentChanges?: ChangeOutcome[];
  /** Unconsumed human pointers steering the search. */
  pointers?: string[];
  /** How many ideas to ask for. */
  count: number;
}

/** Render the baseline metrics as a readable list, or a placeholder. */
function describeBaseline(baseline?: Record<string, number>): string {
  if (!baseline || Object.keys(baseline).length === 0) return "  (no baseline yet)";
  return Object.entries(baseline)
    .map(([key, value]) => `  - ${key}: ${value}`)
    .join("\n");
}

/** Render recent change outcomes as a readable list, or a placeholder. */
function describeOutcomes(outcomes?: ChangeOutcome[]): string {
  if (!outcomes || outcomes.length === 0) return "  (no changes yet)";
  return outcomes
    .map((c) => {
      const metrics = c.newMetrics ? ` ${JSON.stringify(c.newMetrics)}` : "";
      return `  - [${c.status}] ${c.title}${metrics}`;
    })
    .join("\n");
}

/** Render the human pointers as a readable list, or a placeholder. */
function describePointers(pointers?: string[]): string {
  if (!pointers || pointers.length === 0) return "  (none)";
  return pointers.map((p) => `  - ${p}`).join("\n");
}

/**
 * Build the ideator prompt: read the repo, history, metric trends, and human
 * pointers, then propose `count` concrete, diverse improvement ideas as a JSON
 * object written to {@link IDEAS_PATH}. Each idea carries a worker-ready prompt
 * so a Worker can pick it up directly.
 */
export function buildIdeatorPrompt({
  project,
  baseline,
  recentChanges,
  pointers,
  count,
}: IdeatorPromptInput): string {
  return `You are an Ideator agent generating the next improvement tasks for the
project "${project.name}". The engine is never idle: when the work queue empties,
you invent the next high-leverage directions to pursue.

OBJECTIVE
${project.objective}

METRICS (the eval measures these; respect each direction)
${describeMetrics(project)}

CURRENT BASELINE METRICS
${describeBaseline(baseline)}

RECENT CHANGE OUTCOMES (newest last)
${describeOutcomes(recentChanges)}

HUMAN POINTERS (directions a human dropped in the inbox)
${describePointers(pointers)}

YOUR JOB
Inspect the repository and the context above, then propose ${count} CONCRETE,
DIVERSE improvement ideas that would move the metrics in the right direction.
Favor variety (different files/subsystems/approaches) over redundant variations,
and avoid repeating ideas that recently failed. Each idea must be specific enough
that a Worker agent can act on it directly.

OUTPUT CONTRACT
Write your ideas as JSON to the file \`${IDEAS_PATH}\` (relative to the repo
root). It MUST match exactly this shape:

{
  "ideas": [
    {
      "title": "short imperative title",
      "prompt": "a self-contained, worker-ready instruction for this change",
      "priority": 0
    }
  ]
}

Use a higher \`priority\` integer for higher-leverage ideas (0 is normal). Write
ONLY valid JSON to that file — no markdown fences, no prose around it.`;
}

/** Inputs to {@link buildReviewerPrompt}. */
export interface ReviewerPromptInput {
  project: Project;
  /** Unified diff of the change under review. */
  diff: string;
  /** Per-metric before→after values, when known. */
  metricDeltas?: Record<string, { base?: number; next: number }>;
}

/** Render metric deltas as a readable list, or a placeholder when absent. */
function describeDeltas(deltas: ReviewerPromptInput["metricDeltas"]): string {
  if (!deltas || Object.keys(deltas).length === 0) return "  (no metric deltas provided)";
  return Object.entries(deltas)
    .map(([key, { base, next }]) => `  - ${key}: ${base ?? "?"} → ${next}`)
    .join("\n");
}

/**
 * Build the reviewer prompt: assess the diff + metric deltas against the
 * objective and write a structured verdict to {@link REVIEW_PATH}.
 */
export function buildReviewerPrompt({ project, diff, metricDeltas }: ReviewerPromptInput): string {
  return `You are a Reviewer agent reviewing a proposed change to "${project.name}",
like reviewing a pull request.

OBJECTIVE
${project.objective}

METRIC DELTAS (before → after)
${describeDeltas(metricDeltas)}

DIFF UNDER REVIEW
\`\`\`diff
${diff}
\`\`\`

YOUR JOB
Judge whether this change improves the project against the objective and metrics
without introducing regressions, bugs, or unnecessary complexity.

OUTPUT CONTRACT
Write your verdict as JSON to the file \`${REVIEW_PATH}\` (relative to the repo
root). It MUST match exactly this shape:

{
  "verdict": "approve" | "request_changes" | "comment",
  "summary": "one-paragraph overall assessment",
  "comments": [
    { "path": "optional/file/path", "line": 123, "body": "specific note",
      "severity": "info" | "nit" | "major" | "blocker" }
  ]
}

Use "approve" only if the change is sound and worth landing. Use
"request_changes" if it needs fixes before landing. Use "comment" for neutral
observations. Write ONLY valid JSON to that file — no markdown, no prose around
it.`;
}
