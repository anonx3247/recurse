# recurse — Architecture

This document is the shared spec for the whole system. Every later PR (sandbox
runner, agent runner, kernel loop, dashboard) builds on the mental model here.
Keep it current.

## Vision

`recurse` is a **recursive self-improvement loop for any git-repo-backed project**.
It is domain-agnostic: a project declares a natural-language `objective` and an
`evalCommand` that emits measurable scores, and recurse drives sandboxed `pi`
agents to keep improving the repo against those scores.

The kernel knows nothing about the domain. All domain-specific behavior lives in
the project's **eval script** (how you measure "better") and its **seed skills**
(`.agents/skills/*/SKILL.md` checked into the repo). The same kernel improves a
TypeScript library's test coverage, a research paper's clarity, or a wet-lab
protocol's yield — only the eval and skills differ.

## Project

A **Project** is one git repository plus a `recurse.config.json`:

- `objective` — natural-language description of what "better" means.
- `repoUrl` / `defaultBranch` — where the work happens.
- `evalCommand` — a shell command run inside the repo that measures the current
  state (see the eval-output contract below).
- `metrics` — the metric specs the eval emits, each with a direction
  (`maximize` / `minimize`).
- `concurrency` — how many agent runs may execute in parallel.
- `ideaIntervalMinutes` — how often the ideator is scheduled.

## Eval-output contract

The `evalCommand` runs inside a checkout of the repo and **prints a single JSON
object of `{ [metricKey]: number }` on stdout**. Nothing else on stdout. Example:

```json
{ "coverage": 0.42, "lintErrors": 3 }
```

Every `metricKey` should match a `MetricSpec.key` in the config. The kernel parses
the last JSON object on stdout, records a `MetricSample` per key, and uses the
metric `direction` to decide whether a change improved or regressed.

## Kernel

The kernel is **one long-running process that is never idle**. It maintains:

- a **durable task/idea queue** — units of work (improve, idea, review, distill).
  The queue is **stateful and durable**, backed by
  [Absurd](https://earendil-works.github.io/absurd/) (see below) so in-flight
  work survives restarts and crashes;
- a **concurrency pool** that it keeps full up to `concurrency` — this is just an
  Absurd background worker started with `startWorker({ concurrency })`; whenever a
  slot frees it claims the next queued task and runs it;
- an **event log / state store** — the append-only source of truth that also
  powers the dashboard.

The kernel orchestrates; it never edits the repo itself. All real work happens in
agents running in sandboxes.

### Durable queue (Absurd)

The queue uses [Absurd](https://earendil-works.github.io/absurd/), a Postgres-native
durable workflow system: a **task** dispatches onto a **queue**, a **worker** picks
it up, and tasks are subdivided into **steps** that act as checkpoints — once a step
completes its result is persisted and won't re-run, so a failed task retries from
the last checkpoint instead of from scratch. Absurd also supports **sleep** (suspend
until a time, ideal for the scheduled ideator) and **await-event** (suspend until a
named event is emitted), which maps cleanly onto recurse's non-blocking
human-in-the-loop: the kernel can `awaitEvent` on a `question.answered` event while
continuing to drain other tasks. Absurd needs only a Postgres database and its
single `absurd.sql` schema — no broker or coordination service.

**One database for everything.** recurse consolidates on a single Postgres
instance: the `Store` (projects, changes, reviews, metrics, events) and Absurd's
durable queue/workflow state share the same database **and the same `pg.Pool`**, so
domain state and in-flight work stay transactionally consistent and there is one
thing to operate. The store is Postgres via drizzle ORM (`pg` / node-postgres, from
`DATABASE_URL`; Neon-compatible). Tests run fully offline against
[PGlite](https://pglite.dev/), a real Postgres compiled to WASM that runs
in-process — no external server or service containers.

The Absurd SDK does not ship its schema, so recurse vendors `vendor/absurd.sql` and
applies it once at startup, idempotently (guarded by `to_regnamespace('absurd')`),
then creates its queue. PGlite applies the same vendored schema with the
`uuid_ossp` contrib extension, so the durable path is covered by real offline tests
(see `tests/kernel.absurd.test.ts`).

### How the cycle maps onto Absurd

The pure cycle logic (`src/kernel/phases.ts` + `mergeGate.ts`) is independent of any
scheduler and is unit-tested fully offline. The durable shell (`src/kernel/tasks.ts`
+ `kernel.ts`) wraps it:

- **`improve-cycle` task** — one improvement cycle. Each phase is a checkpointed
  `ctx.step`: **worker** (persist a draft `Change` + `MetricSample`s + `AgentRun`),
  **review** (persist a `Review`, set the change `in_review`), **gate** (merge or
  reject per the merge gate). Because steps are checkpoints, a crash resumes from
  the last completed phase instead of re-running the minutes-long sandbox work; the
  worker lease (`claimTimeout`, default 1800s) is extended by checkpoints and
  explicit `ctx.heartbeat()` calls around long sandbox ops. On `request_changes`
  (under the per-lineage `maxReviewIterations` cap) the gate enqueues a follow-up
  `Task` and the handler `app.spawn`s another `improve-cycle` for it — the PR-review
  feedback loop. Failures are caught, mark the `Task`/`AgentRun` failed, and emit
  `cycle.error` without crashing the worker.
- **`scheduler-tick` task** — the never-idle guarantee as a self-perpetuating
  durable cron: `ctx.sleepFor` (suspends without holding a slot), then `ensureWork`
  (seeds a fallback `improve` Task folding in unconsumed human `Pointer`s if the
  queue is empty), then it re-spawns itself. The richer **Ideator** plugs in at the
  marked seam in `ensureWork`.
- **Non-blocking human-in-the-loop** — `askHuman` persists a `Question` and
  `ctx.awaitEvent("answer:<id>")`; the run suspends (freeing the slot) until the
  dashboard calls `answerQuestion`, which emits that event. Events are
  first-write-wins, so the answer is race-free.

## Agents

Every agent is a `pi` run inside its own sandbox. Four roles:

- **Worker** — takes an `improve` task, creates a branch, makes a change, runs the
  `evalCommand`, and opens a **Change** (branch + summary + before/after metrics).
- **Reviewer** — reviews a Change like a PR: structured `ReviewComment`s plus a
  verdict (`approve` / `request_changes` / `comment`). `request_changes` loops a
  follow-up task back to a worker, exactly like a PR review cycle.
- **Ideator** — scheduled (every `ideaIntervalMinutes`). Reads history, metric
  trends, and the human pointers inbox, and proposes novel directions as new
  `idea` tasks.
- **Skill-distiller** — when something works, writes/updates
  `.agents/skills/*/SKILL.md` in the repo so future agents inherit what worked.
  This is how the system compounds.

## Merge gate (the recursion)

A **Change lands only if**:

1. its eval **metrics improve or hold** (per each metric's `direction`), **and**
2. a **review approves** it.

When both hold, the change merges and **becomes the new baseline**. Metrics are
tracked over time, so each landed change raises the bar the next iteration must
clear. That is the recursion: improvements accumulate into the baseline that the
next round is measured against.

## Human-in-the-loop (non-blocking)

Humans steer without ever blocking the loop:

- **Pointers inbox** — drop directions/hints anytime (`Pointer`). The ideator and
  workers consume them; nothing waits on them.
- **Questions channel** — the kernel can ask a question (`Question`) when it would
  benefit from human judgment; the human answers whenever. Open questions never
  stall the pool — the kernel keeps working other tasks.

## Sandboxing

Each agent run executes in its own **Daytona OCI sandbox**, created from a prebaked
snapshot containing `node` + `pi` + `git`. `pi` runs inside the sandbox in
print/RPC mode, driven by the agent runner. One sandbox per run keeps agents
isolated and reproducible; the sandbox is torn down when the run ends. Logs are
streamed back to the store via `AgentRun.logPath`.

## Web dashboard

A minimal web dashboard reads straight from the store (no business logic) and is
deliberately framework-free: a single `node:http` server (`src/dashboard/server.ts`)
plus one self-contained static `index.html` (vanilla JS, hand-rolled `<canvas>`
charts, no build step, no npm UI deps). It runs with `tsx` directly.

- metric graphs over time (from `MetricSample`s);
- live agent logs (from `AgentRun` + the append-only event log);
- the task/idea queue and recent changes;
- a pointers box to drop directions and a questions panel to answer.

It is **read-mostly**, over the same async `PgStore` (Postgres) the kernel uses.
Two small write endpoints keep the human-in-the-loop non-blocking:

- `POST /api/pointers` appends a `Pointer`; the scheduler folds unconsumed
  pointers into the next cycle's seed prompt. The dashboard never drives the
  kernel here — it only writes.
- `POST /api/questions/:id/answer` records the answer **and** resumes the
  suspended agent. A task that asked a question is durably suspended on an Absurd
  `awaitEvent` (its worker slot freed). So the endpoint routes through the
  kernel's `answerQuestion(app, store, id, answer)` helper, which writes the
  store and `emitEvent`s the wake-up channel. The dashboard CLI constructs a
  minimal Absurd client on the **same pool + queue** as the kernel to do this.

Live updates use **Server-Sent Events** (`GET /api/stream`). The store has no
pub/sub, so the server polls the event log on a short interval and pushes entries
with an id newer than the last sent, keeping the socket alive with comment pings
and cleaning up on disconnect. Clients fall back to polling `/api/events` if the
stream drops.

Run the kernel and dashboard as two processes against the **same Postgres**
(`DATABASE_URL`): `DATABASE_URL=… npm start <config>` in one terminal,
`DATABASE_URL=… npm run dashboard` in another. See the README for details.

## Component diagram

```
                   ┌──────────────────────────────────────────┐
                   │                 Kernel                    │
                   │  task queue → concurrency pool → events   │
                   └───┬───────────────┬───────────────┬───────┘
                       │ launches      │ reads/writes  │ schedules
                       ▼               ▼               ▼
              ┌────────────────┐  ┌─────────┐   ┌──────────────┐
              │  Sandbox runs  │  │  Store  │   │  Scheduler   │
              │  (Daytona OCI) │  │(postgres)│  │  (ideator)   │
              └───────┬────────┘  └────┬────┘   └──────────────┘
                      │ pi agent       │ reads
        ┌─────────────┼──────────┐     ▼
        ▼             ▼          ▼   ┌───────────┐
     Worker       Reviewer   Ideator│ Dashboard │
   (Change)     (Review)   (Tasks)  │  (web UI) │
        │  Distiller → repo skills  └───────────┘
        ▼
   git repo (branch) ── evalCommand → { metricKey: number }
```

## Data flow of one improvement cycle

1. Kernel pulls an `improve` task; a free pool slot launches a **Worker** sandbox.
2. Worker checks out `defaultBranch`, creates a branch, makes a change, runs
   `evalCommand`, and records `newMetrics`; opens a **Change** (`in_review`).
3. Kernel enqueues a `review` task; a **Reviewer** sandbox inspects the Change and
   posts a **Review** (verdict + comments).
4. **Merge gate**: if metrics improve/hold **and** the verdict is `approve`, the
   change merges to `defaultBranch` and becomes the new baseline. Otherwise a
   follow-up task loops back to a worker (`request_changes`) or it is abandoned.
5. A **Skill-distiller** may capture what worked into the repo's skills.
6. Every step appends to the event log; the dashboard reflects it live.

## Roadmap / PR stack

The system is delivered as a stack of PRs. Later subagents: find your piece here.

1. **Scaffold + core domain model & state store** _(this PR)_ — project setup,
   this architecture doc, `src/core` types + config schema, `src/store`
   (interface + Postgres-via-drizzle + in-memory), example config, offline tests
   (PGlite) + CI.
2. **Sandbox runner** — Daytona OCI integration: create/destroy sandboxes from the
   prebaked snapshot, stream logs, run commands inside.
3. **Agent runner** — drive `pi` in print/RPC mode inside a sandbox for each role
   (worker/reviewer/ideator/distiller); parse eval output; write Changes/Reviews.
4. **Kernel loop + merge gate** — the never-idle process: the Absurd-backed
   durable queue, concurrency pool, scheduler, and the merge-gate logic that
   lands changes.
5. **Dashboard** — minimal web UI reading from the store: metric graphs, live
   logs, queue, pointers/questions.
