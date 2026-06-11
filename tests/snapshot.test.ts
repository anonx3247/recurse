import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SNAPSHOT_NAME,
  type SnapshotApi,
  type SnapshotInfo,
  ensureSnapshot,
  resolveSnapshotName,
} from "../src/sandbox/snapshot";

/**
 * Offline tests for snapshot resolution. No Daytona, no network: the SnapshotApi
 * seam is faked, so only recurse's own decision logic is exercised.
 */

test("resolveSnapshotName: default, override, and whitespace handling", () => {
  assert.equal(resolveSnapshotName({}), DEFAULT_SNAPSHOT_NAME);
  assert.equal(resolveSnapshotName({ RECURSE_SNAPSHOT: "custom-snap" }), "custom-snap");
  assert.equal(resolveSnapshotName({ RECURSE_SNAPSHOT: "  spaced  " }), "spaced");
  assert.equal(resolveSnapshotName({ RECURSE_SNAPSHOT: "   " }), DEFAULT_SNAPSHOT_NAME);
});

/** A fake SnapshotApi recording create calls; `existing` controls `get`. */
function fakeApi(existing?: SnapshotInfo): SnapshotApi & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    async get(name) {
      if (existing && existing.name === name) return existing;
      throw Object.assign(new Error("not found"), { name: "DaytonaNotFoundError" });
    },
    async create(params) {
      created.push(params.name);
    },
  };
}

test("ensureSnapshot: reuses an existing snapshot without creating", async () => {
  const api = fakeApi({ name: "recurse-pi-node20", state: "active" });
  const id = await ensureSnapshot(api, "recurse-pi-node20", "img");
  assert.equal(id, "recurse-pi-node20");
  assert.deepEqual(api.created, []);
});

test("ensureSnapshot: builds the snapshot when it does not exist", async () => {
  const api = fakeApi();
  const id = await ensureSnapshot(api, "fresh-snap", "img");
  assert.equal(id, "fresh-snap");
  assert.deepEqual(api.created, ["fresh-snap"]);
});

test("ensureSnapshot: propagates non-not-found lookup errors", async () => {
  const api: SnapshotApi = {
    async get() {
      throw Object.assign(new Error("boom"), { name: "DaytonaConnectionError" });
    },
    async create() {},
  };
  await assert.rejects(() => ensureSnapshot(api, "x", "img"), /boom/);
});
