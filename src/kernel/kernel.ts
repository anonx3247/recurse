/**
 * Kernel — the durable, never-idle orchestration shell (see ARCHITECTURE.md
 * "Kernel").
 *
 * The kernel runs the recursive improvement cycle on **Absurd**, a Postgres-
 * native durable workflow engine sharing the SAME Postgres (and `pg.Pool`) as
 * the {@link PgStore}. Absurd replaces a hand-rolled concurrency pool/loop:
 * - each cycle phase is a checkpointed `ctx.step` (resume after a crash),
 * - the scheduler is a self-perpetuating `sleepFor` cron (never idle),
 * - human questions suspend on `awaitEvent` without holding a worker slot.
 *
 * The pure cycle logic lives in `phases.ts` + `mergeGate.ts` and is unit-tested
 * fully offline; this shell only wires it onto Absurd.
 */

import type { Absurd } from "absurd-sdk";
import type { Pool } from "pg";
import type { AgentInvoker } from "../agent/index";
import type { SandboxRunner } from "../sandbox/index";
import type { Store } from "../store/index";
import { buildAbsurd } from "./absurd";
import type { Clock, CycleDeps, KernelLogger, PhaseOptions } from "./phases";
import { registerTasks, spawnInitialWork } from "./tasks";

/** Background worker handle returned by `Absurd.startWorker`. */
type AbsurdWorker = Awaited<ReturnType<Absurd["startWorker"]>>;

/** Construction dependencies for a {@link Kernel}. */
export interface KernelDeps {
  store: Store;
  /** The SAME `pg.Pool` the {@link PgStore} uses — one DB, one pool. */
  pool: Pool;
  runner: SandboxRunner;
  /** Drives the Worker agent (production: PiAgentInvoker). */
  workerInvoker: AgentInvoker;
  /** Drives the Reviewer agent. */
  reviewerInvoker: AgentInvoker;
  /** Drives the Ideator agent (the never-idle work generator). Optional. */
  ideatorInvoker?: AgentInvoker;
  /** Provider keys / model config injected into each sandbox at create time. */
  sandboxEnv: () => Record<string, string>;
  clock?: Clock;
  logger?: KernelLogger;
  options?: KernelOptions;
}

/** Tunable kernel behavior. */
export interface KernelOptions extends PhaseOptions {
  /** Absurd queue name. Defaults to `recurse`. */
  queueName?: string;
  /** Default retry attempts for queue tasks. */
  defaultMaxAttempts?: number;
  /**
   * Worker lease seconds. Sandbox + `pi` steps run for MINUTES, so this is
   * generous (default 1800); checkpoints + `ctx.heartbeat()` extend the lease.
   */
  claimTimeout?: number;
  /** Seconds the never-idle scheduler sleeps between ticks. Default 60. */
  schedulerIntervalSeconds?: number;
}

export class Kernel {
  private absurd?: Absurd;
  private worker?: AbsurdWorker;

  constructor(private readonly deps: KernelDeps) {}

  /** The Absurd client, available after {@link start} (e.g. for answering questions). */
  get app(): Absurd | undefined {
    return this.absurd;
  }

  /**
   * Start the durable kernel for `projectId`: bootstrap Absurd on the shared
   * pool, register the cycle + scheduler tasks, start the background worker
   * (concurrency = `project.concurrency`), and spawn the initial work + cron.
   * Returns once the worker is running; cycles execute in the background.
   */
  async start(projectId: string): Promise<void> {
    const project = await this.deps.store.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const options = this.deps.options ?? {};
    const { app } = await buildAbsurd({
      pool: this.deps.pool,
      queueName: options.queueName,
      defaultMaxAttempts: options.defaultMaxAttempts,
    });
    this.absurd = app;

    const cycleDeps: CycleDeps = {
      store: this.deps.store,
      runner: this.deps.runner,
      workerInvoker: this.deps.workerInvoker,
      reviewerInvoker: this.deps.reviewerInvoker,
      ideatorInvoker: this.deps.ideatorInvoker,
      sandboxEnv: this.deps.sandboxEnv,
      clock: this.deps.clock,
      logger: this.deps.logger,
      options,
    };

    registerTasks(app, cycleDeps, project, {
      schedulerIntervalSeconds: options.schedulerIntervalSeconds,
    });

    this.worker = await app.startWorker({
      concurrency: project.concurrency,
      claimTimeout: options.claimTimeout ?? 1800,
    });

    await spawnInitialWork(app, cycleDeps, project);
  }

  /**
   * Gracefully stop scheduling and let in-flight work settle: close the
   * background worker and the Absurd client. The shared `pg.Pool` is owned by
   * the caller (closed via `store.close()`), so it is NOT closed here.
   */
  async stop(): Promise<void> {
    await this.worker?.close();
    await this.absurd?.close();
    this.worker = undefined;
    this.absurd = undefined;
  }
}
