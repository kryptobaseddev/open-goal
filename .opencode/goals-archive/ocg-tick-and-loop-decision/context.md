# Recon — ocg-tick-and-loop-decision

Facts only (no decisions). Captured 2026-10-16. HEAD `ee290d7` (pushed), `package.json` **0.5.2**, installed
pin `github:kryptobaseddev/opencode-goal#v0.5.2`. Previous goals `cleo-first-class-integration` (v0.5.0),
`real-model-dogfood-evidence` (v0.5.1) and `dogfood-chain-coherence` (v0.5.2) are complete; **epic T002 has
0 pending tasks**.

## CLEO 10.18 is NOT published yet

- `npm view @cleocode/cleo version` → **2026.10.17**. The installed CLI is 2026.10.17 too.
- `cleo goal --help` → `set|status|advance|subgoal|append` (no `draft`, no `close`).
- `cleo tasks --help` → `show|find|next|current|plan|analyze|slice` (no `changeset`).
- CLEO merged **#2299 goal draft**, **#2300 goal close**, **#2305 done --commit** and **#2306 the Stop
  dispatcher** to their main (reported 2026-10-16), shipping in **10.18**. So verb wiring (Phase 2) stays
  blocked, but the **tick contract is settled** — which is what this goal builds against.

## The tick contract (CLEO #2306, `cleo hook stop --provider …`)

- Command: `CLEO_GOAL_TICK_COMMAND`, default **`ocg tick`**, spawned with the harness's Stop JSON on
  **stdin** and a timeout of `min(CLEO_GOAL_TICK_TIMEOUT_MS or 30s, 60s)`; the whole process group is
  SIGKILLed at the deadline.
- Output: **JSON only on stdout**. `{"decision":"block","reason":"<continuation>"}` keeps the agent working
  and CLEO forwards ONLY those two fields, with `reason` capped at 4000 chars. `{"final":false}` holds the
  session open. **Anything else — including non-JSON or log noise on stdout — means no live goal.**
- Logs go to **stderr**.
- It runs only when `.opencode/goals/` exists, bounded to the project's git toplevel.
- Codex Stop never ends the CLEO session; Claude's does.
- CLEO's dispatcher OWNS Stop: **OCG must not install its own Stop hook.**

## Where the loop decision lives today (to extract from)

- `src/server/app.ts:1961` — the turn signal (`session.execution.succeeded|failed|interrupted`).
- `src/server/app.ts:2044` — `private async onTurnEnd(state)`: the decision point (stall streak, recovery,
  wrap-up, pause, block, verify).
- `src/server/app.ts:1737` — `private async admit(state, kind)`: sends the continuation.
- `src/contract/render.ts:100` — `TailKind = "kickoff" | "continue" | "verdict" | "recovery" | "wrapup" | "resume"`;
  `renderTailNote(state, contract, kind)` builds the continuation text the agent receives.
- `src/engine/state.ts` — `RunState` (status, counters.noProgress/failures, blocker, wrapup, verdict, budget).

## Packaging today

- `package.json`: **no `bin` field**; `exports` = `.`, `./server`, `./tui`, `./rpc`; `files` =
  `server.ts, tui.tsx, rpc.ts, dist, src, skills, README.md, LICENSE, CHANGELOG.md`.
- The plugin is installed from a git tag, never from npm.

## Release loop

`bun install` (dev only) → `bun test` → `bun run typecheck` → bump `package.json` + `CHANGELOG.md` → commit
`type(T###): summary` → `git tag -a vX.Y.Z` → `git push origin main --follow-tags` → git-install test →
`opencode plugin remove/add` + reload (which **pauses** the run: the owner resumes).

## Working tree

Clean. No live goal (three complete). `cleo` 2026.10.17.
