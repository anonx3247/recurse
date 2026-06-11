/**
 * Scheduler — the never-idle guarantee (see ARCHITECTURE.md "Kernel").
 *
 * The kernel must always have work. {@link ensureWork} seeds a generic `improve`
 * task whenever the queue is empty, so a freed pool slot never stalls. This is
 * deliberately minimal; the richer **Ideator** agent (a later PR) will replace
 * the fallback prompt with history/metric-trend-aware ideas at the marked seam.
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

  // SEAM: a later PR plugs the Ideator agent in here to generate richer,
  // history-aware tasks. Until then we seed a generic high-leverage improvement
  // (optionally steered by human pointers) so the kernel never idles.
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
