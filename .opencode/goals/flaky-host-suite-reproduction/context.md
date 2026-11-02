# Context (facts only) — recon 2026-10-15

## The observed failure
- Host verify of the protected suites (8 files, 38 tests) failed once:
  `test/host/goal-launch-flow.test.ts` → "a launch choice cannot approve contract bytes changed after the displayed review" (reported at 277.61ms; 37 pass / 1 fail).
- Three identical re-runs by the worker passed 38/38 (junit hashes recorded in `.tmp/verification/v041-red/i1-run-{1,2,3}.xml`). Not reproduced since.
- `git show` of both commits from the last goal contains no launch-related hunk: the launch code path was untouched.

## What that test does (test/host/goal-launch-flow.test.ts:109)
1. `goalHost` creates an isolated host (temp HOME/XDG, scripted fixture provider).
2. `prepare()` prompts the worker, which calls `goal_prepare_launch`; the host stages a native review form (or the question-tool fallback). `until(..., 8000)` polls `form.list`.
3. The test rewrites `.opencode/goals/demo/goal.yaml` with different bytes.
4. It replies to the form, then `until(..., 10000)` waits for the launch receipt to be `failed`, and asserts the result says "draft changed since review" plus that no `run.json` exists.

## Harness facts (test/host/harness.ts)
- Port: `const reserve = Bun.serve({ port: 0 }); const port = reserve.port; reserve.stop(true)` then `Bun.spawn([OPENCODE_BINARY, "serve", ..., "--port", String(port)])`. The port is free between `stop()` and the child binding it — other test hosts (or anything else) can take it.
- Readiness: polls `client.server.info()` until it answers; it does not check that the answering server is the child it spawned.
- `client.server.info()` exposes `pid` (used by scripts/real-model-manager-dogfood.ts to assert `info.pid !== prior.serverPID`).
- Isolation: per-host temp HOME/XDG_DATA/CONFIG/STATE, but `XDG_CACHE_HOME` is SHARED across hosts (`.tmp/host-cache`) so the fixture provider npm package downloads once.
- `bun test` runs files in parallel workers (`cleo run` reported 3 workers for this suite), so several hosts start at once.

## Commands
- One file: `cleo run --wait --class test -- bun test test/host/<file>`
- The affected suite: the 8 protected files listed in the previous goal's I1.
- Typecheck: `bun run typecheck`.

## Protect (cannot be edited)
The protected oracle list already includes `goal-launch-flow.test.ts`, `target-bound-decisions.test.ts`, `composer-amendment.test.ts`, `owner-chat-launch.test.ts`, `amendment-resume-prerequisite.test.ts`, `lab-lifecycle-triage.test.ts`, `test/fixtures/lab-tool-boundary/**` and `scripts/check-installed-goal.ts`. `test/host/harness.ts` and new test files are not protected.
