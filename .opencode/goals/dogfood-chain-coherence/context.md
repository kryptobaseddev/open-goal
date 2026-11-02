# Recon — dogfood-chain-coherence

Facts only (no decisions). Captured 2026-10-16. HEAD `f0d5a5f` (pushed), `package.json` **0.5.1**,
installed pin `github:kryptobaseddev/opencode-goal#v0.5.1`. Previous goals `cleo-first-class-integration`
(v0.5.0) and `real-model-dogfood-evidence` (v0.5.1) are both **complete**.

## The finding this goal exists for

The v0.5.1 export records the **manager** flow as `partial` with the reason
`QA serving PID changed` — **not** the model failure from the run before it
(`First real goal did not remain held for manager QA`).

`scripts/real-model-manager-dogfood.ts` line 17: `if (info.pid !== prior.serverPID) throw Error("QA serving PID changed")`.
It reads `prior` from `<QA_RESUME_ROOT>/qa-evidence/context.json`, which was written by the **interview**
flow. The workflow **reused the cached interview record** — created when the session served pid **24041** —
after the v0.5.1 install/reload moved the server to pid **30270**. So the manager compared the live pid
against a stale prior and refused.

**The cache key does not bind the serving engine.** `cacheKey(release)` hashes only
`release.sha` + `release.artifacts`. `runDogfood` therefore reuses a record produced by a *different*
server. The design already names this case (`stale-cache`), but the key never included the engine
identity (`serving.pid`, `serving.location`, `serving.endpoint`) that the drivers themselves enforce.

So the manager flow has **not yet had a coherent run**: the run before it failed on a real model condition,
and the run after it failed on the stale-cache/pid mismatch. Whether the manager flow passes against a
coherent chain is genuinely unknown.

## Where the rest of the chain stands (last real run, post-install)

| flow | label | reason |
|---|---|---|
| interview | pass | reused (pid 24041 context) |
| manager | partial | `QA serving PID changed` (pid 24041 prior vs 30270 live) |
| lifecycle | pass | reused |
| completion | pass | reused |
| amendment | pass | reused (its own root; no prior pid binding) |

## The CLEO verbs are still NOT released

`cleo --version` is `2026.10.17`; `cleo goal --help` lists only `set|status|advance|subgoal|append`, and
`cleo tasks changeset` does not exist. CLEO PRs #2297 (types), #2299 (`goal draft`), #2300 (`goal close`),
#2301 (`tasks changeset`) are **in review**. So verb wiring (Phase 2) would start blocked.

## The maintainer's close-wiring rule (to fold in here)

mbx `01M538QHVCGEAGYRWTNKV8DQ2D`: when a goal's work lands on `main` with no PR or task branch,
`cleo goal close` completes tasks through `cleo done --commit <headCommit>` (CLEO PR #2305), and CLEO
accepts that commit for a task only if the message cites the task id (word-bounded `T123`) or the diff
touches the task's declared files. **A multi-task goal's run commits must cite every id in `cleo.tasks`**
or the uncited tasks stay open with a "neither cites" blocker. OCG should render this into the contract
the worker sees.

## Relevant files

- `src/engine/dogfood-record.ts` — `cacheKey`, `runDogfood` (reuse rule), `classify`, `validateExport`.
- `scripts/real-model-dogfood.ts` — the workflow: identity, the chained drivers, the engine-bound env.
- `scripts/real-model-manager-dogfood.ts` — the pid/endpoint/artifact gate at lines 14-17 and 50.
- `src/contract/render.ts` — where the contract the worker sees is built (`renderSystemBlock`).
- `docs/research/real-model-dogfood/0.5.1.md` + `.opencode/dogfood/6193275bde59/` — the last export.
- `test/unit/dogfood-record.test.ts`, `test/host/dogfood-workflow.test.ts` — the suites to extend.

## Release loop

`bun install` (dev only) → `bun test` → `bun run typecheck` → bump `package.json` + `CHANGELOG.md` → commit
`type(T###): summary` → `git tag -a vX.Y.Z` → `git push origin main --follow-tags` → git-install test →
`opencode plugin remove/add` + reload (which **pauses** the run: the owner resumes). The completing round
runs the **installed** engine.

## Working tree

Clean. No live goal (two complete). `cleo` 2026.10.17.
