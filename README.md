# recurse

`recurse` is a domain-agnostic, recursive self-improvement engine. It drives
[`pi`](https://github.com/earendil-works) code agents in sandboxes to iteratively
improve any git-repo-backed project — code, prose, bio research, anything — against
measurable metrics.

## The loop

You point recurse at a project (a git repo + a `recurse.config.json` that names an
`objective`, an `evalCommand`, and the `metrics` that matter). A never-idle kernel
keeps a pool of sandboxed `pi` agents busy: workers make a change on a branch and run
the eval, reviewers leave structured review comments, ideators propose novel
directions, and a skill-distiller writes back what worked. A change only lands when
its eval metrics improve or hold **and** a review approves — the merged work becomes
the new baseline, and the cycle repeats, recursively raising the bar.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

## Running the vertical slice

The kernel and the dashboard are two processes that share one **Postgres**
database (the same `DATABASE_URL`): the kernel writes the domain store + the
Absurd durable queue, and the dashboard reads them. In one terminal, start the
never-idle kernel against a project config:

```bash
DATABASE_URL=postgres://localhost/recurse npm start path/to/recurse.config.json
```

In another terminal, start the read-mostly web dashboard over the same database:

```bash
DATABASE_URL=postgres://localhost/recurse npm run dashboard -- --port 7777
```

Then open <http://127.0.0.1:7777>. The dashboard never drives the kernel: it
renders metric charts, the live event stream (Server-Sent Events), the task
queue and recent changes, and it lets you drop **pointers** (non-blocking
guidance) and **answer questions**. Pointers land in the store for the scheduler
to fold into the next cycle; answering a question also emits its Absurd wake-up
event (via a minimal Absurd client on the kernel's queue) so the suspended agent
task resumes. If SSE drops, the page falls back to polling `/api/events`.

Flags: `--port` (default `7777`), `--host` (default `127.0.0.1`). The database
comes from `DATABASE_URL` (required).

## Running a live smoke cycle

`npm run smoke` runs **one real improvement cycle end-to-end** against real
Daytona + real `pi` + a real model. It proves the whole vertical slice — sandbox
→ worker (`pi`) → eval → reviewer → merge gate — actually works, without making
CI depend on any of it.

It is **fully opt-in and env-gated**: with no credentials it prints how to run it
and exits `0`, so it never breaks CI. It is **not** run in CI.

### The sample target

The cycle improves a tiny committed repo, [`examples/smoke-target`](./examples/smoke-target):
`subtract()` has a deliberate bug so one of its tests fails. Its `evalCommand`
(`node eval.mjs`) runs the tests and emits the eval-output contract
`{ "passRate": <ratio> }` — `0.5` while buggy, `1.0` once fixed. The worker agent
is asked to fix the implementation (without touching the tests); the reviewer
reviews the change; the merge gate lands it only if `passRate` improves/holds and
the review approves.

### The snapshot

Agents start from a prebaked Daytona snapshot with `node` (>=20), `git`, and the
`pi` CLI. Its spec is committed at [`sandbox/Dockerfile`](./sandbox/Dockerfile).
`npm run smoke` calls `ensureSnapshot` (`src/sandbox/snapshot.ts`), which reuses
the snapshot if it already exists or builds it from that Dockerfile via the
Daytona SDK the first time. The name defaults to `recurse-pi-node20`; override it
with `RECURSE_SNAPSHOT`.

### Running it

```bash
DAYTONA_API_KEY=…  \
ANTHROPIC_API_KEY=…  \
npm run smoke
```

Required env:

- `DAYTONA_API_KEY` — provisions the sandbox (optional `DAYTONA_API_URL`,
  `DAYTONA_TARGET`).
- `ANTHROPIC_API_KEY` — the model key `pi` uses inside the sandbox.

Optional env:

- `RECURSE_SNAPSHOT` — snapshot name to ensure/use (default `recurse-pi-node20`).
- `RECURSE_PI_MODEL` — passed to `pi --model`; otherwise `pi`'s default model.

The smoke provisions a single sandbox, seeds the sample into a bare `file://` git
origin inside it (so the worker and reviewer can clone/push), drives the existing
kernel `runCycle` (no business logic is re-implemented), and prints a summary of
the resulting Change, its before/after metrics, and the review verdict.
