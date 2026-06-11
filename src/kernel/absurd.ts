/**
 * Absurd bootstrap — wire the durable-workflow engine onto the SAME Postgres
 * (and the SAME `pg.Pool`) the {@link PgStore} uses (see ARCHITECTURE.md
 * "Kernel"). One database, one pool: the queue, checkpoints, and domain rows
 * all live together.
 *
 * The Absurd SDK does NOT install its own schema, so we vendor `vendor/absurd.sql`
 * from the absurd repo and apply it idempotently (guarded by the presence of the
 * `absurd` namespace) before creating our queue.
 */

import { readFile } from "node:fs/promises";
import { Absurd } from "absurd-sdk";
import type { Pool } from "pg";

/** Resolve the vendored schema file relative to this module. */
const ABSURD_SQL_URL = new URL("../../vendor/absurd.sql", import.meta.url);

/**
 * Apply the vendored Absurd schema to `pool` exactly once. Idempotent: if the
 * `absurd` namespace already exists we skip, so re-running the kernel is safe.
 * Returns true when the schema was applied, false when it was already present.
 */
export async function installAbsurdSchema(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ absent: boolean }>(
    "SELECT to_regnamespace('absurd') IS NULL AS absent",
  );
  if (!rows[0]?.absent) return false;

  const sql = await readFile(ABSURD_SQL_URL, "utf8");
  await pool.query(sql);
  return true;
}

/** Options for {@link buildAbsurd}. */
export interface BuildAbsurdOptions {
  pool: Pool;
  /** Queue name to host kernel tasks. Defaults to `recurse`. */
  queueName?: string;
  /** Default retry attempts for tasks on this queue. */
  defaultMaxAttempts?: number;
}

/** A constructed Absurd client plus the queue it owns. */
export interface AbsurdHandle {
  app: Absurd;
  queueName: string;
}

/**
 * Build an {@link Absurd} client bound to the shared pool: install the schema if
 * needed, then create the queue idempotently (skipped if it already exists).
 */
export async function buildAbsurd(options: BuildAbsurdOptions): Promise<AbsurdHandle> {
  const queueName = options.queueName ?? "recurse";
  await installAbsurdSchema(options.pool);

  const app = new Absurd({
    db: options.pool,
    queueName,
    defaultMaxAttempts: options.defaultMaxAttempts,
  });

  const existing = await app.listQueues();
  if (!existing.includes(queueName)) {
    await app.createQueue(queueName);
  }

  return { app, queueName };
}
