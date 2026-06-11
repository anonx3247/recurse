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
