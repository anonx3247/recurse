/**
 * Kernel — the never-idle orchestration loop (see ARCHITECTURE.md "Kernel" and
 * "Data flow of one improvement cycle").
 *
 * For a given project the kernel keeps a concurrency pool full and runs
 * improvement cycles: pick work → run a Worker → run a Reviewer → apply the
 * merge gate. Everything is persisted to the {@link Store} and every meaningful
 * transition appends an {@link EventLogEntry} (these power the dashboard, PR #5).
 *
 * The kernel orchestrates only; all real repo work happens inside sandboxes via
 * the agent runner. It depends solely on the injected seams, so it runs fully
 * offline in tests with a {@link MemoryStore}, {@link LocalSandboxRunner}, and
 * {@link FakeAgentInvoker}s — no model, no Daytona.
 */

import { setTimeout as delay } from "node:timers/promises";
import { type AgentInvoker, type PushBranch, runReviewer, runWorker } from "../agent/index.js";
import type { Change, Project, Review, Task } from "../core/types.js";
import type { SandboxRunner } from "../sandbox/index.js";
import type { Store } from "../store/index.js";
import { type GatePolicy, compareMetrics, defaultGatePolicy, evaluateGate } from "./mergeGate.js";
import { ensureWork, pickNextTask } from "./scheduler.js";

/** Wall-clock + sleep seam, injectable so tests stay instant and deterministic. */
export interface Clock {
  now(): string;
  sleep(ms: number): Promise<void>;
}

/** Default clock: real time and real timers. */
export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  sleep: (ms) => delay(ms),
};

/** Structured kernel log line. */
export type KernelLogger = (line: string) => void;

/** Construction dependencies for a {@link Kernel}. */
export interface KernelDeps {
  store: Store;
  runner: SandboxRunner;
  /** Drives the Worker agent (production: PiAgentInvoker; tests: a fake). */
  workerInvoker: AgentInvoker;
  /** Drives the Reviewer agent. */
  reviewerInvoker: AgentInvoker;
  /** Provider keys / model config injected into each sandbox at create time. */
  sandboxEnv: () => Record<string, string>;
  clock?: Clock;
  logger?: KernelLogger;
  options?: KernelOptions;
}

/** Tunable kernel behavior. */
export interface KernelOptions {
  /** Merge-gate metric policy. Defaults to {@link defaultGatePolicy}. */
  gatePolicy?: GatePolicy;
  /** Max review→worker feedback iterations per lineage. Default 3. */
  maxReviewIterations?: number;
  /** Delay when the pool is genuinely empty. Default 250ms; set 0 in tests. */
  idleDelayMs?: number;
  /** Sandbox snapshot to start agents from (production: the recurse snapshot). */
  snapshot?: string;
  /** Repo checkout dir inside the sandbox. Defaults to the runner's default. */
  workdir?: string;
  /** How a worker pushes its branch; defaults to a real `git push`. Tests no-op it. */
  push?: PushBranch;
}

/** Event-log type strings the kernel emits (the dashboard keys off these). */
export const KernelEvents = {
  taskStarted: "task.started",
  workerDone: "worker.done",
  changeCreated: "change.created",
  reviewDone: "review.done",
  changeMerged: "change.merged",
  changeRejected: "change.rejected",
  followupEnqueued: "followup.enqueued",
  cycleError: "cycle.error",
} as const;

export class Kernel {
  private readonly clock: Clock;
  private readonly log: KernelLogger;
  private readonly options: Required<Pick<KernelOptions, "maxReviewIterations" | "idleDelayMs">> &
    KernelOptions;
  private running = false;

  constructor(private readonly deps: KernelDeps) {
    this.clock = deps.clock ?? systemClock;
    this.log = deps.logger ?? (() => {});
    this.options = {
      gatePolicy: deps.options?.gatePolicy ?? defaultGatePolicy,
      maxReviewIterations: deps.options?.maxReviewIterations ?? 3,
      idleDelayMs: deps.options?.idleDelayMs ?? 250,
      snapshot: deps.options?.snapshot,
      workdir: deps.options?.workdir,
      push: deps.options?.push,
    };
  }

  /**
   * Start the loop for `projectId`, keeping up to `project.concurrency` cycles
   * in flight until {@link stop} is called. Pass `maxCycles` to bound the run
   * (used by tests); each started cycle counts toward the bound.
   */
  async start(projectId: string, opts: { maxCycles?: number } = {}): Promise<void> {
    const project = this.requireProject(projectId);
    this.running = true;
    const inFlight = new Set<Promise<void>>();
    let started = 0;

    while (this.running) {
      while (
        this.running &&
        inFlight.size < project.concurrency &&
        (opts.maxCycles === undefined || started < opts.maxCycles)
      ) {
        started++;
        const p = this.runCycle(projectId).finally(() => inFlight.delete(p));
        inFlight.add(p);
      }
      if (opts.maxCycles !== undefined && started >= opts.maxCycles && inFlight.size === 0) break;
      if (inFlight.size === 0) await this.clock.sleep(this.options.idleDelayMs);
      else await Promise.race(inFlight);
    }
    await Promise.allSettled(inFlight);
  }

  /** Stop scheduling new cycles; in-flight cycles still run to completion. */
  stop(): void {
    this.running = false;
  }

  /**
   * Run exactly one improvement cycle: pick (or seed) work, run the worker,
   * run the reviewer, and apply the merge gate. Exposed for deterministic
   * testing. A failure marks the task/run failed and emits `cycle.error`; it
   * never throws, so one bad cycle never crashes the kernel.
   */
  async runCycle(projectId: string): Promise<void> {
    const { store } = this.deps;
    const project = this.requireProject(projectId);

    ensureWork(store, project);
    const task = pickNextTask(store, projectId);
    if (!task) return;

    store.updateTaskStatus(task.id, "running");
    this.emit(projectId, KernelEvents.taskStarted, { taskId: task.id, kind: task.kind });

    try {
      const change = await this.workerPhase(project, task);
      const review = await this.reviewPhase(project, change);
      this.applyGate(project, task, change, review);
      store.updateTaskStatus(task.id, "done");
    } catch (err) {
      store.updateTaskStatus(task.id, "failed");
      const message = err instanceof Error ? err.message : String(err);
      this.log(`cycle error for task ${task.id}: ${message}`);
      this.emit(projectId, KernelEvents.cycleError, { taskId: task.id, error: message });
    }
  }

  /** Worker phase: run the agent, persist the draft Change + metric samples. */
  private async workerPhase(project: Project, task: Task): Promise<Change> {
    const { store } = this.deps;
    const baseMetrics = currentBaseline(store, project.id);

    const run = store.createAgentRun({
      projectId: project.id,
      taskId: task.id,
      role: "worker",
      status: "running",
    });

    try {
      const result = await runWorker({
        runner: this.deps.runner,
        invoker: this.deps.workerInvoker,
        project,
        task,
        env: this.deps.sandboxEnv(),
        snapshot: this.options.snapshot,
        workdir: this.options.workdir,
        push: this.options.push,
      });

      const change = store.createChange({
        projectId: project.id,
        taskId: task.id,
        branch: result.branch,
        title: result.commitSubject || task.title,
        summary: result.changedFiles.length
          ? `Changed files: ${result.changedFiles.join(", ")}`
          : "No files changed.",
        status: "draft",
        baseMetrics,
        newMetrics: result.metrics,
      });

      for (const [metricKey, value] of Object.entries(result.metrics)) {
        store.recordMetricSample({ projectId: project.id, changeId: change.id, metricKey, value });
      }

      store.updateAgentRun(run.id, {
        status: "succeeded",
        endedAt: this.clock.now(),
        changeId: change.id,
        sandboxId: result.handleId,
      });
      this.emit(project.id, KernelEvents.workerDone, { taskId: task.id, changeId: change.id });
      this.emit(project.id, KernelEvents.changeCreated, {
        changeId: change.id,
        branch: change.branch,
        newMetrics: result.metrics,
      });
      return change;
    } catch (err) {
      store.updateAgentRun(run.id, { status: "failed", endedAt: this.clock.now() });
      throw err;
    }
  }

  /** Review phase: run the reviewer agent, persist the Review, set in_review. */
  private async reviewPhase(project: Project, change: Change): Promise<Review> {
    const { store } = this.deps;
    store.updateChange(change.id, { status: "in_review" });

    const run = store.createAgentRun({
      projectId: project.id,
      taskId: change.taskId,
      changeId: change.id,
      role: "reviewer",
      status: "running",
    });

    try {
      const result = await runReviewer({
        runner: this.deps.runner,
        invoker: this.deps.reviewerInvoker,
        project,
        change,
        diff: "",
        env: this.deps.sandboxEnv(),
        snapshot: this.options.snapshot,
        workdir: this.options.workdir,
      });

      store.updateAgentRun(run.id, {
        status: "succeeded",
        endedAt: this.clock.now(),
        sandboxId: result.handleId,
      });
      const review = store.createReview({
        changeId: change.id,
        reviewerRunId: run.id,
        verdict: result.verdict,
        summary: result.summary,
        comments: result.comments,
      });
      this.emit(project.id, KernelEvents.reviewDone, {
        changeId: change.id,
        verdict: review.verdict,
      });
      return review;
    } catch (err) {
      store.updateAgentRun(run.id, { status: "failed", endedAt: this.clock.now() });
      throw err;
    }
  }

  /** Apply the merge gate, update baseline on merge, loop feedback on changes. */
  private applyGate(project: Project, task: Task, change: Change, review: Review): void {
    const { store } = this.deps;
    const comparison = compareMetrics(project.metrics, change.baseMetrics, change.newMetrics ?? {});
    const decision = evaluateGate({ review, comparison, policy: this.options.gatePolicy });

    if (decision.merge) {
      // The project baseline derives from the latest merged change, so merging
      // automatically raises the bar for the next cycle.
      store.updateChange(change.id, { status: "merged" });
      this.emit(project.id, KernelEvents.changeMerged, {
        changeId: change.id,
        reason: decision.reason,
        newMetrics: change.newMetrics,
      });
      return;
    }

    const requestedChanges = review.verdict === "request_changes";
    store.updateChange(change.id, { status: requestedChanges ? "rejected" : "abandoned" });
    this.emit(project.id, KernelEvents.changeRejected, {
      changeId: change.id,
      reason: decision.reason,
    });

    if (requestedChanges) this.enqueueFollowup(project, task, change, review);
  }

  /** Loop reviewer feedback back to a worker, capped per lineage. */
  private enqueueFollowup(project: Project, task: Task, change: Change, review: Review): void {
    const { store } = this.deps;
    if (lineageDepth(store, change) >= this.options.maxReviewIterations) {
      this.log(`max review iterations reached for change ${change.id}; not enqueuing follow-up`);
      return;
    }

    const followup = store.createTask({
      projectId: project.id,
      kind: "improve",
      title: `Address review feedback: ${change.title}`,
      prompt: buildFollowupPrompt(task, review),
      priority: task.priority + 1,
      source: "review",
      parentChangeId: change.id,
    });
    this.emit(project.id, KernelEvents.followupEnqueued, {
      taskId: followup.id,
      parentChangeId: change.id,
    });
  }

  private requireProject(projectId: string): Project {
    const project = this.deps.store.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }

  private emit(projectId: string, type: string, payload: unknown): void {
    this.deps.store.appendEvent({ projectId, type, payload });
  }
}

/**
 * The project's current baseline metrics: those of the most recently merged
 * change, or `undefined` before anything has merged. With no baseline the
 * metric portion of the gate passes (the first merged change sets the baseline).
 */
export function currentBaseline(
  store: Store,
  projectId: string,
): Record<string, number> | undefined {
  const merged = store.listChanges(projectId).filter((c) => c.status === "merged");
  return merged.length ? merged[merged.length - 1].newMetrics : undefined;
}

/**
 * How many review→worker iterations a change is into its lineage, by walking
 * the `parentChangeId` chain. A fresh (scheduler/idea) change is depth 0; each
 * follow-up adds one. Used to cap the feedback loop.
 */
function lineageDepth(store: Store, change: Change): number {
  let depth = 0;
  let current: Change | undefined = change;
  while (current) {
    const task = store.getTask(current.taskId);
    if (!task?.parentChangeId) break;
    depth++;
    current = store.getChange(task.parentChangeId);
  }
  return depth;
}

/** Compose a follow-up worker prompt carrying the reviewer's feedback. */
function buildFollowupPrompt(task: Task, review: Review): string {
  const comments = review.comments.length
    ? review.comments
        .map((c) => {
          const loc = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ""})` : "";
          return `- [${c.severity}]${loc} ${c.body}`;
        })
        .join("\n")
    : "(no inline comments)";

  return `A previous change was reviewed and needs changes before it can land.

REVIEWER SUMMARY
${review.summary}

REVIEWER COMMENTS
${comments}

ORIGINAL TASK
${task.prompt}

Address the reviewer's feedback and re-attempt the improvement.`;
}
