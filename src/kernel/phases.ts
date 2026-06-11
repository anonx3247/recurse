/**
 * Pure cycle phases — the business logic of one improvement cycle, extracted
 * from any scheduling concern (see ARCHITECTURE.md "Data flow of one
 * improvement cycle").
 *
 * Each phase is a plain async function over {@link CycleDeps}: it can be called
 * directly (fully offline tests with a {@link MemoryStore} + {@link
 * LocalSandboxRunner} + {@link FakeAgentInvoker}) OR wrapped in a durable
 * `ctx.step` by the Absurd task handler (see `tasks.ts`). The kernel never
 * re-implements this logic; it only chooses how to drive it.
 */

import { setTimeout as delay } from "node:timers/promises";
import {
  type AgentInvoker,
  type ChangeOutcome,
  type PushBranch,
  runIdeator,
  runReviewer,
  runWorker,
} from "../agent/index";
import type { Change, Project, Review, Task } from "../core/types";
import type { SandboxRunner } from "../sandbox/index";
import type { Store } from "../store/index";
import { type GatePolicy, compareMetrics, defaultGatePolicy, evaluateGate } from "./mergeGate";

/** Wall-clock seam, injectable so tests stay instant and deterministic. */
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

/** Tunable cycle behavior shared by the phase functions. */
export interface PhaseOptions {
  /** Merge-gate metric policy. Defaults to {@link defaultGatePolicy}. */
  gatePolicy?: GatePolicy;
  /** Max review→worker feedback iterations per lineage. Default 3. */
  maxReviewIterations?: number;
  /** How many ideas the ideator proposes per run. Default 3. */
  ideasPerRun?: number;
  /** Recent change outcomes to summarize for the ideator. Default 5. */
  ideatorHistoryLimit?: number;
  /** Max open (queued/running) ideator tasks before skipping the ideator. Default 6. */
  maxOpenIdeatorTasks?: number;
  /** Sandbox snapshot to start agents from (production: the recurse snapshot). */
  snapshot?: string;
  /** Repo checkout dir inside the sandbox. Defaults to the runner's default. */
  workdir?: string;
  /** How a worker pushes its branch; defaults to a real `git push`. Tests no-op it. */
  push?: PushBranch;
}

/** Everything a cycle needs, injected so it runs offline or durably. */
export interface CycleDeps {
  store: Store;
  runner: SandboxRunner;
  /** Drives the Worker agent (production: PiAgentInvoker; tests: a fake). */
  workerInvoker: AgentInvoker;
  /** Drives the Reviewer agent. */
  reviewerInvoker: AgentInvoker;
  /**
   * Drives the Ideator agent. Optional: when absent, the scheduler's never-idle
   * seam falls back to a generic seed task instead of generated ideas.
   */
  ideatorInvoker?: AgentInvoker;
  /** Provider keys / model config injected into each sandbox at create time. */
  sandboxEnv: () => Record<string, string>;
  clock?: Clock;
  logger?: KernelLogger;
  options?: PhaseOptions;
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
  ideaGenerated: "idea.generated",
  cycleError: "cycle.error",
} as const;

/** Outcome of the merge gate, returned so the durable layer can spawn a retry. */
export interface GateOutcome {
  /** Whether the change merged and became the new baseline. */
  merged: boolean;
  /** Human-readable reason for the event log. */
  reason: string;
  /** If a review-feedback follow-up Task was enqueued, its id (for `app.spawn`). */
  followupTaskId?: string;
}

const clockOf = (d: CycleDeps): Clock => d.clock ?? systemClock;
const logOf = (d: CycleDeps): KernelLogger => d.logger ?? (() => {});

/** Append an event to the store's append-only log. */
function emit(store: Store, projectId: string, type: string, payload: unknown): Promise<unknown> {
  return store.appendEvent({ projectId, type, payload });
}

/**
 * Worker phase: run the agent, persist the draft Change + metric samples + the
 * worker AgentRun. Returns the created Change.
 */
export async function runWorkerPhase(
  deps: CycleDeps,
  project: Project,
  task: Task,
): Promise<Change> {
  const { store } = deps;
  const clock = clockOf(deps);
  const baseMetrics = await currentBaseline(store, project.id);

  const run = await store.createAgentRun({
    projectId: project.id,
    taskId: task.id,
    role: "worker",
    status: "running",
  });

  try {
    const result = await runWorker({
      runner: deps.runner,
      invoker: deps.workerInvoker,
      project,
      task,
      env: deps.sandboxEnv(),
      snapshot: deps.options?.snapshot,
      workdir: deps.options?.workdir,
      push: deps.options?.push,
    });

    const change = await store.createChange({
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
      await store.recordMetricSample({
        projectId: project.id,
        changeId: change.id,
        metricKey,
        value,
      });
    }

    await store.updateAgentRun(run.id, {
      status: "succeeded",
      endedAt: clock.now(),
      changeId: change.id,
      sandboxId: result.handleId,
    });
    await emit(store, project.id, KernelEvents.workerDone, {
      taskId: task.id,
      changeId: change.id,
    });
    await emit(store, project.id, KernelEvents.changeCreated, {
      changeId: change.id,
      branch: change.branch,
      newMetrics: result.metrics,
    });
    return change;
  } catch (err) {
    await store.updateAgentRun(run.id, { status: "failed", endedAt: clock.now() });
    throw err;
  }
}

/**
 * Ideator phase: run the Ideator agent (its own `ideator` AgentRun), then persist
 * each proposed idea as a queued `improve` Task (source `ideator`) and emit an
 * `idea.generated` event per task. Returns the created tasks so the durable layer
 * can spawn a cycle for each. Requires {@link CycleDeps.ideatorInvoker}.
 */
export async function runIdeatorPhase(deps: CycleDeps, project: Project): Promise<Task[]> {
  const { store } = deps;
  const clock = clockOf(deps);
  if (!deps.ideatorInvoker) return [];

  const baseline = await currentBaseline(store, project.id);
  const historyLimit = deps.options?.ideatorHistoryLimit ?? 5;
  const recentChanges = await recentOutcomes(store, project.id, historyLimit);
  const pointers = (await store.listPointers(project.id, { consumed: false })).map((p) => p.body);

  const run = await store.createAgentRun({ projectId: project.id, role: "ideator", status: "running" });
  try {
    const result = await runIdeator({
      runner: deps.runner,
      invoker: deps.ideatorInvoker,
      project,
      baseline,
      recentChanges,
      pointers,
      count: deps.options?.ideasPerRun ?? 3,
      env: deps.sandboxEnv(),
      snapshot: deps.options?.snapshot,
      workdir: deps.options?.workdir,
    });

    const tasks: Task[] = [];
    for (const idea of result.ideas) {
      const task = await store.createTask({
        projectId: project.id,
        kind: "improve",
        title: idea.title,
        prompt: idea.prompt,
        priority: idea.priority,
        source: "ideator",
      });
      await emit(store, project.id, KernelEvents.ideaGenerated, {
        taskId: task.id,
        title: task.title,
        priority: task.priority,
      });
      tasks.push(task);
    }

    await store.updateAgentRun(run.id, {
      status: "succeeded",
      endedAt: clock.now(),
      sandboxId: result.handleId,
    });
    return tasks;
  } catch (err) {
    await store.updateAgentRun(run.id, { status: "failed", endedAt: clock.now() });
    throw err;
  }
}

/** Summarize a project's most recent change outcomes (newest last) for the ideator. */
async function recentOutcomes(
  store: Store,
  projectId: string,
  limit: number,
): Promise<ChangeOutcome[]> {
  const changes = await store.listChanges(projectId);
  return changes.slice(-limit).map((c) => ({
    title: c.title,
    status: c.status,
    newMetrics: c.newMetrics,
  }));
}

/** Review phase: set the change in_review, run the reviewer, persist the Review. */
export async function runReviewPhase(
  deps: CycleDeps,
  project: Project,
  change: Change,
): Promise<Review> {
  const { store } = deps;
  const clock = clockOf(deps);
  await store.updateChange(change.id, { status: "in_review" });

  const run = await store.createAgentRun({
    projectId: project.id,
    taskId: change.taskId,
    changeId: change.id,
    role: "reviewer",
    status: "running",
  });

  try {
    const result = await runReviewer({
      runner: deps.runner,
      invoker: deps.reviewerInvoker,
      project,
      change,
      diff: "",
      env: deps.sandboxEnv(),
      snapshot: deps.options?.snapshot,
      workdir: deps.options?.workdir,
    });

    await store.updateAgentRun(run.id, {
      status: "succeeded",
      endedAt: clock.now(),
      sandboxId: result.handleId,
    });
    const review = await store.createReview({
      changeId: change.id,
      reviewerRunId: run.id,
      verdict: result.verdict,
      summary: result.summary,
      comments: result.comments,
    });
    await emit(store, project.id, KernelEvents.reviewDone, {
      changeId: change.id,
      verdict: review.verdict,
    });
    return review;
  } catch (err) {
    await store.updateAgentRun(run.id, { status: "failed", endedAt: clock.now() });
    throw err;
  }
}

/**
 * Merge gate: decide whether the change merges. On merge, set it `merged` (the
 * baseline derives from the latest merged change). Otherwise set it
 * `rejected`/`abandoned`; if the review requested changes and the lineage is
 * under the retry cap, enqueue a follow-up Task and return its id so the durable
 * layer can spawn another cycle.
 */
export async function runGate(
  deps: CycleDeps,
  project: Project,
  task: Task,
  change: Change,
  review: Review,
): Promise<GateOutcome> {
  const { store } = deps;
  const comparison = compareMetrics(project.metrics, change.baseMetrics, change.newMetrics ?? {});
  const decision = evaluateGate({
    review,
    comparison,
    policy: deps.options?.gatePolicy ?? defaultGatePolicy,
  });

  if (decision.merge) {
    await store.updateChange(change.id, { status: "merged" });
    await emit(store, project.id, KernelEvents.changeMerged, {
      changeId: change.id,
      reason: decision.reason,
      newMetrics: change.newMetrics,
    });
    return { merged: true, reason: decision.reason };
  }

  const requestedChanges = review.verdict === "request_changes";
  await store.updateChange(change.id, { status: requestedChanges ? "rejected" : "abandoned" });
  await emit(store, project.id, KernelEvents.changeRejected, {
    changeId: change.id,
    reason: decision.reason,
  });

  if (!requestedChanges) return { merged: false, reason: decision.reason };

  const maxIterations = deps.options?.maxReviewIterations ?? 3;
  if ((await lineageDepth(store, change)) >= maxIterations) {
    logOf(deps)(`max review iterations reached for change ${change.id}; not enqueuing follow-up`);
    return { merged: false, reason: decision.reason };
  }

  const followup = await store.createTask({
    projectId: project.id,
    kind: "improve",
    title: `Address review feedback: ${change.title}`,
    prompt: buildFollowupPrompt(task, review),
    priority: task.priority + 1,
    source: "review",
    parentChangeId: change.id,
  });
  await emit(store, project.id, KernelEvents.followupEnqueued, {
    taskId: followup.id,
    parentChangeId: change.id,
  });
  return { merged: false, reason: decision.reason, followupTaskId: followup.id };
}

/**
 * Run one full cycle in-process (worker → review → gate), persisting state and
 * events and handling task status. Used directly by offline tests; the durable
 * Absurd handler runs the same phases wrapped in checkpoint steps instead.
 * Never throws: a failure marks the task failed and emits `cycle.error`.
 */
export async function runCycle(
  deps: CycleDeps,
  project: Project,
  task: Task,
): Promise<GateOutcome | undefined> {
  const { store } = deps;
  await store.updateTaskStatus(task.id, "running");
  await emit(store, project.id, KernelEvents.taskStarted, { taskId: task.id, kind: task.kind });

  try {
    const change = await runWorkerPhase(deps, project, task);
    const review = await runReviewPhase(deps, project, change);
    const outcome = await runGate(deps, project, task, change, review);
    await store.updateTaskStatus(task.id, "done");
    return outcome;
  } catch (err) {
    await store.updateTaskStatus(task.id, "failed");
    const message = err instanceof Error ? err.message : String(err);
    logOf(deps)(`cycle error for task ${task.id}: ${message}`);
    await emit(store, project.id, KernelEvents.cycleError, { taskId: task.id, error: message });
    return undefined;
  }
}

/**
 * The project's current baseline metrics: those of the most recently merged
 * change, or `undefined` before anything has merged. With no baseline the
 * metric portion of the gate passes (the first merged change sets the baseline).
 */
export async function currentBaseline(
  store: Store,
  projectId: string,
): Promise<Record<string, number> | undefined> {
  const merged = (await store.listChanges(projectId)).filter((c) => c.status === "merged");
  return merged.length ? merged[merged.length - 1].newMetrics : undefined;
}

/**
 * How many review→worker iterations a change is into its lineage, by walking
 * the `parentChangeId` chain. A fresh (scheduler/idea) change is depth 0; each
 * follow-up adds one. Used to cap the feedback loop.
 */
export async function lineageDepth(store: Store, change: Change): Promise<number> {
  let depth = 0;
  let current: Change | undefined = change;
  while (current) {
    const task = await store.getTask(current.taskId);
    if (!task?.parentChangeId) break;
    depth++;
    current = await store.getChange(task.parentChangeId);
  }
  return depth;
}

/** Compose a follow-up worker prompt carrying the reviewer's feedback. */
export function buildFollowupPrompt(task: Task, review: Review): string {
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
