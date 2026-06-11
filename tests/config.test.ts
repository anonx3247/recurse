import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, parseConfig } from "../src/core/config";

const sampleConfigPath = fileURLToPath(
  new URL("../examples/sample-project/recurse.config.json", import.meta.url),
);

test("loads a valid config from disk", () => {
  const config = loadConfig(sampleConfigPath);
  assert.equal(config.name, "sample-ts-lib");
  assert.equal(config.defaultBranch, "main");
  assert.equal(config.concurrency, 2);
  assert.equal(config.metrics.length, 2);
  assert.equal(config.metrics[0].direction, "maximize");
});

test("applies defaults for optional fields", () => {
  const config = parseConfig({
    name: "x",
    repoUrl: "https://example.com/x.git",
    objective: "improve",
    evalCommand: "node eval.mjs",
    metrics: [{ key: "score", label: "Score", direction: "maximize" }],
  });
  assert.equal(config.defaultBranch, "main");
  assert.equal(config.concurrency, 2);
});

test("throws a helpful error when required fields are missing", () => {
  assert.throws(
    () => parseConfig({ name: "x" }),
    (err: Error) => {
      assert.match(err.message, /Invalid recurse config/);
      return true;
    },
  );
});

test("throws when metrics is empty", () => {
  assert.throws(
    () =>
      parseConfig({
        name: "x",
        repoUrl: "r",
        objective: "o",
        evalCommand: "e",
        metrics: [],
      }),
    /Invalid recurse config/,
  );
});
