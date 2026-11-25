# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A GitHub Action that launches a TestingBot Tunnel via Docker. It pulls and runs the `testingbot/tunnel` image, waits for the tunnel to signal readiness through a ready-file, and stops the container in a post-action step. Used in CI workflows to route Selenium tests through TestingBot's browser/device grid.

## Commands

- **Build:** `npm run build` — bundles `src/index.ts` → `dist/main/index.js` and `src/post.ts` → `dist/post/index.js` with esbuild (single CJS file each, target node24).
- **Lint:** `npm run lint` (ESLint flat config in `eslint.config.mjs`, on `src/**/*.ts`).
- **Format:** `npm run format` / `npm run format-check` (Prettier on all `.ts`).
- **Unit tests:** `npm test` — `pretest` compiles `src/` and `test/` with `tsc -p tsconfig.test.json` into `test-build/` (and copies `src/options.json`), then Mocha runs `test-build/test/**/*.test.js`.
- **Single test:** `npm run build:test && npx mocha --grep "buildOptions"` (grep matches `describe`/`it` titles; tests run from the compiled JS, so rebuild after editing).
- **E2E:** `npm run test:e2e` — serves `test/` on port 8080 and runs `test/e2e.test.js` via WebDriverIO against TestingBot. Needs `TB_KEY`, `TB_SECRET`, and an already-running tunnel with identifier `github-action-tunnel` (CI starts it with `uses: ./`).
- **All checks:** `npm run all` — build + format + lint + unit tests.

## Architecture

Two entry points, declared in `action.yml` (`runs.main` / `runs.post`):

- **`src/index.ts`** (main) — validates inputs up front, creates a per-run work dir (saved to state as `workDir` so the post step can find the log even if startup fails), optionally runs `--doctor` diagnostics, then calls `startTunnel()` in a retry loop with `retryDelays` backoff until `retryTimeout` (minutes). A `NonRetryableError` stops the loop at once. Sets outputs `container-id`, `tunnel-identifier`, `log-file`.
- **`src/post.ts`** (post) — stops the container from state and uploads the tunnel log as an artifact (`uploadLogFile`, `logArtifactName`). Upload runs even when the tunnel never started or stopping failed.
- **`src/container.ts`** — core logic:
  - `buildOptions()` maps action inputs to tunnel CLI args via `src/options.json`. Entry keys: `dockerOption` (CLI flag), `flag` (boolean input → bare `--name`), `multiple` (one flag per input line), `path` (resolved against `GITHUB_WORKSPACE` and bind-mounted read-only by `buildMounts()`), `env` (passed as an environment variable instead of a flag, for credential-bearing values). `extraArgs` is a raw escape hatch.
  - `startTunnel()` runs `docker run --network=host --detach` (no `--rm`, so a failed container's exit code and `docker logs` can be read; `stopTunnel` removes it). The work dir is mounted at `/tmp` in the container; the tunnel writes `tb-tunnel.log` and `tb.ready` there.
  - `readyPoller()` polls for `tb.ready` and `docker inspect`s the container every `pollDeps.intervalMs`, failing early with `ContainerExitedError` when the container exits. Exit code 2 (invalid options) or 401 output becomes a `NonRetryableError`.
  - Credentials go to the container as `TESTINGBOT_KEY` / `TESTINGBOT_SECRET` env vars (forwarded by name with `-e`) and are masked with `setSecret`. Never pass them as CLI args, which would show up in `ps` and `docker inspect`.
  - Listeners bind to `127.0.0.1` by default (`bindAddress`, sent as `TESTINGBOT_BIND_ADDRESS`): with host networking, `0.0.0.0` would expose the unauthenticated relay that attaches the account credentials.
- **`src/toolkit.ts`** — the single object through which all `@actions/core`, `@actions/exec` and `@actions/artifact` calls go. Those packages are ESM-only with read-only namespaces, so tests stub `toolkit.*` with sinon instead. Always call them through `toolkit`, never import them directly elsewhere.

## Adding or changing an action input

Declare the input in `action.yml`, add the mapping in `src/options.json`, document it in `README.md` (mark options that need tunnel 5.0+/5.1+), add `buildOptions` tests, then rebuild `dist/`.

## Key Details

- `dist/` is checked in. Run `npm run build` and commit it with any `src/` change; CI fails if `dist/` differs from a fresh build on Node 24. PRs that each rebuild `dist/` conflict with each other, so stack them.
- Runtime is `node24` (`action.yml`); `engines` requires `>=24`; CI unit tests run on Node 24 and 26. `@types/node` stays on 24 (Dependabot ignores its majors).
- Tests are compiled to CommonJS but the `@actions/*` packages are ESM-only: `.mocharc.yml` sets `conditions=import` so `require()` resolves them.
- TypeScript strict mode; no semicolons (Prettier/ESLint).
- Dependabot PRs only see Dependabot secrets: `TB_KEY` / `TB_SECRET` must exist there too for their E2E job.
