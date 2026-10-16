# The harness-agnostic loop decision, and the `ocg tick` entry point

Written 2026-10-16 for the v0.6.0 goal. It records the decision contract, the parity between the extracted
function and the OpenCode adapter it came from, and exactly what the `ocg tick` entry point does.

> **Nothing was published to npm by this work.** The publication metadata is prepared (a `bin` entry, the
> `cli` folder in `files`) but no `npm publish` was run, no registry credential was used, and the package is
> still installed from a git tag. Publishing is a separate owner decision.

## Why

The loop's decision lived only inside `src/server/app.ts`, so no other harness could reuse it and it could
only be tested by booting OpenCode. CLEO has merged the Stop dispatcher (`#2306`) that expects an `ocg tick`,
which settles the entry point: OCG can implement it today even though the rest of the CLEO verbs are still
unreleased.

`choose one decision, many harnesses` is what removes the boundary. OpenCode keeps calling the function
in-process; a hook-based harness calls `ocg tick`.

## The decision contract

`decide(state, signals, limits) -> action`, in `src/engine/loop.ts`. It is **pure**: no filesystem, no
network, no OpenCode types, so it is testable and reusable without a host.

**Inputs.** `state` is the run state the host owns (`src/engine/state.ts`): `status`, `turn`, `claim`,
`wrapup`, `blocker`, `counters.noProgress`, `wait`, `pending.kind`. `signals` is everything the host
observed for the turn (`turn`, `pending`, `changed`, `progressRecorded`, `stepsChanged`, `activeStalled`,
`stallReason`, `onStall`, `budgetRatio`, `backstop`, `cooldownMs`, `now`). `limits` are the host's bounds
(`blockerRepeats`, `stallTurns`, `recoveryAt`, `backstopTurns`) — never hard-coded in the function.

**Outputs.** One of:

| action | meaning |
|---|---|
| `{kind:"none"}` | not this decision's turn (a failed/interrupted turn, or a run that is not running) |
| `{kind:"verify"}` | a claim is pending; verify it |
| `{kind:"admit", tail}` | send a continuation **now** |
| `{kind:"schedule", tail, delayMs, waiting?}` | schedule a continuation (cooldown, a wait's deadline, or a stall-continue) |
| `{kind:"stop", status, code, reason}` | stop the run for the owner (`code` is `blocked` / `stalled` / `budget` / `wrapup`) |

`continuationTail(action)` returns the `TailKind` a continuation carries, or `null` when the action does not
send one (verify / stop / none).

## Parity: every case, and the TailKind the adapter already sends

Each row is a branch the OpenCode adapter took before the extraction; the TailKind column is the
continuation it already sent, which the tick now sends too.

| case (in `decide` order) | action | TailKind the adapter sends | adapter side effects (unchanged) |
|---|---|---|---|
| the turn failed or was interrupted | `none` | — | the adapter's failure path (`onFailed`) handles it |
| the run is not running (and not a waiting run that claimed) | `none` | — | returns without continuing |
| the run is waiting **and** claimed | `verify` | — | verifies the claim |
| a claim is pending | `verify` | — | verifies the claim |
| `turn === 0` | `admit` | `kickoff` | admits the kickoff |
| the pending continuation was `wrapup` | `stop` (`wrapup`) | — | sets `budget_limited`, summarises |
| `blocker.count >= blockerRepeats` | `stop` (`blocked`) | — | sets `blocked`, raises the owner decision |
| `budgetRatio >= 1` or the backstop, first time | `admit` | `wrapup` | records the wrap-up, admits one wrap-up turn |
| `budgetRatio >= 1` or the backstop, after the wrap-up | `stop` (`budget`) | — | sets `budget_limited`, summarises |
| stalled, active, `on_stall: continue` | `schedule` | `continue` | records the stall + stall-report, schedules |
| stalled, otherwise | `stop` (`stalled`) | — | records the stall, sets `paused` |
| a future `wait` | `schedule` (`waiting`) | `continue` | sets `waiting`, schedules at the deadline |
| otherwise, progress missing >= `recoveryAt` | `schedule` | `recovery` | persists, schedules |
| otherwise | `schedule` | `continue` | persists, schedules |

**The tick's reason is the SAME continuation the adapter would send.** `ocg tick` renders the continuation
with `renderTailNote(state, contract, tail)` — the identical function the adapter uses for the identical
TailKind — and truncates it to CLEO's 4000-character cap. `test/unit/tick.test.ts` asserts the tick's reason
is byte-identical to `renderTailNote` for the same state and tail, so a harness driven through `ocg tick`
behaves identically to OpenCode *for the decision it makes*.

## What `ocg tick` does, and does not do

It implements CLEO's merged contract exactly:

- the harness Stop JSON is read from **stdin** (its content is acknowledged on stderr and otherwise unused —
  the decision comes from the project's goal state, not the payload);
- **stdout carries JSON and nothing else**: `{"decision":"block","reason":"<continuation>"}` to continue,
  `{"final":false}` to hold the session open (a goal that needs the owner, a repeated blocker, a stalled run,
  a spent budget, or an unreadable contract), and **nothing at all** when there is no live goal or no
  `.opencode/goals` directory — because CLEO treats anything but the documented JSON as no live goal;
- every log line goes to **stderr**;
- it never installs its own Stop hook: CLEO's dispatcher owns Stop, and a second entry would tick twice.

It is **read-only**. The run state is advanced by the host that owns it, and OCG's own write guard refuses
agent writes inside a live goal folder. The tick therefore decides from the run state **as persisted**: it
does not observe the turn's work, so it does not itself increment `noProgress` or record progress.

## What the unit suite covers, and what it does not

`test/unit/loop-decision.test.ts` covers every decision case above, including the ordering (a claim beats a
continuation; the wrap-up turn precedes the budget stop; a stall precedes the ordinary continuation), the
owner-set `on_stall` policy in both directions, the wait deadline arithmetic, recovery selection, and that
`decide` never mutates the state it is given.

`test/unit/tick.test.ts` covers the contract's four shapes over temp projects (no goal project, no live run,
a live running goal, a terminal goal, a goal awaiting the owner, a repeated blocker, a spent budget), and
asserts the reason equals the adapter's continuation.

`test/host/tick-bin.test.ts` spawns the **real bin** and asserts at the process boundary: stdout parses as
JSON, the Stop payload is acknowledged on stderr only, and nothing is printed when no goal is live.

**Not covered, deliberately.** The tick is not yet driven by a real non-OpenCode harness end to end, because
CLEO 10.18 (which ships the dispatcher) is not published. The tick also does not advance turn counters,
progress or the stall streak — that remains the work of whichever host owns the run, and is the next step
for a non-OpenCode adapter. Neither gap is claimed to be solved here.
