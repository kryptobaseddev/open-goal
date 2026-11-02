# Context — harness-identity

Facts captured at planning time (2026-10-19), no decisions here.

## Project state
- Project: `/Users/keatonhoskins/projects/opencode-goal`, main `e10ed69`, clean except untracked goal folders.
- Serving engine: `@cleocode/goal@0.9.2` from npm (OIDC, SLSA provenance), installed as the OpenCode plugin; global `cleo-goal 0.9.2`; `cleo doctor goal-runtime` green.
- Worktree for this goal: `.worktrees/harness-identity` (branch `harness-identity`, from `origin/main` e10ed69). review-release APPROVED main a618897..e10ed69; the goal still works in the worktree and opens a PR.
- CLEO CLI: 2026.10.20. CLEO 2026.10.19+ is required for `cleo goal install --harness <harness>`.

## Relevant code
- `src/engine/state.ts` — `RunState`; no `harness` field today.
- `src/server/app.ts` — goal start (`startGoalLocked`), `persist`/ledger, `goal_status` / `goal_provenance` view.
- `src/cli/status.ts` — `cleo-goal status --json` (schemaVersion 1).
- `src/engine/tick.ts` — tick decision and store writes; no harness identity.
- `src/engine/store.ts` — goal store is hardcoded to `.opencode/goals` (Goal C moves it).
- `src/contract/types.ts` — `goal/v1` contract types.

## CLEO task spine (created for this plan)
- Saga **T124** OCG Harness Identity.
- Epics: **T125** run-state identity, **T129** CLI/status, **T133** CLEO contract/doctor.
- Tasks: T126–T128, T130–T132, T134–T136.

## CLEO-side dependencies
- **T13875** — optional `harness {name, version, capabilities[]}` on `GoalRuntimeStatus`; pending in `cleocode/packages/contracts/src/goal-runtime.ts`.
- **T13884** — the dispatcher sets `CLEO_HOOK_PROVIDER` to its provider id (`claude-code` or `codex`); pending on the CLEO side. T1639 (cleo-prime persona detection) is separate.
- CLEO dev confirmed the signal: `CLEO_HOOK_PROVIDER` with `claude-code`/`codex`, otherwise unknown. No `OCGOAL_HARNESS` or `--harness` flag.

## Commands
- `bun test test/unit` — unit suite.
- `bun run typecheck` — includes generated TUI/CLI freshness.
- `cleo run --wait --class test -- bun test …` — heavy test gate.
- `cleo-goal status --json` — current schemaVersion 1 output (no harness field).
- `cleo goal install --harness claude` — writes project-level `.claude/settings.local.json` (verified 2026-10-17).

## Constraints
- Main and `feat/npm-cleocode-goal` are frozen pending review-release's post-merge verdict. Work happens in the worktree and goes forward as a new PR.
- The field is optional/additive; schemaVersion 1 must keep parsing without it.
- Never sniff the harness from a transcript; read `CLEO_HOOK_PROVIDER`, map `claude-code` -> `claude`, default to `unknown`, and leave version/capabilities null on the dispatcher path.
