# Handoff — v0.7.1 complete → v0.8.0 (`proactive-continuation`)

Written 2026-10-17 by the session that owned v0.7.1 (`ses_ebeed1b03ffeDc98PWOK7xeeVM`), for
`opencode-goal-continuity` (`ses_eb82b0d09ffeS3UJBJeRLw1idx`). Facts are from that session's own
observations — ledger entries, `run.json`, `goal_provenance`, and commands run in the repo.

## 1. What I owned, and how it ended

- Goal **`tick-records-the-turn`**, run **`1471f46b9001`**, folder `.opencode/goals/tick-records-the-turn/`.
- **Complete** — 9/9 criteria `pass`, verdict passed. Final lock (amended generation):
  `981c5914083c9102e38a01a8fcfcf91660577ceb404769ee4e52dc9709f5502d`.
- Release **v0.7.1** — tag `v0.7.1` → commit `040b8bf2518a8d6df175b867d30145209ba7c9de`, loaded and
  serving that session (`goal_provenance` reported `packageVersion: 0.7.1`, source `#v0.7.1`).
- The earlier goal **`ocg-tick-and-loop-decision`** (v0.6.0) was **archived** at the owner's instruction →
  `.opencode/goals-archive/ocg-tick-and-loop-decision/` (decision `472d7d85-…`, resolved `succeeded`).

## 2. No handoff was written — that is the gap you hit

I wrote **no** handoff: no file, no mbx note, no CLEO doc, no ledger event.
`goal_prepare_launch({slug:'proactive-continuation', fresh:true})` built your session from the contract
alone. What I *intended* you to read: `docs/design.md`, `docs/spikes.md`, the run evidence under
`.opencode/goals/tick-records-the-turn/evidence/1471f46b9001/`, and `docs/HANDOFF.md`.

**`docs/HANDOFF.md` is a stale v0.3.x document about a different mission.** That predates me and I did not
fix it, which made this worse: the one file a new session is told to read is wrong.

Treat "a fresh launch injects the contract and nothing else" as a defect for the goal you are running. A
handoff pointer — or refusing a fresh launch without one — belongs next to C4 (completion → next work),
because that is the moment the engine decides to open a new session.

## 3. Repo changes for v0.8.0 so far

- **None.** Tree clean at `040b8bf` (v0.7.1). No branch, no commits, no uncommitted tracked files.
- The only thing I created: `.opencode/goals/proactive-continuation/goal.yaml`
  (lock `6c7020ff9443ba49a4ea814f197c66ec2f98703374febbe1f2be403da51fb984`).
- Scratch: `.tmp/amended-goal.yaml` — a copy of the amended v0.7.1 contract. Safe to delete.

## 4. How the launch actually happened

- **Owner-approved, by me, in the old session:** `goal_prepare_launch({slug:'proactive-continuation',
  fresh:true})` → decision `9b079792-223c-4801-9100-f033a7f3a392` → owner chose **Start goal now** → the host
  created your session.
- The kickoff was **not skipped** — it landed. It carries the **contract only**: no pointer to the previous
  run, no session state, no handoff. So the failure mode is *kickoff without continuity*, not *missing
  kickoff*.
- A later, unrelated stale prompt then fired from the completed goal ("Start the next goal"), after your
  session already existed. That is the stale-decision defect below, seen from the outside.

## 5. The four defects, as observed (reproductions, not documentation)

**a. Restart pauses (no auto-resume).** I swapped the installed plugin v0.6.0 → v0.7.1
(`opencode plugin remove/add`). The run became `paused`, reason `"host restarted; resume when ready"`, and
needed `goal_manage {action:"resume"}` → decision `9c6c69d3-…` → an owner click.
Cause: `parse.ts:304` defaults `autonomy.on_interrupt` to `"pause"`; `app.ts:2038` only auto-resumes when it
is `"resume-on-message"`.

**b. Accepting an amendment pauses.** After the C4 amendment was accepted, the run became `paused`, reason
`"owner accepted amendment; resume when ready"` (`app.ts:1446`), needing decision `3184df1b-…`.
`app.ts:1099` states it: *"acceptance alone does not resume."* A `continueGoal` path exists
(`app.ts:1385`) but is reachable only from `resolveAmendmentChat` with an explicit owner continuation —
**the native form path never sets it**, so a form acceptance always costs a second prompt.

**c. Stale decisions resurface.** The v0.6.0 archive decision `472d7d85-…` was created at
`2026-10-16T23:49:56Z`, 14 ms after the v0.7.0 launch resolved, and sat `interrupted`. It re-surfaced ~34
minutes later through `reaskDecisionForm` (`app.ts:1963-1970`, T075) when a turn ended. It took three asks
before it bound.

**d. Completion offers `start-next` instead of continuing.** `messages.ts:194` offers "Start the next goal"
with `act:"start-next"`; `app.ts:2556` handles it. Never automatic. Reproduced at the end of v0.7.1: the
completion decision `343a81a8-…` asked "what next?" **after** your session had already launched.

## 6. Two findings not in your contract

**C4's original check was impossible.** `npm pack --dry-run` writes the packed-file list to **stderr**
(2805 bytes; stdout is 24 bytes — only the tarball filename). `cli/ocg.ts` was on stderr line 7 of 73. No
repository state could satisfy a `stdout_contains` assertion against it.

**`stderr_contains` is not a supported check key.** `parse.ts:121-122` accepts only `exit`,
`stdout_contains`, `stdout_regex` and `runs`. Unknown keys are **silently dropped** and `expect` defaults to
`{exit: 0}`. I proposed `stderr_contains` once, saw the staged AFTER collapse to bare `exit: 0`, and withdrew
it — it would have weakened the criterion from "the tarball ships the CLI" to "npm exited 0". The accepted fix
used `npm pack --dry-run --json`, whose file list **is** on stdout (6454 bytes on stdout, 0 on stderr,
`cli/ocg.ts` present, 60 files, exit 0).

## 7. Owner decisions already made (do not re-litigate)

- **Auto-start** the next ready CLEO item on completion — notification, not a question.
- **Always announce** on idle to peers over AgentMBX, but only **one outstanding announcement** at a time.
- **Stop only for:** a human criterion, a real blocker, an outward/destructive act.
- **Not** stop rules: first visit to a new project; budget exhaustion.

## 8. Open items I did not do

- `CHANGELOG.md` and `docs/research/harness-agnostic-loop-decision.md` in v0.7.1 phrase **`ocg` as the
  primary** bin. The owner's later steer is **`cleo-goal` primary, `ocg` the "open cleo goal" alias**. Not
  corrected — do not treat the v0.7.1 wording as authority.
- Six discussed-but-unproven follow-ups live in the completed goal's summary dialog. The owner declined
  filing them as CLEO tasks, so they exist only there and under
  `.opencode/goals/tick-records-the-turn/`.
