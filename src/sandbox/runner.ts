/**
 * Provider-agnostic sandbox abstraction.
 *
 * A {@link SandboxRunner} creates isolated execution environments
 * ({@link SandboxHandle}s) in which recurse runs agent work — shell commands,
 * file I/O, and `git` operations. The kernel and agent-runner depend ONLY on
 * these interfaces, never on a concrete backend (Daytona, local subprocess…),
 * so backends stay swappable and tests can run fully offline.
 */

/** Result of running a single command inside a sandbox. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Options for a single {@link SandboxHandle.exec} call. */
export interface ExecOptions {
  /** Working directory (defaults to the sandbox root). */
  cwd?: string;
  /** Extra environment variables for this command. */
  env?: Record<string, string>;
  /** Hard timeout in milliseconds. */
  timeoutMs?: number;
}

/** A live, isolated environment. Dispose it when done to free resources. */
export interface SandboxHandle {
  /** Opaque, backend-assigned identifier. */
  readonly id: string;

  /** Run a shell command and resolve with its buffered result. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;

  /**
   * Run a shell command, forwarding output to `onChunk` as it arrives.
   * Backends without real streaming emulate it by invoking `onChunk` once
   * with the buffered output before resolving.
   */
  execStream(
    command: string,
    onChunk: (chunk: string) => void,
    opts?: ExecOptions,
  ): Promise<ExecResult>;

  /** Write `content` to `path` (UTF-8), creating parent dirs as needed. */
  writeFile(path: string, content: string): Promise<void>;

  /** Read the UTF-8 contents of `path`. */
  readFile(path: string): Promise<string>;

  /** Tear down the sandbox and release all underlying resources. */
  dispose(): Promise<void>;
}

/** Options for creating a new sandbox. */
export interface CreateSandboxOptions {
  /**
   * Prebaked snapshot/image to start from. The intended recurse snapshot has
   * `node` + `pi` + `git` preinstalled. Ignored by backends without snapshots.
   */
  snapshot?: string;
  /** Environment variables baked into every command in the sandbox. */
  envVars?: Record<string, string>;
}

/** Factory for {@link SandboxHandle}s. One per backend. */
export interface SandboxRunner {
  /** The backend name, for logging/diagnostics (e.g. "daytona", "local"). */
  readonly backend: string;

  /** Provision a fresh, isolated sandbox. */
  create(opts?: CreateSandboxOptions): Promise<SandboxHandle>;
}

/**
 * Clone `repoUrl` into `dir` inside the sandbox, optionally checking out
 * `branch`. A thin convenience over {@link SandboxHandle.exec}; throws with the
 * captured stderr if the clone (or checkout) fails.
 */
export async function cloneRepo(
  handle: SandboxHandle,
  repoUrl: string,
  dir: string,
  branch?: string,
): Promise<void> {
  const branchArg = branch ? `--branch ${branch} ` : "";
  const result = await handle.exec(
    `git clone ${branchArg}${repoUrl} ${dir}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `cloneRepo failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
}
