import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { LocalSandboxRunner, type SandboxHandle, cloneRepo } from "../src/sandbox/index.js";

/**
 * Exercise the LocalSandboxRunner end to end — no network or external service.
 * The Daytona backend is intentionally not tested here (see note at the bottom).
 */
test("LocalSandboxRunner: write, exec, stream, clone, dispose", async () => {
  const runner = new LocalSandboxRunner();
  assert.equal(runner.backend, "local");

  const sandbox: SandboxHandle = await runner.create({
    envVars: { GREETING: "hi" },
  });

  // writeFile + exec reading it back
  await sandbox.writeFile("data/note.txt", "hello sandbox");
  const cat = await sandbox.exec("cat data/note.txt");
  assert.equal(cat.exitCode, 0);
  assert.equal(cat.stdout.trim(), "hello sandbox");

  // readFile round-trips the same content
  assert.equal(await sandbox.readFile("data/note.txt"), "hello sandbox");

  // baked-in env vars are visible to commands
  const env = await sandbox.exec("echo $GREETING");
  assert.equal(env.stdout.trim(), "hi");

  // per-command env + cwd
  const scoped = await sandbox.exec("pwd && echo $LOCAL", {
    cwd: "data",
    env: { LOCAL: "scoped" },
  });
  assert.match(scoped.stdout, /scoped/);
  assert.match(scoped.stdout, /\/data$/m);

  // a failing command surfaces a non-zero exit code (and does not throw)
  const fail = await sandbox.exec("exit 3");
  assert.equal(fail.exitCode, 3);

  // execStream emulates streaming by emitting the buffered output
  const chunks: string[] = [];
  const streamed = await sandbox.execStream("echo streamed", (c) => {
    chunks.push(c);
  });
  assert.equal(streamed.exitCode, 0);
  assert.equal(chunks.join("").trim(), "streamed");

  await sandbox.dispose();
  assert.equal(existsSync(sandbox.id), false);
});

test("LocalSandboxRunner: cloneRepo clones a local fixture repo", async () => {
  const runner = new LocalSandboxRunner();

  // Build a tiny git repo inside a throwaway sandbox to serve as the source.
  const origin = await runner.create();
  const setup = await origin.exec(
    [
      "git init -q -b main repo",
      "cd repo",
      "git config user.email a@b.c",
      "git config user.name test",
      "echo fixture > README.md",
      "git add -A",
      "git commit -q -m init",
    ].join(" && "),
  );
  assert.equal(setup.exitCode, 0, setup.stderr);
  const originRepo = `${origin.id}/repo`;

  // Clone it into a second sandbox via the convenience helper.
  const work = await runner.create();
  await cloneRepo(work, originRepo, "checkout", "main");
  const readme = await work.readFile("checkout/README.md");
  assert.equal(readme.trim(), "fixture");

  await origin.dispose();
  await work.dispose();
});

// NOTE: no Daytona test here — it requires network + credentials. A smoke test
// would be guarded with `if (!process.env.DAYTONA_API_KEY) return;`.
