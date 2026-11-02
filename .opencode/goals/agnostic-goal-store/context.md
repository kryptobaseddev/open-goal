# Context — agnostic-goal-store

Facts captured at planning time (2026-10-19).

## Project state
- `main` e10ed69; worktree `.worktrees/agnostic-goal-store` (branch `agnostic-goal-store`).
- The installed engine `@cleocode/goal@0.9.2` still hardcodes `.opencode/goals` in `src/engine/store.ts` (`this.goalsDir`), and `src/engine/store.ts` plus the write guard, CLI status/install and plugin tools all assume that path.
- review-release APPROVED main a618897..e10ed69; PRs still need approval on the exact head. This goal works in the worktree and opens a new PR.

## Current path facts
- `src/engine/store.ts:14` — `this.goalsDir = join(root, ".opencode", "goals")`.
- `src/engine/store.ts:35` — archive is `.opencode/goals-archive`.
- `src/engine/store.ts:53` — `renameSync(this.dir(slug), this.archivedPath(slug))`.
- The write guard refuses agent writes under `.opencode/goals/**`; it must cover the active root and the legacy path during the transition.
- `src/cli/status.ts` reads the newest live/finished run from the store; `src/cli/install.ts` writes only project-level `.opencode/opencode.json`.

## CLEO task spine
- Saga **T150** OCG Agnostic Goal Store and Protocol.
- Epics: **T151** canonical store, **T155** legacy/migration, **T159** protocol/docs.
- Tasks: T152–T154, T156–T158, T160–T162.

## Protocol facts
- `cleo goal install --harness claude|codex|hermes|kimi|opencode` exists in CLEO 2026.10.20; Claude writes project-level `.claude/settings.local.json`.
- T13884 is the dispatcher signal (`CLEO_HOOK_PROVIDER` = claude-code/codex); T1639 is cleo-prime persona detection, separate. T10532 is the cross-harness portable SKILL.md contract.
- T13802/T13804/T13805/T13806 are CLEO-side goal-runtime follow-ups; they are tracked, not edited here.

## Commands
- `bun test test/unit` · `bun run typecheck` · `cleo run --wait --class test -- bun test …`.
- `cleo-goal status --json` · `cleo doctor goal-runtime`.

## Constraints
- No data loss; legacy `.opencode/goals` remains readable.
- Migration is opt-in and dry-run first.
- One configured root; no scattered hardcoded paths.
