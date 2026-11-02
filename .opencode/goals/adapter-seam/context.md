# Context — adapter-seam

Facts captured at planning time (2026-10-19).

## Project state
- `main` e10ed69; worktree `.worktrees/adapter-seam` (branch `adapter-seam`).
- Installed engine `@cleocode/goal@0.9.2` from npm; CLEO CLI 2026.10.20; `cleo goal install --harness claude|codex|hermes|kimi|opencode` exists.
- review-release APPROVED main a618897..e10ed69; PRs still need approval on the exact head. This goal works in the worktree and opens a new PR.

## Current adapter surfaces
- `src/server/index.ts` — OpenCode plugin entry; `GoalApp` in `src/server/app.ts` owns events, admission, tools, forms, verification.
- `src/engine/tick.ts` — the CLEO Stop-time path: record, decide, act; host-only verification; no forms/verifier child.
- `src/engine/loop.ts` — the pure decision shared by both.
- `src/cli/status.ts` / `src/cli/install.ts` — the Node CLI surfaces.
- `src/engine/state.ts` — run state (no harness field before Goal A).

## Claude proof facts
- `cleo goal install --harness claude` writes only `<project>/.claude/settings.local.json`.
- The Stop hook is `cleo hook stop --provider claude-code`; the PreToolUse hook is the heavy-command guard.
- The dispatcher calls the `cleo-goal` bin's tick; no separate plugin/MCP.
- CLEO_HOOK_PROVIDER (T13884) is the dispatcher signal: `claude-code` or `codex`, otherwise unknown; Goal A records it. No OCGOAL_HARNESS or --harness flag.

## CLEO task spine
- Saga **T137** OCG Adapter Seam.
- Epics: **T138** interface/capabilities, **T142** OpenCode extraction, **T146** tick + real harness proof.
- Tasks: T139–T141, T143–T145, T147–T149.

## Commands
- `bun test test/unit` · `bun run typecheck` · `cleo run --wait --class test -- bun test …`.
- `cleo goal install --harness claude` in a scratch project; `cleo doctor goal-runtime`.
- `cleo-goal status --json` (schemaVersion 1).

## Constraints
- OpenCode behavior byte-for-byte unchanged; protected oracles unedited.
- No user-global harness config writes.
- The seam must be honest about missing capabilities (forms, verifier child, TUI).
