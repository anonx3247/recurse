/**
 * Shared eval-output parsing for agent runs.
 *
 * A project's `evalCommand` prints a single JSON object of
 * `{ [metricKey]: number }` on stdout (see ARCHITECTURE.md "Eval-output
 * contract"). Agents and the kernel both need to recover those metrics from
 * possibly-noisy command output, so the logic lives here once.
 */

import type { Project } from "../core/types";
import type { SandboxHandle } from "../sandbox/index";

/**
 * Extract the LAST JSON object on `stdout` and return it as a flat metrics map.
 *
 * Tolerating leading log noise (only the final `{...}` is parsed) keeps the
 * contract robust to eval scripts that print progress before their result.
 * Throws a clear error if no JSON object is found, it does not parse, or any
 * value is not a finite number.
 */
export function parseEvalOutput(stdout: string): Record<string, number> {
  const json = lastJsonObject(stdout);
  if (json === undefined) {
    throw new Error(`eval output contained no JSON object:\n${stdout}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new Error(`eval output is not valid JSON: ${json}`, { cause });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`eval output is not a JSON object: ${json}`);
  }

  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`eval metric "${key}" is not a finite number: ${JSON.stringify(value)}`);
    }
    metrics[key] = value;
  }
  return metrics;
}

/**
 * Run `project.evalCommand` in `cwd` inside `handle` and return the parsed
 * metrics. Throws if the command fails or its output violates the contract.
 */
export async function runEval(
  handle: SandboxHandle,
  project: Project,
  cwd: string,
): Promise<Record<string, number>> {
  const result = await handle.exec(project.evalCommand, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      `evalCommand failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return parseEvalOutput(result.stdout);
}

/**
 * Return the source text of the last top-level `{...}` object in `text`, or
 * `undefined` if there is none. Scans forward tracking brace depth (ignoring
 * braces inside strings) and remembers the last balanced top-level object.
 */
function lastJsonObject(text: string): string | undefined {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let last: string | undefined;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0) last = text.slice(start, i + 1);
    }
  }
  return last;
}
