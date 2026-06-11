/**
 * Worker runner: drive one `pi` Worker agent inside a sandbox to produce a
 * change. See ARCHITECTURE.md "Agents → Worker" and the cycle in "Data flow".
 *
 * Flow: create sandbox → clone repo → branch → invoke agent with the worker
 * prompt → defensively commit → capture branch/diff/files/subject → run the
 * eval → push the branch → return a {@link WorkerResult}. The sandbox is
 * disposed before returning; `handleId` is kept for correlation only.
 */

import type { Project, Task } from "../core/types";
import { type SandboxHandle, type SandboxRunner, cloneRepo } from "../sandbox/index";
import { runEval } from "./eval";
import type { AgentInvoker } from "./invoker";
import { buildWorkerPrompt } from "./prompts";

/** Structured outcome of a worker run (store ids are assigned by the caller). */
export interface WorkerResult {
  /** The branch the worker committed and pushed its change to. */
  branch: string;
  /** Subject line of the change's head commit. */
  commitSubject: string;
  /** Unified diff of the change against the project's default branch. */
  diff: string;
  /** Paths changed relative to the repo root. */
  changedFiles: string[];
  /** Metrics parsed from the eval run after the change. */
  metrics: Record<string, number>;
  /** Combined agent log. */
  log: string;
  /** Sandbox id the run executed in (already disposed), for correlation. */
  handleId: string;
}

/**
 * Push a worker's branch so other sandboxes/kernel can fetch it. Pulled out as a
 * seam so tests can substitute a no-op or a push to a local bare repo.
 */
export type PushBranch = (handle: SandboxHandle, branch: string, cwd: string) => Promise<void>;

/** Default push: `git push -u origin <branch>` from the checkout. */
export const gitPushBranch: PushBranch = async (handle, branch, cwd) => {
  await runGit(handle, cwd, `git push -u origin ${branch}`);
};

/** Inputs to {@link runWorker}. */
export interface RunWorkerInput {
  runner: SandboxRunner;
  invoker: AgentInvoker;
  project: Project;
  task: Task;
  /** Env vars (provider keys, model config…) baked into the sandbox. */
  env?: Record<string, string>;
  /** Sandbox snapshot to start from (the recurse snapshot in production). */
  snapshot?: string;
  /**
   * Repo checkout dir inside the sandbox. Defaults to `/workspace`; tests using
   * the local backend pass a relative path so it stays inside the temp sandbox.
   */
  workdir?: string;
  /** How to push the branch; defaults to {@link gitPushBranch}. */
  push?: PushBranch;
  /** Forwarded to the agent invoker for streamed output. */
  onChunk?: (chunk: string) => void;
}

/** Run one worker agent end to end and return its structured result. */
export async function runWorker(input: RunWorkerInput): Promise<WorkerResult> {
  const { runner, invoker, project, task, env, snapshot } = input;
  const workdir = input.workdir ?? "/workspace";
  const push = input.push ?? gitPushBranch;
  const base = project.defaultBranch;
  const branch = `recurse/${shortId(task.id)}`;

  const handle = await runner.create({ snapshot, envVars: env });
  try {
    await cloneRepo(handle, project.repoUrl, workdir, base);
    await runGit(handle, workdir, `git checkout -b ${branch}`);

    const prompt = buildWorkerPrompt({ project, taskPrompt: task.prompt });
    const { log } = await invoker.run(handle, {
      prompt,
      cwd: workdir,
      env,
      onChunk: input.onChunk,
    });

    await commitIfDirty(handle, workdir);

    const diff = (await runGit(handle, workdir, `git diff ${base}...HEAD`)).stdout;
    const changedFiles = (
      await runGit(handle, workdir, `git diff --name-only ${base}...HEAD`)
    ).stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const commitSubject = (await runGit(handle, workdir, "git log -1 --format=%s")).stdout.trim();

    const metrics = await runEval(handle, project, workdir);

    await push(handle, branch, workdir);

    return { branch, commitSubject, diff, changedFiles, metrics, log, handleId: handle.id };
  } finally {
    await handle.dispose();
  }
}

/** First 8 chars of an id, for readable branch names. */
function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "task";
}

/** Commit any uncommitted changes defensively, so the agent's work is captured. */
async function commitIfDirty(handle: SandboxHandle, cwd: string): Promise<void> {
  const status = await handle.exec("git status --porcelain", { cwd });
  if (status.stdout.trim() === "") return;
  await runGit(handle, cwd, "git add -A");
  await runGit(handle, cwd, 'git commit -m "chore(worker): capture uncommitted changes"');
}

/** Run a git command, throwing with captured stderr on failure. */
async function runGit(handle: SandboxHandle, cwd: string, command: string) {
  const result = await handle.exec(command, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}
