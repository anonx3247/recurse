/**
 * Scheduler — the never-idle guarantee (see ARCHITECTURE.md "Kernel").
 *
 * The kernel must always have work. {@link ensureWorkWithIdeator} is the seam the
 * scheduler-tick drives: when no `improve` work is queued it runs the **Ideator**
 * to generate several history/metric-aware tasks (capped to avoid runaway
 * generation), and only falls back to {@link ensureWork}'s single generic seed
 * when the ideator is unavailable or produced nothing — so a freed pool slot
 * never stalls.
 */

import type { Pointer, Project, Task } from "../core/types";
import type { Store } from "../store/index";

/**
 * Guarantee there is at least one `queued` task for `project`. If the queue is
 * non-empty this is a no-op (returns `undefined`); otherwise it creates and
 * returns a fallback `improve` task derived from the objective, folding any
 * unconsumed {@link Pointer} hints into the seed prompt.
 */
export async function ensureWork(store: Store, project: Project): Promise<Task | undefined> {
  const queued = await store.listTasks(project.id, { status: "queued" });
  if (queued.length > 0) return undefined;

  // The generic fallback seed: a high-leverage improvement (optionally steered
  // by human pointers) so the kernel never idles even without the ideator.
  const pointers = await store.listPointers(project.id, { consumed: false });
  return store.createTask({
    projectId: project.id,
    kind: "improve",
    title: "Scheduled improvement",
    prompt: buildSeedPrompt(project, pointers),
    priority: 0,
    source: "scheduler",
  });
}

/** Default cap on open (queued/running) ideator tasks before the ideator is skipped. */
export const DEFAULT_MAX_OPEN_IDEATOR_TASKS = 6;

/**
 * The never-idle seam the scheduler-tick drives. A {@link Ideator} hook generates
 * and persists fresh `improve` tasks; when it is provided and under its cap, and
 * there is no queued `improve` work, it runs and its created tasks are returned.
 * Otherwise this falls back to {@link ensureWork}'s single generic seed. Returns
 * the tasks to spawn cycles for (empty when work already exists).
 */
export interface Ideator {
  /** Generate and persist new `improve` tasks; returns those created. */
  generate(store: Store, project: Project): Promise<Task[]>;
  /** Max open ideator-sourced tasks allowed before skipping. */
  cap?: number;
}

export async function ensureWorkWithIdeator(
  store: Store,
  project: Project,
  ideator?: Ideator,
): Promise<Task[]> {
  const queued = await store.listTasks(project.id, { status: "queued" });
  // Don't generate when improvement work is already waiting (avoid runaway).
  if (queued.some((t) => t.kind === "improve")) return [];

  if (ideator) {
    const cap = ideator.cap ?? DEFAULT_MAX_OPEN_IDEATOR_TASKS;
    if ((await countOpenIdeatorTasks(store, project.id)) < cap) {
      const created = await ideator.generate(store, project);
      if (created.length > 0) return created;
    }
  }

  const seeded = await ensureWork(store, project);
  return seeded ? [seeded] : [];
}

/** Count ideator-sourced tasks still open (queued or running). */
async function countOpenIdeatorTasks(store: Store, projectId: string): Promise<number> {
  const open = [
    ...(await store.listTasks(projectId, { status: "queued" })),
    ...(await store.listTasks(projectId, { status: "running" })),
  ];
  return open.filter((t) => t.source === "ideator").length;
}

/** Compose the fallback seed prompt, appending any human pointer hints. */
function buildSeedPrompt(project: Project, pointers: Pointer[]): string {
  let prompt = `Make one focused improvement toward: ${project.objective}. Prefer the highest-leverage change and keep the diff small.`;
  if (pointers.length > 0) {
    const hints = pointers.map((p) => `- ${p.body}`).join("\n");
    prompt += `\n\nHuman pointers to consider:\n${hints}`;
  }
  return prompt;
}

/**
 * Pick the next task to run: the highest-priority `queued` task, breaking ties
 * by creation order (oldest first). Returns `undefined` when the queue is empty.
 */
export async function pickNextTask(store: Store, projectId: string): Promise<Task | undefined> {
  const queued = await store.listTasks(projectId, { status: "queued" });
  if (queued.length === 0) return undefined;
  return [...queued].sort(
    (a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
  )[0];
}
