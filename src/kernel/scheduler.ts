/**
 * Scheduler — the never-idle guarantee (see ARCHITECTURE.md "Kernel").
 *
 * The kernel must always have work. {@link ensureWork} seeds a generic `improve`
 * task whenever the queue is empty, so a freed pool slot never stalls. This is
 * deliberately minimal; the richer **Ideator** agent (a later PR) will replace
 * the fallback prompt with history/metric-trend-aware ideas at the marked seam.
 */

import type { Project, Task } from "../core/types.js";
import type { Store } from "../store/index.js";

/**
 * Guarantee there is at least one `queued` task for `project`. If the queue is
 * non-empty this is a no-op (returns `undefined`); otherwise it creates and
 * returns a fallback `improve` task derived from the objective.
 */
export function ensureWork(store: Store, project: Project): Task | undefined {
  const queued = store.listTasks(project.id, { status: "queued" });
  if (queued.length > 0) return undefined;

  // SEAM: a later PR plugs the Ideator agent in here to generate richer,
  // history-aware tasks. Until then we seed a generic high-leverage improvement
  // so the kernel never idles.
  return store.createTask({
    projectId: project.id,
    kind: "improve",
    title: "Scheduled improvement",
    prompt: `Make one focused improvement toward: ${project.objective}. Prefer the highest-leverage change and keep the diff small.`,
    priority: 0,
    source: "scheduler",
  });
}

/**
 * Pick the next task to run: the highest-priority `queued` task, breaking ties
 * by creation order (oldest first). Returns `undefined` when the queue is empty.
 */
export function pickNextTask(store: Store, projectId: string): Task | undefined {
  const queued = store.listTasks(projectId, { status: "queued" });
  if (queued.length === 0) return undefined;
  return [...queued].sort(
    (a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
  )[0];
}
