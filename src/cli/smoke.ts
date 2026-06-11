/**
 * Live smoke cycle: run ONE real improvement cycle end-to-end against real
 * Daytona + real `pi` + a real model, to prove the whole vertical slice works.
 *
 * Usage: `npm run smoke`
 *
 * It is fully opt-in and env-gated: without `DAYTONA_API_KEY` and
 * `ANTHROPIC_API_KEY` it prints how to run it and exits 0, so it NEVER breaks
 * CI. When the keys are present it:
 *
 *   1. ensures the agent snapshot exists (builds it from `sandbox/Dockerfile`);
 *   2. provisions ONE Daytona sandbox from that snapshot;
 *   3. seeds the committed `examples/smoke-target` repo into a bare git origin
 *      inside the sandbox (`file://`), so worker + reviewer can clone/push it;
 *   4. drives the real kernel cycle (`runCycle`): worker (real `pi`) makes the
 *      failing test pass, the eval is parsed, the reviewer reviews, and the
 *      merge gate decides — exactly the production phases, nothing re-implemented;
 *   5. prints a clear summary of the resulting Change, metrics, and verdict.
 *
 * The kernel business logic and merge semantics are untouched: this file only
 * wires real backends into the existing `runCycle`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Daytona } from "@daytona/sdk";
import { PiAgentInvoker } from "../agent/index";
import { loadConfig } from "../core/index";
import type { Project } from "../core/types";
import { runCycle } from "../kernel/phases";
import {
  type CreateSandboxOptions,
  DaytonaSandboxRunner,
  type ExecOptions,
  type ExecResult,
  type SandboxHandle,
  type SandboxRunner,
} from "../sandbox/index";
import { ensureSnapshot } from "../sandbox/snapshot";
import { MemoryStore } from "../store/index";

/** Provider/model env vars forwarded into the sandbox (read from the host). */
const SANDBOX_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "RECURSE_PI_MODEL",
] as const;

/** Where the bare git origin lives inside the sandbox (outside the workdir). */
const ORIGIN_PATH = "/opt/recurse-origin.git";
const ORIGIN_URL = `file://${ORIGIN_PATH}`;
/** Repo checkout dir inside the sandbox (reset between worker and reviewer). */
const WORKDIR = "/workspace";

const log = (line: string): void => void process.stdout.write(`${line}\n`);

/** Collect the configured provider keys from the host process environment. */
function sandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SANDBOX_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/** Absolute path to the committed sample target repo. */
function smokeTargetDir(): string {
  return fileURLToPath(new URL("../../examples/smoke-target", import.meta.url));
}

/**
 * Delegates every operation to a shared sandbox, but on `dispose()` only resets
 * the workdir (the caller owns the real sandbox's lifecycle).
 */
class SharedSandboxHandle implements SandboxHandle {
  constructor(
    private readonly inner: SandboxHandle,
    private readonly reset: () => Promise<void>,
  ) {}

  get id(): string {
    return this.inner.id;
  }
  exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    return this.inner.exec(command, opts);
  }
  execStream(
    command: string,
    onChunk: (chunk: string) => void,
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    return this.inner.execStream(command, onChunk, opts);
  }
  writeFile(path: string, content: string): Promise<void> {
    return this.inner.writeFile(path, content);
  }
  readFile(path: string): Promise<string> {
    return this.inner.readFile(path);
  }
  dispose(): Promise<void> {
    return this.reset();
  }
}

/**
 * A {@link SandboxRunner} backed by a single, already-provisioned sandbox.
 *
 * `runCycle` runs the worker and reviewer sequentially, each calling
 * `runner.create()`. Reusing one real sandbox (and resetting only the workdir
 * between phases — the bare origin lives outside it) keeps the smoke to a single
 * provision while preserving every absolute-path assumption of the agent
 * runners. The shared sandbox is disposed by the caller, not by `dispose()`.
 */
class SharedSandboxRunner implements SandboxRunner {
  readonly backend = "shared";

  constructor(
    private readonly handle: SandboxHandle,
    private readonly workdir: string,
  ) {}

  async create(_opts?: CreateSandboxOptions): Promise<SandboxHandle> {
    await this.resetWorkdir();
    return new SharedSandboxHandle(this.handle, () => this.resetWorkdir());
  }

  /** Remove the workdir so the next `git clone` starts from a clean slate. */
  private async resetWorkdir(): Promise<void> {
    await this.handle.exec(`rm -rf ${this.workdir}`);
  }
}

/** Run a command in the sandbox, throwing with captured output on failure. */
async function run(handle: SandboxHandle, command: string): Promise<void> {
  const res = await handle.exec(command);
  if (res.exitCode !== 0) {
    throw new Error(`command failed (exit ${res.exitCode}): ${command}\n${res.stdout}${res.stderr}`);
  }
}

/**
 * Seed the committed sample target into a bare git origin inside the sandbox.
 * After this, `ORIGIN_URL` is a clonable+pushable remote on `main`.
 */
async function seedOrigin(handle: SandboxHandle): Promise<void> {
  const dir = smokeTargetDir();
  const seed = "/tmp/recurse-seed";
  await run(handle, `rm -rf ${seed} ${ORIGIN_PATH} && mkdir -p ${seed}`);
  for (const name of readdirSync(dir)) {
    await handle.writeFile(`${seed}/${name}`, readFileSync(`${dir}/${name}`, "utf8"));
  }
  await run(handle, `git -C ${seed} init -q -b main`);
  await run(handle, `git -C ${seed} add -A`);
  await run(handle, `git -C ${seed} commit -q -m "seed: smoke target"`);
  await run(handle, `git init -q --bare ${ORIGIN_PATH}`);
  await run(handle, `git -C ${seed} remote add origin ${ORIGIN_URL}`);
  await run(handle, `git -C ${seed} push -q -u origin main`);
}

/** Build the smoke Project from the committed config, pointed at the origin. */
function smokeProject(store: MemoryStore): Promise<Project> {
  const config = loadConfig(`${smokeTargetDir()}/recurse.config.json`);
  return store.createProject({
    name: config.name,
    repoUrl: ORIGIN_URL,
    defaultBranch: config.defaultBranch,
    objective: config.objective,
    evalCommand: config.evalCommand,
    metrics: config.metrics,
    concurrency: config.concurrency,
  });
}

/** Print the cycle outcome: the Change, its metrics, and the review verdict. */
async function printSummary(store: MemoryStore, project: Project): Promise<void> {
  log("\n===== live smoke summary =====");
  const changes = await store.listChanges(project.id);
  if (changes.length === 0) {
    log("no Change was produced — the worker phase did not complete; see logs above.");
    return;
  }
  for (const change of changes) {
    log(`change ${change.id} [${change.status}] on ${change.branch}`);
    log(`  title:   ${change.title}`);
    log(`  base:    ${JSON.stringify(change.baseMetrics ?? {})}`);
    log(`  new:     ${JSON.stringify(change.newMetrics ?? {})}`);
    for (const review of await store.listReviews(change.id)) {
      log(`  review:  ${review.verdict} — ${review.summary.split("\n")[0]}`);
    }
  }
  log("==============================");
}

async function main(): Promise<void> {
  const env = sandboxEnv();
  if (!process.env.DAYTONA_API_KEY || !env.ANTHROPIC_API_KEY) {
    log("Live smoke is opt-in and requires real credentials. Skipping (exit 0).");
    log("");
    log("To run it, set these env vars and re-run `npm run smoke`:");
    log("  DAYTONA_API_KEY    — provisions the sandbox from the recurse snapshot");
    log("  ANTHROPIC_API_KEY  — the model key `pi` uses inside the sandbox");
    log("Optional: RECURSE_SNAPSHOT (snapshot name), RECURSE_PI_MODEL (pi --model).");
    return;
  }

  const daytona = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL,
    target: process.env.DAYTONA_TARGET,
  });

  log("[smoke] ensuring agent snapshot…");
  const snapshot = await ensureSnapshot(daytona.snapshot, undefined, undefined, {
    onLogs: (chunk) => process.stderr.write(chunk),
  });
  log(`[smoke] snapshot: ${snapshot}`);

  log("[smoke] provisioning sandbox…");
  const realRunner = new DaytonaSandboxRunner();
  const handle = await realRunner.create({ snapshot, envVars: env });
  try {
    log(`[smoke] sandbox: ${handle.id}`);
    log("[smoke] seeding sample target into bare origin…");
    await seedOrigin(handle);

    const store = new MemoryStore();
    const project = await smokeProject(store);
    const task = await store.createTask({
      projectId: project.id,
      kind: "improve",
      title: "Fix the failing subtract test",
      prompt:
        "A unit test is failing. Fix the implementation in index.mjs so all " +
        "tests pass. Do NOT modify, weaken, or delete any test. Then commit.",
      priority: 0,
      source: "human",
    });

    log("[smoke] running one real improvement cycle (worker → review → gate)…");
    const outcome = await runCycle(
      {
        store,
        runner: new SharedSandboxRunner(handle, WORKDIR),
        workerInvoker: new PiAgentInvoker(),
        reviewerInvoker: new PiAgentInvoker(),
        sandboxEnv,
        logger: (line) => process.stderr.write(`[cycle] ${line}\n`),
        options: { workdir: WORKDIR },
      },
      project,
      task,
    );

    await printSummary(store, project);
    log(outcome?.merged ? `\n✅ merged: ${outcome.reason}` : `\n❌ not merged: ${outcome?.reason}`);
  } finally {
    log("[smoke] disposing sandbox…");
    await handle.dispose();
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
