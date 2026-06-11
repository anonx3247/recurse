/**
 * Real autonomous entrypoint: load a `recurse.config.json`, upsert the project
 * into a persistent {@link PgStore}, and start the {@link Kernel} with the real
 * sandbox runner + `pi` agent invoker for both roles.
 *
 * Usage: `npm start <configPath>`
 *
 * This needs `DATABASE_URL` (Postgres) and provider keys (e.g.
 * `ANTHROPIC_API_KEY`) and, for real sandboxes, `DAYTONA_API_KEY`. It is
 * deliberately NOT exercised in tests.
 */

import { PiAgentInvoker } from "../agent/index";
import { loadConfig } from "../core/index";
import type { Project } from "../core/types";
import { Kernel } from "../kernel/index";
import { getSandboxRunner } from "../sandbox/index";
import { PgStore } from "../store/index";
import type { Store } from "../store/index";

/** Provider/model env vars forwarded into every sandbox, read from the host. */
const SANDBOX_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "RECURSE_PI_MODEL",
] as const;

/** Collect the configured provider keys from the host process environment. */
function sandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SANDBOX_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

/** Find an existing project by name, or create one from the loaded config. */
async function upsertProject(store: Store, configPath: string): Promise<Project> {
  const config = loadConfig(configPath);
  const existing = (await store.listProjects()).find((p) => p.name === config.name);
  if (existing) return existing;
  return store.createProject({
    name: config.name,
    repoUrl: config.repoUrl,
    defaultBranch: config.defaultBranch,
    objective: config.objective,
    evalCommand: config.evalCommand,
    metrics: config.metrics,
    concurrency: config.concurrency,
  });
}

async function main(): Promise<void> {
  const [configPath] = process.argv.slice(2);
  if (!configPath) {
    process.stderr.write("usage: npm start <configPath>\n");
    process.exit(2);
  }

  const store = await PgStore.fromDatabaseUrl();
  const project = await upsertProject(store, configPath);

  const kernel = new Kernel({
    store,
    runner: getSandboxRunner(),
    workerInvoker: new PiAgentInvoker(),
    reviewerInvoker: new PiAgentInvoker(),
    sandboxEnv,
    logger: (line) => process.stderr.write(`[kernel] ${line}\n`),
  });

  const shutdown = () => kernel.stop();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.stderr.write(`[kernel] starting project "${project.name}" (${project.id})\n`);
  await kernel.start(project.id);
  await store.close();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
