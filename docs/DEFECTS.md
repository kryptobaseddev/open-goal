# Known defects — goal mode (register)

Opened 2026-10-17 by the session that ran v0.7.1, after the v0.8.0 fresh launch exposed a cluster of
continuation defects. Purpose: these are reproduced and evidenced here so they are **fixed and regression-
tested**, not rediscovered every time a goal chain runs. D11 and D12 were added 2026-11-02 from the live
0.9.8/0.10.1 repairs; they are engine-lifecycle defects, distinct from D1–D10.

Status legend: **open** · **partial** · **fixed** `<version>` · **by design**. Each fixed entry names the
release and commit that changed it and the test that now covers it; an entry is only moved to **fixed**
after the test file has been read, not from a CHANGELOG line. Open entries name what proves they are still
open.

| id | defect | severity | status |
|----|--------|----------|--------|
| D1 | A `fresh` launch injects the contract and no handoff or prior state | high | **fixed 0.8.0** |
| D2 | A restart pauses the run and demands an owner click | high | **fixed 0.8.0** |
| D3 | Accepting an amendment does not resume; a second prompt is forced | high | **fixed 0.8.0** |
| D4 | A superseded/interrupted decision re-surfaces long after the fact | medium | **fixed 0.8.0, hardened 0.8.1** |
| D5 | Completion offers `start-next` as a prompt, and can fire after a new run already started | medium | **partial** |
| D6 | An unknown `expect` key in a check is silently dropped, weakening the criterion | high | **fixed 0.8.0** |
| D7 | A contract can encode the inverse of the owner's intent and still validate | medium | open |
| D8 | `ocg tick` read the run store without a guard, so an I/O error crashed it | high | **fixed 0.7.1** |
| D9 | An unknown `budget` key is silently dropped, and the turn backstop is reported as an exhausted budget | high | **fixed 0.9.3** |
| D10 | A contract locked before a validator tightening bricks its run; resume, amendment and divergence recovery disagree | high | **fixed 0.9.4, hardened 0.9.8** |
| D11 | A plugin hot-load does not reach pre-existing sessions; their goal tool surface is gone until a fresh engine/session | high | fixed on main after 0.10.1 (T173, PR #19) |
| D12 | A dying engine's final `run.json` write can undo an owner-side repair | high | fixed on main after 0.10.1 (T172, PR #17) |

---

## D1 — a fresh launch carries no continuity

**Severity** high. **Status** **fixed in 0.8.0** (commit `dfec5be`).

**Fixed** the fresh-launch path writes `handoff.md`/`handoff.json` beside the contract from facts the
host already holds — prior run, lock, red baseline, HEAD/branch/dirty state, first plan step, and which
docs are authority vs stale — and the kickoff carries a bounded `<goal_handoff>` digest pointing at the
file (`writeHandoff` and the kickoff tail in `src/server/app.ts`; `src/engine/handoff.ts`). The
refusal variant (proposed fix 2) was not adopted: the handoff is written instead of blocking the launch.
`test/unit/handoff.test.ts` pins the builder and digest (prior run id, lock, baseline, next step, stale
docs, bounded digest naming `handoff.md`); `test/host/fresh-handoff.test.ts` covers the fresh navigation
path and the durable pointer. No host test asserts the digest text inside the first turn's prompt itself.

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

**Severity** high. **Status** **fixed in 0.8.0** (commit `dfec5be`).

**Fixed** `restartDecision` (`src/engine/interrupt-policy.ts`) resumes a clean restart — lock unchanged,
run intact, no write in flight — without an owner decision. A changed or missing contract, a
repaired/non-intact run, and an interrupted write still pause and name the cause.
`test/unit/interrupt-policy.test.ts` covers each branch; `test/host/restart-continuity.test.ts` performs
real reloads and asserts a `restart-resume` ledger event, no `owner-operation` decision, and an admitted
continuation after the restart.

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

**Severity** high. **Status** **fixed in 0.8.0** (commit `dfec5be`).

**Fixed** a form acceptance now resumes in the same act: the run records `amended`, `amendment-resumed`
and `resumed`, then admits the ordinary continuation with no new question. The same path serves native
form review and genuine Composer chat, and a recovered acceptance resumes on reload.
`test/host/amendment-continuity.test.ts` drives a staged amendment through the native form and asserts
one `amended`/`amendment-resumed`/`resumed`, a continuation admitted after the amendment, a live run,
no second owner decision and no leftover form. `test/host/amendment-continuation.test.ts` pins the
owner-text continuation path (plain acceptance stays stopped).

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

**Severity** medium. **Status** **fixed in 0.8.0** (commit `dfec5be`), **hardened in 0.8.1** (commit
`00ad2d3`).

**Fixed** answered, expired, superseded and generation-changed reviews are silenced with a
`decision-silenced` ledger event and are never re-presented; `goal_review` refuses a stale review instead
of minting a replacement. 0.8.1 made `shouldReaskDecision()` a pure once-per-process policy (an open form
never duplicates, an already-asked review never re-asks) while keeping the one legitimate restore case: a
dismissed (`interrupted`) review is still unanswered and `goal_review` may restore it.
`test/unit/stale-decisions.test.ts`, `test/host/stale-decision-silence.test.ts` (answered, expired,
superseded across a reload) and `test/host/decision-ask-once.test.ts` cover it.

**Reproduced** decision `472d7d85-dfba-44ab-96bf-bedb16d56490` (archive v0.6.0 goal) was created
`2026-10-16T23:49:56Z`, **14 ms after** the v0.7.0 launch resolved. It sat `interrupted`, then re-surfaced
~34 minutes later through `reaskDecisionForm` (`src/server/app.ts:1963-1970`, T075) when a turn ended. The
owner saw the prompt with no context for why it existed, and it took three asks before one bound.

**Proposed fix** never re-present a decision whose target is superseded (there is already a `supersede-ack`
kind), expired, or already answered; and make a re-presentation incapable of minting a second ask.

---

## D5 — completion asks "what next" instead of continuing

**Severity** medium. **Status** **partial** — automatic continuation shipped in 0.8.0 (commit
`dfec5be`); the fallback question and the already-started guard remain.

**Fixed** after a goal completes, the loop looks for a ready CLEO item before it reports completion and
starts it in a new session from the task's own acceptance, linked back to the task id. A started item is a
notification plus `continue-work` ledger events; no completion decision is created.
`test/host/continue-work.test.ts` completes a goal with a fake `cleo` on PATH, asserts the generated
`cleo-t900` contract, the new session, and that no `complete` decision exists.

**Remaining** when there is no ready item (or the project is not CLEO-linked), `M.completeDecision`
still creates the completion decision and offers `Start the next goal` with `act:"start-next"` as a
prompt (`src/server/messages.ts:220`, dispatched at `src/server/app.ts:3091`, pinned by
`test/host/complete-decision.test.ts`). Nothing suppresses that question when a successor run is already
live; the C4 path avoids it only by returning `continued: true` from its own automatic start.
`test/unit/tui-dashboard.test.ts` also still expects a terminal row with `act: "start-next"`.

**Reproduced** at the end of v0.7.1: the completion decision `343a81a8-dd9f-490a-85b5-dea892ba7881` asked
"what next?" **after** the v0.8.0 run had already been launched, so its "Start the next goal" option had
nothing to start.

**Cause** `src/server/messages.ts:220` offers "Start the next goal" with `act:"start-next"`; handled at
`src/server/app.ts:3091`. In the no-ready-item fallback it is still a prompt, never automatic.

**Proposed fix** this is the v0.8.0 C4 work: start the next ready item and record a notification. Also
suppress the completion question when a successor run is already live.

---

## D6 — an unknown check key silently weakens a criterion

**Severity** high. **Status** **fixed in 0.8.0** (commit `dfec5be`).

**Fixed** `src/contract/parse.ts` now rejects any `expect` key outside `exit`, `stdout_contains` and `stdout_regex` (and `runs`), naming the offending key; `test/unit/check-keys.test.ts` pins it (unknown key named, typo rejected, supported keys keep their meaning, and an omitted `expect` still defaults to `exit: 0`).

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

**Severity** medium. **Status** open — related stop-rule work shipped in 0.8.0, but neither guard that
would catch inverse intent is implemented.

**What changed (does not close it)** the contract's stop rules now exist as code and are tested: a human
criterion, a real blocker, an outward/destructive act, a first visit to a new project, and an exhausted
budget stop the loop, with `autonomy.visit_new_projects` and `autonomy.continue_past_budget` as explicit
opt-outs (`src/engine/loop-stop.ts`; `test/unit/loop-stop-rules.test.ts`). The contradiction between the
C6 wording and the owner's interview answer is recorded verbatim in
`docs/research/proactive-continuation.md` ("known contradiction"), not silently resolved. That makes the
stop behaviour explicit; it does not make an inverse-intent clause fail validation.

**Why it is still open** both proposed guards are absent. (a) `skills/write-goal/SKILL.md` states no
positive-phrasing rule for stop rules. (b) `stop.when` is free text (`src/contract/types.ts:143`; parsed
at `src/contract/parse.ts:366-435`) with no stop-rule vocabulary, so a contract that says "SHALL NOT
continue past …" still validates cleanly. This register's own reproduction therefore stands: the owner
can still get the inverse of their intent, and only a human reading the diff catches it.

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
`test/unit/tick-record.test.ts` pins the absent, empty, unreadable-store, unreadable-record,
unreadable-record-beside-a-live-run, unreadable-contract and unparsable-contract cases, including that a
degradation wrote nothing to the run it could not read.

Found by the goal's own C1, which is why the release is v0.7.1 rather than v0.7.0.

---

## D9 — an unknown `budget` key is silently dropped, and the backstop wears the budget's name

**Severity** high. **Status** **fixed in 0.9.3** (commit `d60c771`).

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

**Evidence at the pins** `test/unit/contract.test.ts:43` asserts the exact
`budget.max_turns: unknown key; allowed: turns, wall, tokens, cost_usd` error;
`test/unit/loop-decision.test.ts:90` asserts `status: "backstop_limited", code: "backstop"`;
`test/unit/tui-format.test.ts:52` asserts the banner names `budget.turns`.

**Immediate workaround on 0.9.2** rename the contract's `max_turns` to `turns` (and `max_tokens` to `tokens`,
`max_cost_usd` to `cost_usd`) and amend again; the backstop only applies while `budget.turns` is unset.

---

## D10 — a contract locked before a validator tightening bricks its run

**Severity** high. **Status** **fixed in 0.9.4** (commit `5a349ac`), **hardened in 0.9.8** (commit
`88f364b`).

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
`test/host/recovery-hardening.test.ts` adds the 0.9.8 cases: a paused run that exists only on disk can
stage the repair, a locked snapshot that predates the validator backs divergence recovery (the prior is
read tolerantly, the adopted contract is still validated strictly), and the same run can resume.

**Residual, not this defect** `goal_recover_divergence` still resolves the run from the in-memory map
(`src/server/app.ts`, `recoverDivergence`), so a run that exists only on disk must be mirrored by a read
path before recovery can target it. 0.9.8 fixed the amendment lookup and the locked-snapshot read, not
recovery's own lookup; it is listed as a separate open item in `docs/HANDOFF-2026-11-02.md` and is not the
D10 brick (resume, amendment and divergence now agree on the invalid-but-identical lock).

---

## D11 — a hot-load does not reach pre-existing sessions

**Severity** high. **Status fixed on main after 0.10.1.** Tracked as CLEO **T173** ("Reload atomicity and
disk-backed reads", done 2026-11-02, PR #19). The fix: registration is one unit gated on recovery,
reads fall back to disk when memory is empty or stale, and `/goal reload` reconciles a pre-existing session
without a restart; `test/host/reload-atomicity.test.ts` covers a reload mid-session with a paused run.

**Observed** 2026-10-28/29 from live repairs. After `@cleocode/goal@0.9.8` landed, the agent in
`axiom-instrument-studio-tbl6run` lost its **entire goal tool surface**; only a fresh engine/session
regained it. The same session then could not resume its own paused run (`docs/HANDOFF-2026-11-02.md`,
"Known defects still open" item 1).

**Why it is still open** `src/server/index.ts` keys one `GoalApp` per location: `setup()` retires the
previous instance and registers the new app's tools, but nothing reconciles a session that was already
open before the hot-load. There is no test that reloads mid-session with a paused run and asserts the
existing session keeps a complete tool surface; T173's four acceptance criteria (tools registered after
recovery, disk-backed reads when memory is empty/stale, hot-load reaches existing sessions or a supported
reconcile does, and a host test for exactly that) are all still unmet.

**Proposed fix** per T173: finish the disk-backed read fallback, then either push the new registration
into live sessions or provide one supported reconcile that does not require a service restart.

---

## D12 — a dying engine's final write can undo a repair

**Severity** high. **Status fixed on main after 0.10.1.** Tracked as CLEO **T172** ("Stale-writer guard for
run state", done 2026-11-02, PR #17). The fix: a monotonic run revision plus writer identity, a refusal when
disk is ahead (`stale`/`superseded`), one ledger receipt per refused generation, and
`test/host/stale-writer.test.ts` reproducing the dying-engine write.

**Observed** twice in live runs: `cbl514-scrutiny-ready` and `tbl-six-class-production-run`. An owner-side
repair (the `budget.rationale` lock repair) was reverted when the dying engine's final `run.json` write
landed after the repair. The handoff records it as item 2 and the 0.9.8 release notes name it as still
open.

**Why it is still open** `GoalStore.writeRun` (`src/engine/store.ts`) always writes the caller's in-memory
state through a temp file and `rename`, with no comparison against the on-disk lock or generation. A
process that still holds the pre-repair state can therefore overwrite a newer valid generation. Nothing
journals a refused stale write, and `test/host/run-state-write-guard.test.ts` covers only agent/tool writes
into a live goal folder, not a second engine process. T172's acceptance (a process may not overwrite a
newer valid on-disk generation; a refusal journals a receipt naming both generations; normal persists and
amendment commits still write; a host test reproduces the dying-engine final write) is unmet.

**Proposed fix** per T172: a compare-and-write guard on `run.json` keyed by runId/lock/generation, with a
stale-write ledger receipt and a host test that holds an old state across a repair.
