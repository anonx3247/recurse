/**
 * Public entry point for the kernel.
 *
 * Re-exports the durable {@link Kernel} shell, the pure cycle phases + merge
 * gate, the Absurd bootstrap, the durable task registrations, the scheduler,
 * and the non-blocking human-in-the-loop. The CLI (`src/cli/run.ts`) and the
 * dashboard (PR #5) compose these with the store, sandbox runner, and invokers.
 */

export * from "./kernel";
export * from "./phases";
export * from "./mergeGate";
export * from "./scheduler";
export * from "./absurd";
export * from "./tasks";
export * from "./human";
