/**
 * Daytona snapshot resolution for recurse agent sandboxes.
 *
 * Agents start from a prebaked snapshot containing `node` + `git` + `pi` (see
 * `sandbox/Dockerfile` and ARCHITECTURE.md "Sandboxing"). This module decides
 * which snapshot name to use and ensures it exists in the Daytona account,
 * building it from the committed Dockerfile the first time.
 *
 * It depends only on a tiny {@link SnapshotApi} seam (a structural subset of the
 * Daytona SDK's `daytona.snapshot` service), so the resolution logic is unit
 * tested fully offline with a fake client — no Daytona, no network.
 */

import { fileURLToPath } from "node:url";
import { Image } from "@daytona/sdk";

/** Default snapshot name when `RECURSE_SNAPSHOT` is not set. */
export const DEFAULT_SNAPSHOT_NAME = "recurse-pi-node20";

/**
 * Resolve the snapshot name to use: the `RECURSE_SNAPSHOT` env override if set
 * (trimmed, non-empty), otherwise {@link DEFAULT_SNAPSHOT_NAME}.
 */
export function resolveSnapshotName(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.RECURSE_SNAPSHOT?.trim();
  return override ? override : DEFAULT_SNAPSHOT_NAME;
}

/** Absolute path to the committed snapshot Dockerfile (`sandbox/Dockerfile`). */
export function snapshotDockerfilePath(): string {
  // src/sandbox/snapshot.ts → repo root is two directories up.
  return fileURLToPath(new URL("../../sandbox/Dockerfile", import.meta.url));
}

/** Minimal info about a snapshot — the structural subset we read. */
export interface SnapshotInfo {
  name: string;
  state?: string;
}

/** Options accepted by {@link SnapshotApi.create} (Daytona SDK compatible). */
export interface CreateSnapshotOptions {
  onLogs?: (chunk: string) => void;
  timeout?: number;
}

/**
 * Structural subset of the Daytona SDK's `daytona.snapshot` service that
 * {@link ensureSnapshot} needs. The real service satisfies this; tests pass a
 * fake. `get` rejects (Daytona throws a not-found error) when the snapshot is
 * absent.
 */
export interface SnapshotApi {
  get(name: string): Promise<SnapshotInfo>;
  create(
    params: { name: string; image: string | Image },
    options?: CreateSnapshotOptions,
  ): Promise<unknown>;
}

/** True when an error from `SnapshotApi.get` means "no such snapshot". */
function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; statusCode?: number; code?: number };
  if (e.statusCode === 404 || e.code === 404) return true;
  return typeof e.name === "string" && /not.?found/i.test(e.name);
}

/**
 * Ensure a snapshot named `name` exists, returning its name (the id callers
 * pass to `SandboxRunner.create({ snapshot })`).
 *
 * If the snapshot already exists it is reused. Otherwise it is built from
 * `image` (defaults to the committed `sandbox/Dockerfile`) and the call blocks
 * until the build finishes. Any non-"not found" error from the lookup is
 * propagated unchanged.
 */
export async function ensureSnapshot(
  api: SnapshotApi,
  name: string = resolveSnapshotName(),
  image: string | Image = Image.fromDockerfile(snapshotDockerfilePath()),
  options: CreateSnapshotOptions = {},
): Promise<string> {
  try {
    const existing = await api.get(name);
    return existing.name;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  await api.create({ name, image }, options);
  return name;
}
