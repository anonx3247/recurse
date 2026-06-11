/**
 * Agent invoker seam.
 *
 * An {@link AgentInvoker} runs a single `pi` agent inside a {@link SandboxHandle}
 * and returns its combined log. Splitting this out behind an interface lets the
 * worker/reviewer runners be tested fully offline with a {@link FakeAgentInvoker}
 * (no model, no network) while production uses {@link PiAgentInvoker}.
 */

import type { SandboxHandle } from "../sandbox/index";

/** Options for a single {@link AgentInvoker.run}. */
export interface AgentInvokeOptions {
  /** The natural-language prompt the agent should execute. */
  prompt: string;
  /** Working directory inside the sandbox (usually the repo checkout). */
  cwd: string;
  /** Extra environment variables for the agent process. */
  env?: Record<string, string>;
  /** Called with each chunk of streamed output as it arrives. */
  onChunk?: (chunk: string) => void;
}

/** Result of an agent invocation. */
export interface AgentInvokeResult {
  exitCode: number;
  /** Combined stdout/stderr captured from the run. */
  log: string;
}

/** Runs a `pi` agent inside a sandbox. */
export interface AgentInvoker {
  run(handle: SandboxHandle, opts: AgentInvokeOptions): Promise<AgentInvokeResult>;
}

/** Where {@link PiAgentInvoker} stages the prompt file inside the sandbox. */
const PROMPT_PATH = ".recurse/prompt.txt";

/** Options for constructing a {@link PiAgentInvoker}. */
export interface PiAgentInvokerOptions {
  /**
   * Model to pass to `pi` via `--model`. Defaults to `RECURSE_PI_MODEL` from the
   * invoke env (falling back to none, in which case `pi` uses its own default).
   */
  model?: string;
}

/**
 * Production invoker: drives `pi` in non-interactive print mode.
 *
 * Assumes the sandbox snapshot has `pi`, `node`, and `git` installed and that
 * the provider key (e.g. `ANTHROPIC_API_KEY`) is present in the sandbox env —
 * the caller passes it at `SandboxRunner.create({ envVars })` time. Real runs
 * therefore require a model key; with none, `pi` will fail to reach a provider.
 *
 * The prompt is written to a file inside the sandbox and read back via
 * `"$(cat …)"` so arbitrary prompt text never has to be shell-escaped.
 */
export class PiAgentInvoker implements AgentInvoker {
  constructor(private readonly options: PiAgentInvokerOptions = {}) {}

  async run(handle: SandboxHandle, opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const promptFile = `${opts.cwd}/${PROMPT_PATH}`;
    await handle.writeFile(promptFile, opts.prompt);

    const model = this.options.model ?? opts.env?.RECURSE_PI_MODEL;
    const modelFlag = model ? ` --model ${shellQuote(model)}` : "";
    const command = `pi -p "$(cat ${shellQuote(promptFile)})"${modelFlag}`;

    let log = "";
    const result = await handle.execStream(
      command,
      (chunk) => {
        log += chunk;
        opts.onChunk?.(chunk);
      },
      { cwd: opts.cwd, env: opts.env },
    );
    return { exitCode: result.exitCode, log };
  }
}

/**
 * A callback that simulates an agent's effect on the sandbox (e.g. edit a file
 * and commit, or write a result file) without invoking any model.
 */
export type FakeAgentAction = (
  handle: SandboxHandle,
  opts: AgentInvokeOptions,
) => Promise<void> | void;

/**
 * Build an offline {@link AgentInvoker} for tests. It runs `action` against the
 * handle to mimic an agent's side effects, then returns a synthetic log. The
 * prompt is echoed into the log so assertions can inspect what was sent.
 */
export function FakeAgentInvoker(action: FakeAgentAction): AgentInvoker {
  return {
    async run(handle, opts) {
      await action(handle, opts);
      const log = `[fake-agent] prompt:\n${opts.prompt}\n`;
      opts.onChunk?.(log);
      return { exitCode: 0, log };
    },
  };
}

/** Quote a string for safe use as a single POSIX shell word. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
