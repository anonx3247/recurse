/**
 * Daytona-backed {@link SandboxRunner}.
 *
 * Thin mapping over the official Daytona TypeScript SDK (`@daytona/sdk`). Only
 * the surface the {@link SandboxHandle} interface needs is wired up — we do not
 * wrap every SDK feature.
 *
 * SDK methods used (see https://www.daytona.io/docs/en/typescript-sdk):
 * - `new Daytona({ apiKey, apiUrl, target })` — client init.
 * - `daytona.create({ snapshot, envVars }, { timeout })` — provision a sandbox.
 * - `sandbox.process.executeCommand(command, cwd?, env?, timeoutSec?)` — exec.
 * - `sandbox.fs.uploadFile(Buffer, remotePath)` — writeFile.
 * - `sandbox.fs.downloadFile(remotePath)` — readFile.
 * - `daytona.delete(sandbox)` — dispose.
 *
 * Credentials come from the environment (`DAYTONA_API_KEY`, optional
 * `DAYTONA_API_URL` / `DAYTONA_TARGET`); nothing is hardcoded. The intended
 * recurse snapshot has `node` + `pi` + `git` preinstalled.
 */

import { Daytona, type Sandbox } from "@daytona/sdk";
import type {
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  SandboxHandle,
  SandboxRunner,
} from "./runner.js";

/** Convert an optional millisecond timeout to the SDK's whole-second timeout. */
function toTimeoutSeconds(timeoutMs?: number): number | undefined {
  return timeoutMs === undefined ? undefined : Math.ceil(timeoutMs / 1000);
}

class DaytonaSandboxHandle implements SandboxHandle {
  constructor(
    readonly id: string,
    private readonly daytona: Daytona,
    private readonly sandbox: Sandbox,
  ) {}

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const res = await this.sandbox.process.executeCommand(
      command,
      opts.cwd,
      opts.env,
      toTimeoutSeconds(opts.timeoutMs),
    );
    // executeCommand returns a combined `result` (stdout) plus exitCode; the
    // toolbox does not split stderr, so we surface everything via stdout.
    return {
      exitCode: res.exitCode ?? 0,
      stdout: res.result ?? "",
      stderr: "",
    };
  }

  async execStream(
    command: string,
    onChunk: (chunk: string) => void,
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    // executeCommand is buffered; emulate streaming with a single chunk.
    const result = await this.exec(command, opts);
    if (result.stdout) onChunk(result.stdout);
    return result;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.sandbox.fs.uploadFile(Buffer.from(content, "utf8"), path);
  }

  async readFile(path: string): Promise<string> {
    const buf = await this.sandbox.fs.downloadFile(path);
    return buf.toString("utf8");
  }

  async dispose(): Promise<void> {
    await this.daytona.delete(this.sandbox);
  }
}

export class DaytonaSandboxRunner implements SandboxRunner {
  readonly backend = "daytona";
  private readonly daytona: Daytona;

  constructor() {
    const apiKey = process.env.DAYTONA_API_KEY;
    if (!apiKey) {
      throw new Error(
        "DAYTONA_API_KEY is not set. Provide a Daytona API key (or use the " +
          "local sandbox runner by unsetting DAYTONA_API_KEY).",
      );
    }
    this.daytona = new Daytona({
      apiKey,
      apiUrl: process.env.DAYTONA_API_URL,
      target: process.env.DAYTONA_TARGET,
    });
  }

  async create(opts: CreateSandboxOptions = {}): Promise<SandboxHandle> {
    const sandbox = await this.daytona.create({
      snapshot: opts.snapshot,
      envVars: opts.envVars,
    });
    return new DaytonaSandboxHandle(sandbox.id, this.daytona, sandbox);
  }
}
