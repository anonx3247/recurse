/**
 * Local, service-free {@link SandboxRunner}.
 *
 * Each sandbox is a temp directory under the OS tmpdir; commands run via
 * `node:child_process` and files via `node:fs/promises`. No external service is
 * required, so this is the default backend for tests and for running recurse
 * without a Daytona account. It does NOT provide real isolation — it is meant
 * for development and CI, not untrusted code.
 */

import { exec as execCb } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type {
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  SandboxHandle,
  SandboxRunner,
} from "./runner";

const execAsync = promisify(execCb);

class LocalSandboxHandle implements SandboxHandle {
  constructor(
    readonly id: string,
    private readonly root: string,
    private readonly baseEnv: Record<string, string>,
  ) {}

  /** Resolve a sandbox-relative path against the sandbox root. */
  private resolve(path: string): string {
    return isAbsolute(path) ? path : join(this.root, path);
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: opts.cwd ? this.resolve(opts.cwd) : this.root,
        env: { ...process.env, ...this.baseEnv, ...opts.env },
        timeout: opts.timeoutMs,
        encoding: "utf8",
      });
      return { exitCode: 0, stdout, stderr };
    } catch (err) {
      // execAsync rejects on a non-zero exit; the error carries the captured
      // streams and the child's exit code (or a signal).
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        exitCode: typeof e.code === "number" ? e.code : 1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      };
    }
  }

  async execStream(
    command: string,
    onChunk: (chunk: string) => void,
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    // The local backend buffers, then emulates streaming with a single chunk.
    const result = await this.exec(command, opts);
    const combined = result.stdout + result.stderr;
    if (combined) onChunk(combined);
    return result;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const full = this.resolve(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }

  async readFile(path: string): Promise<string> {
    return readFile(this.resolve(path), "utf8");
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

export class LocalSandboxRunner implements SandboxRunner {
  readonly backend = "local";

  async create(opts: CreateSandboxOptions = {}): Promise<SandboxHandle> {
    const root = await mkdtemp(join(tmpdir(), "recurse-sandbox-"));
    const id = root.split("recurse-sandbox-").pop() ?? root;
    return new LocalSandboxHandle(`local-${id}`, root, opts.envVars ?? {});
  }
}
