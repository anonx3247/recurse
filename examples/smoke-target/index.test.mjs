import assert from "node:assert/strict";
import { test } from "node:test";
import { add, subtract } from "./index.mjs";

test("add sums two numbers", () => {
  assert.equal(add(2, 3), 5);
});

test("subtract takes the difference", () => {
  assert.equal(subtract(5, 3), 2);
});
