# The harness-agnostic loop decision, and the `ocg tick` entry point

Written 2026-10-16 for the v0.6.0 goal. It records the decision contract, the parity between the extracted
function and the OpenCode adapter it came from, and exactly what the `ocg tick` entry point does.

> **Nothing was published to npm by this work.** The publication metadata is prepared (a `bin` entry, the
> `cli` folder in `files`) but no `npm publish` was run, no registry credential was used, and the package is
> still installed from a git tag. Publishing is a separate owner decision.
>
> **Naming (owner decision, 2026-10-16).** The package becomes **`@cleocode/goal`** ("CLEO Goal"), published
> from this repo through its own npm OIDC trusted publisher on the `@cleocode` org, standalone - no dependency
> on CLEO, installable on its own as an OpenCode (later Claude and Codex) plugin. The bin is **`ocg`**,
> documented as **"open cleo goal"**, with `cleo-goal` as an equally supported long form, so CLEO's existing
> default `ocg tick` keeps working. The rename and the Node-runnable bin are the packaging goal that follows
> this one; the git repository keeps its name, so nothing breaks meanwhile.

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

**It records the turn, then decides (v0.7.0).** It advances the turn through OCG's own store, recomputes the
repository fingerprint (a move counts as progress), honours a claim the run already carries, and - best-effort
and optional - mines a transcript the Stop payload points at for tool calls and a progress call. So
`noProgress`, the stall pause, recovery, the wrap-up and the blocker repeats all work under a harness other
than OpenCode. What it can and cannot observe, and how it degrades, is the next section.

**It runs the verification of a claim.** When the run carries a claim, the tick sets the run to `verifying`,
runs the host checks (`verifyClaim` with no verifier child), records the results and the verdict, and either
completes the run (nothing on stdout - no live goal remains) or hands the agent the verdict as its next
continuation. A goal it can finish is therefore one whose verification is **host-only**; a goal that asks for
the independent verifier child still needs the OpenCode adapter, which owns that mechanism.

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

## What the tick can observe, and what it cannot

A Stop-time observer has the project, the run state, and - if the harness passes one - the Stop payload.
That is the whole of it, and the tick records only what follows from it.

**It can observe.** That the turn ended. The repository fingerprint now (git), which is the only progress it
measures itself. A claim the run already carries. The budget the run has consumed, and a blocker on the run.

**It cannot observe** the agent's tool calls, whether the agent called the progress tool, live-check
transitions, or plan-step moves - those are session facts the OpenCode adapter reads from its own event
stream. It recovers *some* of that from a transcript when the payload names a readable one, and nothing when
it does not.

**Degradation is stated, never guessed.** Every *payload* gap is logged to stderr as `could not see …`:
- no Stop payload → the tool calls and the progress call are simply not visible;
- a payload that is not JSON → the payload itself is named as unreadable;
- a payload naming no transcript → the transcript is absent by the harness's design;
- a transcript that is missing, unreadable, or parses but holds no tool calls and no messages → named as such.

In every one of those cases the tick still records the turn and the fingerprint it *can* take, and
`noProgress` advances honestly. It never invents a tool call, a progress call or a live-check transition.

**A missing or unreadable run store is never an error either**, and it is never silent about *why*:
- no `.opencode/goals/` directory at all → `nothing to tick`, nothing on stdout, exit 0: the harness session
  is free to end;
- run records that are absent, duplicated or unparseable JSON → the store returns no state, the tick logs
  `no live goal here; nothing to tick` and prints nothing - it does not throw, and it does not invent a run;
- a live run whose `goal.yaml` is missing, unreadable or fails to parse → `no readable contract; holding`,
  and the tick emits `{"final":false}` so the session is held rather than ended on a guess;
- a claim is pending but this build has no verifier wired → `a claim is pending but this tick cannot verify;
  holding` and the same `{"final":false}` - it never marks a claim verified that it did not check.

Degradation always errs toward holding or ending quietly, never toward a fabricated fact or a partial write:
the tick writes run state only through OCG's store (`writeRun`/`ledger`/`evidence`), in the same shapes the
adapter uses, so a harness other than OpenCode leaves records the adapter can still read.

## Which goals the tick can drive to completion

- **Yes**: a goal whose verification is host-only (`verification: {mode: host}`, or no verifier criteria). The
  scripted-harness test drives exactly that: kickoff → the agent's work → a claim through `ocg claim` → a
  verified `complete`, using nothing but the bin.
- **No**: a goal whose contract asks for the independent verifier child. That child is the OpenCode adapter's
  mechanism; the tick runs the host checks and no more, and it says so rather than pretending.
- **Not yet exercised**: a *real* non-OpenCode harness, because CLEO 10.18 (which ships the Stop dispatcher)
  is not published. The scripted harness is the strongest available proof today, and it is a simulation - the
  design note says so rather than implying a live pilot.

## What the unit and host suites cover

`test/unit/tick-record.test.ts` covers the recording: the turn increment, a fingerprint move as progress and
its absence without one, a fingerprint that cannot be taken, a claim honoured, a transcript mined for tool
calls and a progress call, a transcript with no progress call (nothing fabricated), and every degradation
above being named.

`test/unit/tick.test.ts` covers the tick end to end over an injected store: no goal project, no live goal, the
recorded turn in the adapter's own event shape, the reason byte-identical to the adapter's continuation, a
claim verified to `complete`, a claim that fails and hands back the verdict, a claim with no verifier
available (hold, not pretend), an owner-waiting goal, and the named degradations.

`test/host/tick-scripted-harness.test.ts` spawns the **real bin** and drives a real goal to `complete`, then
asserts the terminal state, the criteria board, the recorded turns and the ledger events.

`test/host/tick-bin.test.ts` still pins the process boundary: stdout parses as JSON, logs go to stderr only,
and nothing is printed when no goal is live.

**Not covered**: the tick does not run the independent verifier child, it does not decide `human` criteria
(only the owner does), and it has not been run against a real non-OpenCode harness.
