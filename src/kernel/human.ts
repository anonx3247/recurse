/**
 * Non-blocking human-in-the-loop (see ARCHITECTURE.md "Human-in-the-loop").
 *
 * A task can ask the human a question and durably suspend until it is answered —
 * WITHOUT holding a worker slot. {@link askHuman} persists a `Question` then
 * `ctx.awaitEvent`s on a per-question channel; the Absurd run suspends (the slot
 * frees for other work) and resumes when {@link answerQuestion} emits the event.
 * The PR #5 dashboard calls {@link answerQuestion}.
 */

import type { Absurd, TaskContext } from "absurd-sdk";
import type { Store } from "../store/index";

/** The event channel a question is answered on. */
export const answerEvent = (questionId: string): string => `answer:${questionId}`;

/** Options for {@link askHuman}. */
export interface AskHumanOptions {
  /** Seconds to wait before giving up (undefined = wait indefinitely). */
  timeout?: number;
}

/**
 * Persist an open `Question` and durably suspend the current task until a human
 * answers it (or the optional timeout elapses). Returns the answer string.
 *
 * Suspension is checkpointed by Absurd, so this does not block the worker — the
 * slot is released and the run resumes on the emitted answer event.
 */
export async function askHuman(
  ctx: TaskContext,
  store: Store,
  projectId: string,
  body: string,
  options: AskHumanOptions = {},
): Promise<string> {
  const question = await store.createQuestion({ projectId, body });
  const payload = (await ctx.awaitEvent(answerEvent(question.id), {
    timeout: options.timeout,
  })) as { answer?: string } | null;
  return payload?.answer ?? "";
}

/**
 * Record a human's answer and wake any task awaiting it. Idempotent on the
 * store side; the event is first-write-wins on the Absurd side.
 */
export async function answerQuestion(
  app: Absurd,
  store: Store,
  questionId: string,
  answer: string,
): Promise<void> {
  await store.answerQuestion(questionId, answer);
  await app.emitEvent(answerEvent(questionId), { answer });
}
