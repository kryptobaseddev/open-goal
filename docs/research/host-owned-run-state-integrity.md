---
title: 'Host-owned run state: guarded writes, proven repair, honest stalling'
audience: maintainer
status: final
---
# Host-owned run state: guarded writes, proven repair, honest stalling

## The report

An agent was hand-editing `run.json` every turn. The diff the owner captured showed
a merge, not a rewrite:

    "updatedAt" twice, "tokens"/"cost" twice, "tools" twice, "lastUsageEmit" twice

`Store.writeRun` serialises state with `JSON.stringify` and writes atomically, so it
cannot produce duplicate keys. The file had been edited by hand — and `JSON.parse`
accepts duplicates silently, keeping the last value, so the engine would have kept
running on a state nobody wrote on purpose.

## Why the agent felt it had to

Read-only inspection of the reported goal settled this:

- Its ledger ends with `{"type":"paused","reason":"stalled: no change the host could see for 3 turns"}`.
- A stopped run refuses `goal_progress` ("the goal is paused; the owner must resume it"),
  so an agent that had just finished real work had nowhere supported to record it.

and the guard that should have refused the edit covered only `edit`, `write` and
`patch` — a shell command or script writing the same path was not checked at all.

## Three fixes

1. **Every reachable write path is refused.** `shellWriteTargets` inspects a shell
   command for a write-shaped use of a live goal path — redirection, `tee`, `sed -i`,
   `mv`/`cp`/`rm`/`truncate`/`touch`/`chmod`/`dd`, and interpreters
   (`python`/`node`/`bun`/`ruby`/`perl`) that write or rename it — and the refusal
   names the supported tools. Reads (`cat`, `grep`, `ls`) stay allowed, and another
   project's or an archived folder is untouched.
2. **A corrupt `run.json` is proven, never guessed.** Duplicate keys are found by
   scanning the raw bytes, because a parse-only check cannot see them. The run is
   rebuilt from its own ledger `start` event (runId, sessionID, lock, commit) plus
   the locked contract snapshot in `evidence/<runId>/`, the raw bytes are kept as
   `run.json.corrupt-<ts>.json`, and `run-state-corruption` then `run-state-repaired`
   are journalled. When those cannot prove the identity, the run is refused with
   `run-state-unprovable` and left to the owner.
3. **Stalling stops punishing real work.** Host-visible activity is recorded per
   turn (`activity: tools > 0`), a `goal_progress` note counts as progress, and the
   stall reason says whether the run was active or idle. With the owner-set
   `autonomy.on_stall: continue`, a stalled-but-active run continues and journals a
   `stall-report`; the default still pauses, and an idle run always stops.

`run.json` continues to be written only by the engine, on every state change the
agent's tool calls cause — `goal_progress`, `goal_wait`, `goal_block`, `goal_flag`,
`goal_claim`, `goal_manage`, `goal_recover_divergence`.

## Evidence

- Red before the fix (final tests): `.tmp/verification/v043-red/red-final.xml`,
  6 of 7 fail, SHA256 112a25fe031b6085bf20a9f8338b30218cc6977f3d500756473b064c1811ff0c.
  The red run shows the real shapes: the shell write executed unrefused, the
  duplicate-key file was accepted, and the active run paused with the old reason.
- Green: the three new files 7/7; the eleven protected suites 46/46; typecheck clean;
  unit tests 177 pass with the same two pre-existing unrelated failures.
- Installed from the immutable tag: `OCGOAL_GIT_SPEC=…#v0.4.3` runs the three files
  7/7 (`.tmp/verification/v043-installed/tests.xml`), and
  `bun scripts/check-installed-goal.ts --min-version 0.4.3 --assert-release` reports
  the serving engine on v0.4.3 (revision 4633309, server PID 98502) for this run.

## What is not claimed

- The reported VidaPeps goal was inspected read-only; nothing there was edited,
  repaired or claimed fixed, and that project's state remains its own.
- No agent gained any way to resume, extend, clear or claim a stopped run. The only
  exception is the owner-set `on_stall` policy, which is the owner's grant in the
  contract, is journalled, and never applies to a run the owner paused.
- Static path analysis covers writes a command names; an opaque binary that writes
  the folder is caught by the load-time corruption check instead.
- The `run.json` schema version, historical ledgers and archived goals are unchanged.