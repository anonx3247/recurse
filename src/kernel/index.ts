/**
 * Public entry point for the kernel.
 *
 * Re-exports the {@link Kernel} loop, the pure merge-gate functions, and the
 * scheduler. The CLI (`src/cli/run.ts`) and the dashboard (PR #5) compose these
 * with the store, sandbox runner, and agent invokers.
 */

export * from "./kernel.js";
export * from "./mergeGate.js";
export * from "./scheduler.js";
