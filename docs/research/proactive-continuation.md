# Proactive continuation — what the loop does after a goal completes

Status: **shipped in v0.8.0** (git tag only; nothing published to npm).
This note is the design of record for C7. It states the sources and their order,
the announcement rate limit, the stop rules, what is never automatic, and the
handoff the next session receives. It also records the measured evidence and the
known contradiction in this goal's own C6.

Implemented by: `src/engine/next-work.ts`, `src/engine/loop-stop.ts`,
`src/engine/peer-announce.ts`, `src/engine/peer-transport.ts`,
`src/engine/continue-work.ts`, `src/engine/interrupt-policy.ts`,
`src/engine/stale-decisions.ts`, `src/engine/handoff.ts`, and their wiring in
`src/server/app.ts`. Tests: the C1–C6 host/unit files named in the contract,
plus `test/unit/handoff.test.ts` and `test/unit/check-keys.test.ts`.

## 1. Why this exists

v0.7.1 proved one goal rigorously and then stopped dead: completion offered
"Start the next goal" as a question, a restart demanded a resume click, an
accepted amendment demanded a second click, and a stale review could resurface
thirty minutes later. The owner's steer (2026-10-17) is that the friction, not
the proof, is the product problem: several agents run goal mode at once and every
waiting click is a machine that should be working.

The loop therefore keeps looking for work. It does that without weakening the
guards that make autonomy safe.

## 2. Sources after a goal completes, in order

The pure `nextWork` decision reads candidates in this order:

1. **A ready CLEO LEAF item in this project.** `cleo next -n 5` suggests
   candidates by priority and dependency; `cleo show <id> --full` supplies the
   type, title, description and acceptance statements. Only probed when the
   project is CLEO-linked (`.cleo` present); an unlinked project spawns nothing.
   **Leaves before parents:** an `epic` or `saga` is skipped and recorded as
   `continue-parent-skipped`, because a parent's acceptance is a rollup, not
   work. If the top suggestions are all parents, the loop treats it as no ready
   work (idle/announce) rather than inventing a goal over a rollup. Taking a
   parent automatically would need a new explicit owner policy; today the owner
   can still start one by hand.
2. **A peer reply to our availability announcement** (AgentMBX). A reply is
   **candidate work**, never an instruction and never consent. A task id in the
   reply is parsed; the body is kept verbatim with its sender.
3. **Nothing.** The loop goes idle and announces availability (see §3).

CLEO candidates beat peer candidates when both exist. The decision itself is
pure: the adapter gathers candidates, the decision picks one, and the adapter
records what it did.

## 3. Peer announcements: the rate limit

- **One outstanding announcement at a time.** While a peer has not answered, a
  second announcement is spam, not availability. `announceDue` returns
  `outstanding` and nothing is sent.
- **A cooldown floor of 15 minutes** (`OCGOAL_PEER_COOLDOWN_MS`, default
  `15 * 60_000`) after the last announcement. A rapid sequence of idle
  transitions (complete → resume → complete) is one idle period, not five.
- **Bounded reply polling**: every 30 seconds (`OCGOAL_PEER_POLL_MS`) while an
  announcement is outstanding, at most 40 polls, then `peer-poll-expired`. A
  reply clears `outstanding` and is recorded as a candidate.
- **Configured channel only.** The transport is active when
  `OCGOAL_PEER_IDENTITY` is set; otherwise the engine journals
  `peer-announce-skipped` and sends nothing. Tests inject a fake `agentmbx` on
  PATH; the unit suite never touches the network. The real transport shells out
  to `agentmbx send` / `agentmbx inbox` (assumption A4), and every failure is
  recorded as `peer-announce-failed`, never invented.

## 4. What still stops the loop and asks the owner

The pure `loopStop` decision, evaluated before any candidate:

1. **A human criterion is pending** — owner sign-off is never automatic.
2. **A real blocker is reported** — a missing credential, access, or a decision
   only the owner can make.
3. **An outward or destructive act would be required** — publish, deploy, merge,
   delete, secrets, spend.
4. **A first visit to a project this loop has never worked in** — stop, unless
   the contract sets `autonomy.visit_new_projects: true`.
5. **An exhausted budget** — stop, unless the contract sets
   `autonomy.continue_past_budget: true`.

Rules 4 and 5 are the contract's C6. They are implemented as written. This is
recorded as a **known contradiction**: the owner's stated intent in the same
contract ("ask the owner only for a human criterion, a real blocker or an
outward/destructive act") and the interview record reported by the launching
session say first-visit and budget are **not** stop rules. The contract is the
authority for this run, so the engine stops; the contract exposes explicit
opt-outs so a future contract can say otherwise. Resolving it is an owner
amendment, not an inference the engine may make.

A restart and an amendment are **not** owner questions: a clean restart resumes
by itself when the lock is unchanged and the run intact
(`src/engine/interrupt-policy.ts`), and an accepted amendment resumes in the same
act (`resumeAccepted`). A changed contract, a repaired/divergent run or an
interrupted write still pauses and asks.

## 5. What is never automatic

- Approving a `human` criterion, or approving evidence on the owner's behalf.
- Accepting or rejecting an amendment; only the owner's exact review does that.
- Accepting a launch or a resume of a **stopped** goal.
- Resuming after a changed, divergent or interrupted generation.
- Any outward or destructive act (publish, deploy, merge, delete, secrets,
  spend).
- Publishing to npm.
- Re-presenting a decision that is answered, expired, superseded, or bound to a
  generation that moved (`src/engine/stale-decisions.ts`).
- Re-asking an unanswered decision on every turn end. A still-pending review is
  not stale, but it is **asked once per process** (`shouldReaskDecision` in
  `src/engine/decisions.ts`); after that the engine stays silent until an
  explicit `goal_review` or a reload. Dismissed (`interrupted`) and open forms
  never re-ask. This is the same family as the C3 silence, applied to a pending
  completion decision.
- Re-announcing while an announcement is unanswered.
- Editing a contract or anything under `.opencode/goals/**` from the worker.

## 6. The next session's handoff

A fresh launch used to deliver the contract and nothing else. v0.8.0 writes
`handoff.md` and `handoff.json` beside the contract (`src/engine/handoff.ts`) and
prepends a bounded digest to the **kickoff tail note** (turn 1 only, so the
system block stays byte-stable). It carries: the prior goal/run/status/lock and
its evidence path, the measured red baseline, the repo HEAD/branch/dirty state,
the first plan step, which documents are authority and which are stale, and the
evidence paths. It is explicitly labelled **context, not authority**.

The gap that motivated it, measured: `.opencode/goals/.owner-launches.json`
records **21 prior launches, all `fresh: false`**, in one long-lived session;
v0.8.0 was the first `fresh: true` launch. The kickoff landed, but carried the
contract only; `context.md` and `decisions.jsonl` are skill artifacts the engine
never reads. `docs/HANDOFF.md` was a stale v0.3.x document. See
`docs/research/session-handoff.md` for the full diagnosis and the design, and
`docs/DEFECTS.md` for the register (D1 is this gap).

## 7. Evidence

- **Clean restart resumes; a changed contract and an interrupted write pause** —
  `test/unit/interrupt-policy.test.ts` (pure cases) and
  `test/host/restart-continuity.test.ts` (three real reloads over the engine).
- **An accepted amendment resumes in the same act** —
  `test/host/amendment-continuity.test.ts`, plus the existing amendment suites
  updated to the new observable behaviour (the guard assertions — one `amended`,
  replayed approval refused, oracle untouched — are unchanged).
- **Stale decisions are silenced** — `test/unit/stale-decisions.test.ts` and
  `test/host/stale-decision-silence.test.ts` (answered, expired, superseded).
- **Completion starts the next CLEO item without a question** —
  `test/host/continue-work.test.ts` with a real fake `cleo` on PATH: the contract
  is generated from `T900`'s own acceptance, the run starts in a new session, and
  no `complete` decision exists.
- **One announcement, replies become candidates** —
  `test/unit/peer-announce.test.ts` and `test/host/peer-announce-host.test.ts`
  with a fake `agentmbx`; the host test asserts exactly one send, no re-send
  while outstanding, and `T777` recorded as a peer candidate.
- **Stop rules** — `test/unit/loop-stop-rules.test.ts`.
- **Unknown check keys fail validation** — `test/unit/check-keys.test.ts`
  (`stderr_contains` is rejected and named, not dropped into `exit: 0`).
- **The existing oracles did not change** — the protected suites named in I1
  pass unedited; `bun run typecheck` passes.

## 8. Release posture

This is a **git-tag release only**. Nothing was published to npm: no
`npm publish`, no registry credential, no package in the registry. The package
is installed from `github:kryptobaseddev/opencode-goal#<tag>` as before, and the
completing round runs the installed engine, not the working tree.

## 9. Limits, stated plainly

- A CLEO item becomes a contract with **verifier** criteria over its acceptance
  statements. That is the same semantic standard the engine already uses, not a
  machine proof; the CLEO bridge still leaves an AC open when no evidence proves
  it.
- A peer reply is only a candidate. Turning a peer suggestion into a goal still
  requires the same contract validation, and a peer cannot supply owner consent.
- The handoff removes rediscovery of facts the host already holds. It does not
  make a new session omniscient, and it is not a substitute for reading the
  contract.
- The announcement transport is best-effort. A failure is recorded; the loop
  does not retry a send it cannot confirm as delivered.
