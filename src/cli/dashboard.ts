/**
 * Dashboard entrypoint: open the same Postgres the kernel writes to and serve
 * the read-mostly web dashboard over it.
 *
 * Usage: `DATABASE_URL=postgres://… npm run dashboard -- [--port <n>] [--host <addr>]`
 *
 * Point `DATABASE_URL` at the SAME database you pass to `npm start` so the
 * dashboard observes the live run. One shared `pg.Pool` backs both the
 * {@link PgStore} (domain reads/writes) and a minimal {@link Absurd} client on
 * the same queue as the kernel — the answer endpoint emits the wake-up event so
 * a suspended agent task resumes. The dashboard never drives the kernel; its
 * pointer/answer writes land in the store for the next cycle.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { buildAbsurd } from "../kernel/index";
import * as schema from "../store/schema";
import { PgStore } from "../store/index";
import { startDashboard } from "../dashboard/server";

interface Args {
  port: number;
  host: string;
}

/** Minimal `--flag value` parser. */
function parseArgs(argv: string[]): Args {
  const args: Args = { port: 7777, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) break;
    if (argv[i] === "--port") args.port = Number(value);
    else if (argv[i] === "--host") args.host = value;
  }
  if (!Number.isInteger(args.port) || args.port < 0) {
    throw new Error(`invalid --port: ${args.port}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required to run the dashboard");

  // One pool shared by the store and the Absurd queue, mirroring the kernel CLI.
  const pool = new Pool({ connectionString: databaseUrl });
  const store = await PgStore.fromDrizzle(drizzle(pool, { schema }), () => pool.end());
  const { app } = await buildAbsurd({ pool });

  const dashboard = await startDashboard({ store, app, port: args.port, host: args.host });
  process.stderr.write(`[dashboard] serving at http://${args.host}:${dashboard.port}\n`);

  const shutdown = () => {
    void dashboard.close().then(async () => {
      await store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
