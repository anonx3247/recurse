/**
 * Branch-integration seam: actually land a merged Change's branch into the
 * project's `defaultBranch` in the real target repo.
 *
 * This mirrors the {@link PushBranch} seam in `worker.ts`: a real `git`
 * operation in production, injected/no-op'd in offline tests so the whole
 * cycle stays hermetic. The merge gate (see `src/kernel/phases.ts`) only marks
 * a Change `merged` in recurse's own DB; integration is what makes the
 * improvement land in the project's history so the next baseline really builds
 * on it.
 */

import type { Project } from "../core/types";
import { type SandboxHandle, type SandboxRunner, cloneRepo } from "../sandbox/index";

/** Inputs to an {@link IntegrateBranch} call. */
export interface IntegrateBranchInput {
  /** Sandbox runner used to perform the integration (real git in production). */
  runner: SandboxRunner;
  /** The project whose `defaultBranch` the change lands into. */
  project: Project;
  /** The change's branch (already pushed to `origin` by the worker). */
  branch: string;
  /** Env vars (provider keys, git creds…) baked into the sandbox. */
  env?: Record<string, string>;
  /** Sandbox snapshot to start from (the recurse snapshot in production). */
  snapshot?: string;
  /** Repo checkout dir inside the sandbox. Defaults to `/workspace`. */
  workdir?: string;
}

/**
 * Integrate a change's branch into the project's default branch. Pulled out as
 * a seam so tests substitute a no-op/spy and stay offline, exactly like
 * {@link PushBranch}.
 */
export type IntegrateBranch = (input: IntegrateBranchInput) => Promise<void>;

/** Which built-in integration strategy {@link integratorForMode} returns. */
export type IntegrateMode = "git-merge" | "github-pr";

/**
 * Default integration: inside a fresh sandbox, check out `defaultBranch`, merge
 * the change's branch into it, and push. The worker already pushed the branch
 * to `origin`, so we fetch it and merge `--no-edit` (fast-forward when the base
 * has not moved, a real merge commit otherwise).
 */
export const gitIntegrateBranch: IntegrateBranch = async (input) => {
  const workdir = input.workdir ?? "/workspace";
  const base = input.project.defaultBranch;
  const handle = await input.runner.create({ snapshot: input.snapshot, envVars: input.env });
  try {
    await cloneRepo(handle, input.project.repoUrl, workdir, base);
    await runGit(handle, workdir, `git fetch origin ${input.branch}`);
    await runGit(handle, workdir, "git merge --no-edit FETCH_HEAD");
    await runGit(handle, workdir, `git push origin ${base}`);
  } finally {
    await handle.dispose();
  }
};

/**
 * Alternative integration: open and merge a GitHub PR for the branch via the
 * `gh` CLI (which must be authenticated in the sandbox). Useful when the target
 * repo's policy requires PRs rather than direct pushes.
 */
export const githubPrIntegrateBranch: IntegrateBranch = async (input) => {
  const workdir = input.workdir ?? "/workspace";
  const base = input.project.defaultBranch;
  const handle = await input.runner.create({ snapshot: input.snapshot, envVars: input.env });
  try {
    await cloneRepo(handle, input.project.repoUrl, workdir, base);
    await runGit(
      handle,
      workdir,
      `gh pr create --head ${input.branch} --base ${base} --fill || true`,
    );
    await runGit(handle, workdir, `gh pr merge ${input.branch} --merge --admin`);
  } finally {
    await handle.dispose();
  }
};

/** Resolve the built-in integrator for a mode, defaulting to git-merge. */
export function integratorForMode(mode?: IntegrateMode): IntegrateBranch {
  return mode === "github-pr" ? githubPrIntegrateBranch : gitIntegrateBranch;
}

/** Run a git/gh command, throwing with captured stderr on failure. */
async function runGit(handle: SandboxHandle, cwd: string, command: string) {
  const result = await handle.exec(command, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
}
