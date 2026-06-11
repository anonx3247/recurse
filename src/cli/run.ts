/**
 * Real autonomous entrypoint: load a `recurse.config.json`, build ONE shared
 * `pg.Pool` from `DATABASE_URL`, hand it to both the {@link PgStore} and the
 * {@link Kernel} (so the domain store and the Absurd durable queue share one
 * database + pool), upsert the Project, and start the kernel.
 *
 * Usage: `npm start <configPath>`
 *
 * Needs `DATABASE_URL` (Postgres) and provider keys (e.g. `ANTHROPIC_API_KEY`);
 * real sandboxes also need `DAYTONA_API_KEY`. Deliberately NOT exercised in
 * tests (no DB / model / keys there).
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { PiAgentInvoker } from "../agent/index";
import { loadConfig } from "../core/index";
import type { Project } from "../core/types";
import { Kernel } from "../kernel/index";
import { getSandboxRunner } from "../sandbox/index";
import * as schema from "../store/schema";
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

/** Resolve when the process receives SIGINT/SIGTERM. */
function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => resolve();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function main(): Promise<void> {
  const [configPath] = process.argv.slice(2);
  if (!configPath) {
    process.stderr.write("usage: npm start <configPath>\n");
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  // One pool, shared by the store and the Absurd queue.
  const pool = new Pool({ connectionString: databaseUrl });
  const store = await PgStore.fromDrizzle(drizzle(pool, { schema }), () => pool.end());
  const project = await upsertProject(store, configPath);

  const kernel = new Kernel({
    store,
    pool,
    runner: getSandboxRunner(),
    workerInvoker: new PiAgentInvoker(),
    reviewerInvoker: new PiAgentInvoker(),
    sandboxEnv,
    logger: (line) => process.stderr.write(`[kernel] ${line}\n`),
  });

  process.stderr.write(`[kernel] starting project "${project.name}" (${project.id})\n`);
  await kernel.start(project.id);

  await untilSignal();
  process.stderr.write("[kernel] shutting down…\n");
  await kernel.stop();
  await store.close();
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
