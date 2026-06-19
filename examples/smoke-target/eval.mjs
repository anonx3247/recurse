#!/usr/bin/env node
// evalCommand for the smoke target: run the unit tests and emit the pass rate
// as the single JSON metrics object required by the eval-output contract
// (see ARCHITECTURE.md "Eval-output contract"). Nothing else on stdout.

import { execFileSync } from "node:child_process";

let tap = "";
try {
  tap = execFileSync("node", ["--test", "--test-reporter=tap"], { encoding: "utf8" });
} catch (err) {
  // node --test exits non-zero when tests fail; its TAP output is still useful.
  tap = `${err.stdout ?? ""}${err.stderr ?? ""}`;
}

const pass = Number(/# pass (\d+)/.exec(tap)?.[1] ?? 0);
const fail = Number(/# fail (\d+)/.exec(tap)?.[1] ?? 0);
const total = pass + fail;
const passRate = total === 0 ? 0 : pass / total;

process.stdout.write(`${JSON.stringify({ passRate })}\n`);
