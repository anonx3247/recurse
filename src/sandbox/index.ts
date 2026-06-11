/**
 * Public entry point for the sandbox runner.
 *
 * Consumers (kernel, agent-runner) import the {@link SandboxRunner} interface
 * and {@link getSandboxRunner} from here — never a concrete backend.
 */

export * from "./runner.js";
export { LocalSandboxRunner } from "./local.js";
export { DaytonaSandboxRunner } from "./daytona.js";

import { DaytonaSandboxRunner } from "./daytona.js";
import { LocalSandboxRunner } from "./local.js";
import type { SandboxRunner } from "./runner.js";

/**
 * Select a sandbox backend from the environment: Daytona when
 * `DAYTONA_API_KEY` is set, otherwise the offline local runner. The chosen
 * backend is logged to stderr.
 */
export function getSandboxRunner(): SandboxRunner {
  const runner: SandboxRunner = process.env.DAYTONA_API_KEY
    ? new DaytonaSandboxRunner()
    : new LocalSandboxRunner();
  process.stderr.write(`[sandbox] using "${runner.backend}" backend\n`);
  return runner;
}
