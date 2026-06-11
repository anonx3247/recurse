/**
 * Durable task registrations — the thin Absurd shell over the pure cycle phases
 * (see ARCHITECTURE.md "Kernel"). Each phase becomes a checkpointed `ctx.step`,
 * so a crash resumes from the last completed step rather than re-running the
 * (minutes-long) sandbox work.
 *
 * Two tasks:
 * - `improve-cycle`: worker → review → gate; on review feedback it spawns a
 *   follow-up `improve-cycle` (the PR-review loop, capped in {@link runGate}).
 * - `scheduler-tick`: a self-perpetuating durable cron that sleeps, seeds work
 *   if the queue is empty, and re-spawns itself — the never-idle guarantee.
 */

import type { Absurd } from "absurd-sdk";
import type { Project } from "../core/types";
import {
  type CycleDeps,
  KernelEvents,
  runGate,
  runIdeatorPhase,
  runReviewPhase,
  runWorkerPhase,
} from "./phases";
import { type Ideator, ensureWork, ensureWorkWithIdeator } from "./scheduler";

/** Absurd task names. */
export const TASK_IMPROVE_CYCLE = "improve-cycle";
export const TASK_SCHEDULER_TICK = "scheduler-tick";

/** Params passed to an `improve-cycle` run. */
export interface CycleParams {
  projectId: string;
  taskId: string;
}

/** Options for {@link registerTasks}. */
export interface RegisterTasksOptions {
  /** Seconds the scheduler sleeps between ticks. Default 60. */
  schedulerIntervalSeconds?: number;
  /** Lease seconds requested when heartbeating around long sandbox ops. */
  heartbeatSeconds?: number;
}

/** Stable idempotency key so a store Task is only ever spawned once. */
const cycleKey = (taskId: string): string => `cycle:${taskId}`;

/**
 * Register the kernel's durable tasks on `app` for a single `project`. The
 * pure phases come from {@link CycleDeps}; this module only adds checkpointing,
 * spawning, and the never-idle cron.
 */
export function registerTasks(
  app: Absurd,
  deps: CycleDeps,
  project: Project,
  options: RegisterTasksOptions = {},
): void {
  const { store } = deps;
  const intervalSeconds = options.schedulerIntervalSeconds ?? 60;

  // Wire the Ideator into the never-idle seam only when an invoker is provided;
  // otherwise the seam falls back to a generic seed task.
  const ideator: Ideator | undefined = deps.ideatorInvoker
    ? {
        generate: (_store, proj) => runIdeatorPhase(deps, proj),
        cap: deps.options?.maxOpenIdeatorTasks,
      }
    : undefined;

  app.registerTask({ name: TASK_IMPROVE_CYCLE }, async (params: CycleParams, ctx) => {
    const task = await store.getTask(params.taskId);
    if (!task) return { skipped: "task-missing" };

    try {
      await store.updateTaskStatus(task.id, "running");
      await store.appendEvent({
        projectId: project.id,
        type: KernelEvents.taskStarted,
        payload: { taskId: task.id, kind: task.kind },
      });

      // Each phase is a checkpoint: its store side effects run once, and the
      // JSON id it returns is cached so a replay skips straight past it.
      const changeId = await ctx.step("worker", async () => {
        await ctx.heartbeat(options.heartbeatSeconds);
        const change = await runWorkerPhase(deps, project, task);
        return change.id;
      });
      const change = await store.getChange(changeId);
      if (!change) throw new Error(`Change not found after worker step: ${changeId}`);

      const reviewId = await ctx.step("review", async () => {
        await ctx.heartbeat(options.heartbeatSeconds);
        const review = await runReviewPhase(deps, project, change);
        return review.id;
      });
      const review = (await store.listReviews(changeId)).find((r) => r.id === reviewId);
      if (!review) throw new Error(`Review not found after review step: ${reviewId}`);

      const outcome = await ctx.step("gate", () => runGate(deps, project, task, change, review));

      if (outcome.followupTaskId) {
        const followupTaskId = outcome.followupTaskId;
        await ctx.step("spawn-followup", async () => {
          await app.spawn(
            TASK_IMPROVE_CYCLE,
            { projectId: project.id, taskId: followupTaskId },
            { idempotencyKey: cycleKey(followupTaskId) },
          );
          return true;
        });
      }

      await store.updateTaskStatus(task.id, "done");
      return outcome;
    } catch (err) {
      // Robust: a failing cycle marks the Task failed and emits cycle.error, but
      // never crashes the worker. The scheduler re-seeds work on the next tick.
      const message = err instanceof Error ? err.message : String(err);
      deps.logger?.(`cycle error for task ${task.id}: ${message}`);
      await store.updateTaskStatus(task.id, "failed");
      await store.appendEvent({
        projectId: project.id,
        type: KernelEvents.cycleError,
        payload: { taskId: task.id, error: message },
      });
      return { error: message };
    }
  });

  app.registerTask({ name: TASK_SCHEDULER_TICK }, async (_params: { projectId: string }, ctx) => {
    await ctx.sleepFor("wait", intervalSeconds);

    // The never-idle seam: when no improve work is queued, run the Ideator (its
    // own checkpointed step + AgentRun) to enqueue fresh tasks, else seed one.
    const seededTaskIds = await ctx.step("ensure-work", async () => {
      await ctx.heartbeat(options.heartbeatSeconds);
      const tasks = await ensureWorkWithIdeator(store, project, ideator);
      return tasks.map((t) => t.id);
    });

    if (seededTaskIds.length > 0) {
      await ctx.step("spawn-cycles", async () => {
        for (const taskId of seededTaskIds) {
          await app.spawn(
            TASK_IMPROVE_CYCLE,
            { projectId: project.id, taskId },
            { idempotencyKey: cycleKey(taskId) },
          );
        }
        return seededTaskIds.length;
      });
    }

    // Self-perpetuating durable cron: re-spawn the next tick. A fresh task id
    // each round keeps the chain going without an idempotency collision.
    await ctx.step("respawn", async () => {
      await app.spawn(TASK_SCHEDULER_TICK, { projectId: project.id });
      return true;
    });
    return { seededTaskIds };
  });
}

/**
 * Spawn the initial work for a project: seed a Task if the queue is empty,
 * spawn its `improve-cycle`, and kick off the scheduler cron. Idempotent via
 * the cycle idempotency key, so calling it twice does not double-spawn.
 */
export async function spawnInitialWork(
  app: Absurd,
  deps: CycleDeps,
  project: Project,
): Promise<void> {
  const seeded = await ensureWork(deps.store, project);
  if (seeded) {
    await app.spawn(
      TASK_IMPROVE_CYCLE,
      { projectId: project.id, taskId: seeded.id },
      { idempotencyKey: cycleKey(seeded.id) },
    );
  }
  await app.spawn(
    TASK_SCHEDULER_TICK,
    { projectId: project.id },
    { idempotencyKey: `scheduler:${project.id}` },
  );
}
