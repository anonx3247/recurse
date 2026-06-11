/**
 * Ideator runner: drive one `pi` Ideator agent inside a sandbox to propose new
 * improvement tasks. See ARCHITECTURE.md "Agents → Ideator".
 *
 * Flow: create sandbox → clone the repo (default branch) → invoke the agent with
 * the ideator prompt → read + parse `.recurse/ideas.json` → return the proposed
 * {@link IdeaProposal}s. Parsing is prose-tolerant (it recovers the last JSON
 * object via {@link lastJsonObject}, exactly like the eval-output contract) and
 * never throws: malformed or missing output degrades to an empty list so the
 * scheduler can fall back to a generic seed. The sandbox is disposed before
 * returning; `handleId` is kept for correlation only.
 */

import type { Project } from "../core/types";
import { type SandboxHandle, type SandboxRunner, cloneRepo } from "../sandbox/index";
import { lastJsonObject } from "./eval";
import type { AgentInvoker } from "./invoker";
import { type ChangeOutcome, IDEAS_PATH, buildIdeatorPrompt } from "./prompts";

/** A single concrete improvement idea proposed by the ideator. */
export interface IdeaProposal {
  /** Short imperative title for the resulting task. */
  title: string;
  /** Self-contained, worker-ready instruction. */
  prompt: string;
  /** Relative priority (higher runs first); defaults to 0 when unspecified. */
  priority: number;
}

/** Structured outcome of an ideator run (store ids are assigned by the caller). */
export interface IdeatorResult {
  ideas: IdeaProposal[];
  /** Combined agent log. */
  log: string;
  /** Sandbox id the run executed in (already disposed), for correlation. */
  handleId: string;
}

/** Inputs to {@link runIdeator}. */
export interface RunIdeatorInput {
  runner: SandboxRunner;
  invoker: AgentInvoker;
  project: Project;
  /** Current baseline metrics (latest merged change), when known. */
  baseline?: Record<string, number>;
  /** Recent merged/rejected change outcomes, newest last. */
  recentChanges?: ChangeOutcome[];
  /** Unconsumed human pointer bodies. */
  pointers?: string[];
  /** How many ideas to ask for (and cap to). Default 3. */
  count?: number;
  env?: Record<string, string>;
  snapshot?: string;
  /** Repo checkout dir inside the sandbox. Defaults to `/workspace`. */
  workdir?: string;
  /** Forwarded to the agent invoker for streamed output. */
  onChunk?: (chunk: string) => void;
}

/** Run one ideator agent end to end and return its proposed ideas. */
export async function runIdeator(input: RunIdeatorInput): Promise<IdeatorResult> {
  const { runner, invoker, project, env, snapshot } = input;
  const workdir = input.workdir ?? "/workspace";
  const count = input.count ?? 3;

  const handle = await runner.create({ snapshot, envVars: env });
  try {
    await cloneRepo(handle, project.repoUrl, workdir, project.defaultBranch);

    const prompt = buildIdeatorPrompt({
      project,
      baseline: input.baseline,
      recentChanges: input.recentChanges,
      pointers: input.pointers,
      count,
    });
    const { log } = await invoker.run(handle, {
      prompt,
      cwd: workdir,
      env,
      onChunk: input.onChunk,
    });

    const ideas = await readIdeas(handle, `${workdir}/${IDEAS_PATH}`, count);
    return { ideas, log, handleId: handle.id };
  } finally {
    await handle.dispose();
  }
}

/**
 * Read and parse `.recurse/ideas.json`, prose-tolerantly. Returns up to `limit`
 * valid ideas, or an empty list if the file is missing, unparseable, or carries
 * no valid ideas (the caller falls back to a generic seed task).
 */
async function readIdeas(
  handle: SandboxHandle,
  path: string,
  limit: number,
): Promise<IdeaProposal[]> {
  let raw: string;
  try {
    raw = await handle.readFile(path);
  } catch {
    return [];
  }
  return parseIdeas(raw, limit);
}

/**
 * Parse ideas from possibly-noisy text: recover the last JSON object (tolerating
 * prose/markdown around it), then validate its `ideas` array. Invalid entries
 * are skipped; the result is capped to `limit`.
 */
export function parseIdeas(text: string, limit: number): IdeaProposal[] {
  const json = lastJsonObject(text);
  if (json === undefined) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }

  if (typeof parsed !== "object" || parsed === null) return [];
  const rawIdeas = (parsed as Record<string, unknown>).ideas;
  if (!Array.isArray(rawIdeas)) return [];

  const ideas: IdeaProposal[] = [];
  for (const entry of rawIdeas) {
    const idea = parseIdea(entry);
    if (idea) ideas.push(idea);
    if (ideas.length >= limit) break;
  }
  return ideas;
}

/** Validate a single idea entry, returning `undefined` when malformed. */
function parseIdea(value: unknown): IdeaProposal | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.title !== "string" || obj.title.trim() === "") return undefined;
  if (typeof obj.prompt !== "string" || obj.prompt.trim() === "") return undefined;
  const priority =
    typeof obj.priority === "number" && Number.isFinite(obj.priority) ? obj.priority : 0;
  return { title: obj.title.trim(), prompt: obj.prompt.trim(), priority };
}
