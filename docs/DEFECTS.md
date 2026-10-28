# Known defects — goal mode (register)

Opened 2026-10-17 by the session that ran v0.7.1, after the v0.8.0 fresh launch exposed a cluster of
continuation defects. Purpose: these are reproduced and evidenced here so they are **fixed and regression-
tested**, not rediscovered every time a goal chain runs.

Status legend: **open** · **fixed** `<version>` · **by design**.

| id | defect | severity | status |
|----|--------|----------|--------|
| D1 | A `fresh` launch injects the contract and no handoff or prior state | high | open |
| D2 | A restart pauses the run and demands an owner click | high | open |
| D3 | Accepting an amendment does not resume; a second prompt is forced | high | open |
| D4 | A superseded/interrupted decision re-surfaces long after the fact | medium | open |
| D5 | Completion offers `start-next` as a prompt, and can fire after a new run already started | medium | open |
| D6 | An unknown `expect` key in a check is silently dropped, weakening the criterion | high | **fixed 0.8.0** |
| D7 | A contract can encode the inverse of the owner's intent and still validate | medium | open |
| D8 | `ocg tick` read the run store without a guard, so an I/O error crashed it | high | **fixed 0.7.1** |
| D9 | An unknown `budget` key is silently dropped, and the turn backstop is reported as an exhausted budget | high | **fixed 0.9.3** |
| D10 | A contract locked before a validator tightening bricks its run; resume, amendment and divergence recovery disagree | high | **fixed 0.9.4** |

---

## D1 — a fresh launch carries no continuity

**Severity** high. **Status** open.

**Observed** 2026-10-17. The v0.8.0 goal was prepared with `goal_prepare_launch({slug:
"proactive-continuation", fresh: true})` and started by the owner. The host created a new root session
(`ses_eb82b0d09ffeS3UJBJeRLw1idx`, run `147dfba0e001`). Its first turn contained **the contract and an empty
plan board only** — no pointer to the previous goal, no run state, no handoff. The incoming agent reported
having to rediscover the repo from `git log`, the test layout and `src/` to know even which test files were
missing, and that `docs/HANDOFF.md` was a **v0.3.x** document about a different mission.

**Evidence**
- `.opencode/goals/proactive-continuation/` contained neither `context.md` nor `decisions.jsonl` — the other
  goal folders do.
- `.owner-launches.json`: v0.8.0 is the **first `fresh=True` launch in 21 launches**. Every earlier goal
  started in the same long-lived session, which is exactly why this never bit anyone before.
- The host message confirmed the kickoff *did* land ("The kickoff prompt landed in the new session"), so the
  defect is **missing continuity**, not a missing kickoff.

**Why it matters** A fresh session is the intended path once a goal chain runs unattended; every fresh
launch after this one loses the thread unless a human writes a handoff by hand.

**Proposed fix** (owner of the running goal decides the shape)
1. On goal **completion**, the engine writes a machine-generated handoff stub — last status, runId, lock,
   repo HEAD, the goal folders present, and the newest `docs/HANDOFF-*.md` if one exists.
2. `goal_prepare_launch({fresh:true})` **refuses** (or requires an explicit acknowledgement) when no handoff
   exists for the previous run.
3. The kickoff for a fresh session includes a continuity block pointing at that stub, so the first turn is
   not "contract only".

**Regression test** a host scenario: complete a goal, prepare a fresh launch, assert the first turn's
prompt contains the previous run id and the handoff path (or that the launch is refused).

---

## D2 — a restart pauses the run

**Severity** high. **Status** open.

**Reproduced** `opencode plugin remove …#v0.6.0` + `add …#v0.7.1` while the run was live. The run became
`paused`, reason `"host restarted; resume when ready"`; resuming required `goal_manage({action:"resume"})`
→ decision `9c6c69d3-7321-4879-80fc-9a1d8f629d3c` → an owner click.

**Cause** `src/contract/parse.ts:304` defaults `autonomy.on_interrupt` to `"pause"`; `src/server/app.ts:2038`
auto-resumes an interrupt only when it is `"resume-on-message"`.

**Proposed fix** default to resuming a **clean** restart (lock unchanged, run intact, no write in flight);
pause only when the contract changed under the run, the run diverged, or a write was interrupted. A new
`"resume"` value, since `"resume-on-message"` still needs the owner to speak.

---

## D3 — accepting an amendment forces a second prompt

**Severity** high. **Status** open.

**Reproduced** after the C4 amendment was accepted (decision `db049963`/`8b2fd085` lineage). The run became
`paused`, reason `"owner accepted amendment; resume when ready"`; resuming required `goal_manage` → decision
`3184df1b-bf66-4aad-8086-d8b3abed24bb` → a second owner click.

**Cause** `src/server/app.ts:1099` states *"acceptance alone does not resume"*; `:1446` sets the paused
reason. A `continueGoal` path exists (`:1385`) but only `resolveAmendmentChat` supplies it — the **native
form path never sets it**, so a form acceptance always costs a second prompt.

**Proposed fix** a form acceptance resumes the run in the same act. The owner already made the decision;
asking twice is the defect.

---

## D4 — superseded decisions re-surface

**Severity** medium. **Status** open.

**Reproduced** decision `472d7d85-dfba-44ab-96bf-bedb16d56490` (archive v0.6.0 goal) was created
`2026-10-16T23:49:56Z`, **14 ms after** the v0.7.0 launch resolved. It sat `interrupted`, then re-surfaced
~34 minutes later through `reaskDecisionForm` (`src/server/app.ts:1963-1970`, T075) when a turn ended. The
owner saw the prompt with no context for why it existed, and it took three asks before one bound.

**Proposed fix** never re-present a decision whose target is superseded (there is already a `supersede-ack`
kind), expired, or already answered; and make a re-presentation incapable of minting a second ask.

---

## D5 — completion asks "what next" instead of continuing

**Severity** medium. **Status** open.

**Reproduced** at the end of v0.7.1: the completion decision `343a81a8-dd9f-490a-85b5-dea892ba7881` asked
"what next?" **after** the v0.8.0 run had already been launched, so its "Start the next goal" option had
nothing to start.

**Cause** `src/server/messages.ts:194` offers "Start the next goal" with `act:"start-next"`; handled at
`src/server/app.ts:2556`. It is always a prompt, never automatic.

**Proposed fix** this is the v0.8.0 C4 work: start the next ready item and record a notification. Also
suppress the completion question when a successor run is already live.

---

## D6 — an unknown check key silently weakens a criterion

**Severity** high. **Status** **fixed in 0.8.0**.

**Fixed** `src/contract/parse.ts` now rejects any `expect` key outside `exit`, `stdout_contains` and `stdout_regex` (and `runs`), naming the offending key; `test/unit/check-keys.test.ts` pins it.

**Reproduced** a proposed C4 check used `expect: {stderr_contains: "cli/ocg.ts"}`. The staged diff showed C4
collapse to `expect: {exit: 0}` — the needle vanished. `src/contract/parse.ts:121-122` accepts only `exit`,
`stdout_contains`, `stdout_regex` (and `runs`), and **drops unknown keys**, after which `:136` defaults
`expect` to `{exit: 0}`.

**Why it matters** this can silently turn any content assertion into an exit-code assertion — a criterion
that passes while proving far less. It is the most dangerous defect in this register because it fails
*open*.

**Proposed fix** an unknown `expect` / `check` key is a **validation error**, never a silent drop. Same for
any future check kind. A validator warning is not enough.

---

## D7 — a contract can encode the inverse of the owner's intent

**Severity** medium. **Status** open.

**Reproduced** v0.8.0's C6 was drafted as *"…SHALL stop and ask the owner, **and SHALL NOT continue past a
first visit to a new project or an exhausted budget** unless the contract says otherwise"*. In the
interview the owner selected only three stop rules — human criterion, real blocker, outward/destructive act
— and explicitly **did not** select the new-project or budget rules. The wording says the opposite of the
intent, and it validated cleanly.

**Proposed fix** two parts. (a) In `write-goal`, a stop-rule must be phrased positively ("SHALL continue
past X") or listed, never as "SHALL NOT continue past X", which reads as a stop. (b) Where a contract names
stop rules, validate them against a known vocabulary so a contradiction is visible at review time.

---

## D8 — the tick crashed on an unreadable store *(fixed 0.7.1)*

**Severity** high. **Status** **fixed in 0.7.1** (commit `040b8bf`).

`ocg tick` read the goals directory and `run.json` with no `try/catch`, so an I/O error escaped as an
exception. Empty stdout is indistinguishable from "no live goal" to the dispatcher, so a crash **silently
dropped the run** and ended the session. Now the tick names what it could not read and **holds**
(`{"final":false}`) rather than printing nothing on a guess; the bin also catches any unexpected throw.

Found by the goal's own C1, which is why the release is v0.7.1 rather than v0.7.0.

---

## D9 — an unknown `budget` key is silently dropped, and the backstop wears the budget's name

**Severity** high. **Status** **fixed in source** (unreleased at the time of writing).

**Reported** 2026-10-22 by `axiom-instrument-studio-tbl6run` (message
`01M5JYH09773WSJ8TTFH75GKW0`), from live run `14c6ffb3f001` of `tbl-six-class-production-run` on
`@cleocode/goal@0.9.2` / OpenCode 2.1.3.

**Observed** the run stopped `budget_limited` five times in a row. Each "Raise budget (amend)" was accepted
and resumed, then stopped again on the next tick, while the status header said "Budget: no budget set".

**Cause** the same fail-open shape as D6:
- `src/contract/parse.ts` recognised only `turns`, `wall`, `tokens`, `cost_usd` and **dropped every other
  `budget` key**. The report's contract used `max_turns` / `max_tokens` / `max_cost_usd`, so the parsed
  budget was `{}` and every raise was a no-op.
- `src/server/app.ts` then applied the 200-turn backstop (`!contract.budget.turns && turn >= 200`), and
  `src/engine/loop.ts` mapped that stop onto `budget_limited` with reason "budget used" — indistinguishable
  from an exhausted budget, contradicting the header.

**Fixed**
- An unknown `budget` key is now a validation error naming the allowed keys
  (`budget.max_turns: unknown key; allowed: turns, wall, tokens, cost_usd`), and a non-mapping `budget` is an
  error too. Pinned in `test/unit/contract.test.ts`.
- The backstop now has its own status `backstop_limited`, decision kind and ledger event, with the reason
  `backstop of N turns reached; no contract budget set — set budget.turns to control the run`. The decision
  message, banner, action-required line, quick actions and post-goal summary all name `budget.turns` as the
  remedy instead of offering a budget raise that cannot exist. Pinned in `test/unit/loop-decision.test.ts`
  and `test/unit/tui-format.test.ts`.

**Immediate workaround on 0.9.2** rename the contract's `max_turns` to `turns` (and `max_tokens` to `tokens`,
`max_cost_usd` to `cost_usd`) and amend again; the backstop only applies while `budget.turns` is unset.

---

## D10 — a contract locked before a validator tightening bricks its run

**Severity** high. **Status** **fixed 0.9.4**.

**Reported** 2026-10-28 by `axiom-lab-profiler` (message `01M61Q6A5ASQN4TJTA4C5RH5PT`), from live
goal `cbl514-scrutiny-ready` run `17122c97c001`, turn 574, paused with `contract unavailable after
restart; resume when ready`.

**Observed** the goal's locked generation contains `budget.rationale`, a free-text key that was
accepted silently by 0.9.2 and is rejected by the D9 validator in 0.9.3. The disk bytes had **not**
been edited; the lock predates the stricter parser. Three tools then refused for three different
reasons:
- `goal_manage resume` → "read-only (draft, archived or invalid)";
- `goal_propose_amendment` → "Disk contract differs from the locked goal" (it was the same bytes);
- `goal_recover_divergence` → "does not differ from the locked generation; nothing to recover"
  (correct, and the only true statement).
No worker-side path existed; only a human hand-edit of `goal.yaml` could clear it.

**Cause** `divergenceOf` required a parsable disk contract, so an invalid-but-identical lock read as
"no divergence"; `proposeAmendment` required `disk.contract` regardless of the lock; and validation
errors were reported as a generic read-only state.

**Fix**
- `parseContract` accepts `tolerateUnknownBudgetKeys` for the repair path only; the strict default is
  unchanged.
- `proposeAmendment` and amendment acceptance read the locked generation with that lenient option
  when the lock matches, so a repair diff can be staged and owner-reviewed instead of refused.
- `goal_manage` on an invalid live goal names the failing key(s), states that the disk bytes ARE the
  locked generation, and returns the exact `goal_propose_amendment` call; it no longer calls the goal
  read-only.
- `divergenceOf` reports differing bytes as a divergence even when the disk copy does not parse, so
  recovery is reachable and can explain an invalid edit.

**Regression** `test/host/invalid-locked-contract-repair.test.ts` seeds a paused run whose locked
bytes carry `budget.rationale`, asserts the resume refusal names the key and the amendment tool, then
stages and accepts the one-key repair and asserts the run re-locks to the corrected generation.
