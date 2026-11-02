# Recon — tick-records-the-turn

Facts only (no decisions). Captured 2026-10-16. HEAD `730ea88` (pushed), `package.json` **0.6.0**, installed
pin `github:kryptobaseddev/opencode-goal#v0.6.0`. Four goals complete (v0.5.0, v0.5.1, v0.5.2, v0.6.0).

## CLEO 10.18 is STILL not published

- `npm view @cleocode/cleo version` → **2026.10.17**; the installed CLI is 2026.10.17.
- `cleo goal --help` → `set|status|advance|subgoal|append` (no `draft`, no `close`).
- `cleo tasks --help` → `show|find|next|current|plan|analyze|slice` (no `changeset`).
- So verb wiring (Phase 2) would still open blocked, and the tick has not been exercised by a real
  non-OpenCode harness. Both remain deferred.

## The gap v0.6.0 documented (this goal's target)

`docs/research/harness-agnostic-loop-decision.md`:

- "It is **read-only**. The run state is advanced by the host that owns it, and OCG's own write guard refuses
  agent writes inside a live goal folder. The tick therefore decides from the run state **as persisted**: it
  does not observe the turn's work, so it does not itself increment `noProgress` or record progress."
- "The tick also does not advance turn counters, progress or the stall streak - that remains the work of
  whichever host owns the run, and is the next step for a non-OpenCode adapter."

Consequence today: under a non-OpenCode harness, `noProgress`, the stall pause, recovery, the budget
wrap-up and the blocker repeats can never fire, because nothing increments them.

## What a Stop-time observer can and cannot know

The tick runs as a CLI at the harness's Stop event. It has the project, the run state and the harness
payload on stdin — and nothing else.

- **Can know**: the turn ended; the repository fingerprint now (`src/util/git.ts: fingerprint`); whether the
  run already carries a claim (`run.json`); the budget consumed (`usage`); a blocker recorded on the run.
- **Cannot know** by itself: the agent's tool calls, whether the agent called the progress tool, live-check
  transitions, and whether the harness is OpenCode. Those are session facts the OpenCode adapter reads from
  its own event stream.
- **May recover from the payload**: a harness Stop payload may carry a transcript path (Claude Code's does).
  Mining it is best-effort and OPTIONAL: a harness without one must still drive a goal.

## The completion question (important)

`decide` returns `verify` for a claim. Running that verification is the HOST's job: the OpenCode adapter
runs the host checks and spawns the read-only verifier child. So a tick that only decides could never
finish a goal. To drive a goal to `complete` from another harness, the tick must also RUN the verification
path:

- `src/verify/pipeline.ts` — `runHostCheck` (a command/file/contains/absent/diff check) and `verifyClaim`
  (host checks plus the verifier child when the contract asks for one).
- A contract with `verification: {mode: host}` needs NO verifier child, so the host checks alone decide it.
  A contract that asks for the independent verifier child still needs the adapter's mechanism, which the
  tick does not have.

## Relevant files

- `src/engine/loop.ts` — `decide`, `continuationTail`; `src/engine/tick.ts` — the read-only tick.
- `cli/ocg.ts` — the bin; `src/engine/store.ts` / `state.ts` — the records the adapter writes.
- `src/verify/pipeline.ts` — the host checks and the claim verification.
- `test/unit/loop-decision.test.ts`, `test/unit/tick.test.ts`, `test/host/tick-bin.test.ts` — the suites to
  extend.

## Packaging today

`package.json` has `bin: { ocg: "./cli/ocg.ts" }`, `files` includes `cli`, `description`, `license: MIT`,
`exports` = `.`, `./server`, `./tui`, `./rpc`. Nothing has been published; the package installs from a git
tag.

## Release loop

`bun install` (dev only) → `bun test` → `bun run typecheck` → bump `package.json` + `CHANGELOG.md` → commit
`type(T###): summary` → `git tag -a vX.Y.Z` → `git push origin main --follow-tags` → git-install test →
`opencode plugin remove/add` + reload (which **pauses** the run: the owner resumes).

## Working tree

Clean. No live goal. `cleo` 2026.10.17.
