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
