# Snapshot base image for recurse agent sandboxes.
#
# Every worker/reviewer sandbox starts from this image. It contains exactly what
# an agent needs to do one cycle: clone a repo, run `pi` against a model, make a
# change, and run the project's `evalCommand`.
#
#   - node >= 20   (recurse, pi, and most evals are Node/ESM)
#   - git          (clone / branch / commit / push)
#   - pi           (the coding-agent CLI the worker/reviewer drive)
#
# Build/select this image as a Daytona snapshot with `src/sandbox/snapshot.ts`
# (`ensureSnapshot`), which is wired into `npm run smoke`. See the README
# section "Running a live smoke cycle".

FROM node:20-bookworm-slim

# git for the clone/branch/commit/push flow; ca-certificates for HTTPS remotes.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The pi coding-agent CLI, pinned for a reproducible snapshot.
ARG PI_VERSION=0.79.0
RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}"

# A default git identity so agent commits succeed in a fresh sandbox.
RUN git config --global user.email "agent@recurse.dev" \
  && git config --global user.name "recurse agent" \
  && git config --global init.defaultBranch main

WORKDIR /workspace
