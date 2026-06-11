/**
 * Shared eval-output parsing for agent runs.
 *
 * A project's `evalCommand` prints a single JSON object of
 * `{ [metricKey]: number }` on stdout (see ARCHITECTURE.md "Eval-output
 * contract"). Agents and the kernel both need to recover those metrics from
 * possibly-noisy command output, so the logic lives here once.
 */

import type { Project } from "../core/types.js";
import type { SandboxHandle } from "../sandbox/index.js";

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
 * `undefined` if there is none. Scans from the end for the closing brace, then
 * walks back tracking brace depth (ignoring braces inside strings) to find its
 * matching open.
 */
function lastJsonObject(text: string): string | undefined {
  const end = text.lastIndexOf("}");
  if (end === -1) return undefined;

  let depth = 0;
  let inString = false;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (inString) {
      // Walking backwards: a quote ends the string unless it is escaped, which
      // we detect by counting preceding backslashes.
      if (ch === '"' && !isEscapedQuote(text, i)) inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "}") depth++;
    else if (ch === "{") {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return undefined;
}

/** True if the `"` at `index` is escaped by an odd number of backslashes. */
function isEscapedQuote(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 1;
}
