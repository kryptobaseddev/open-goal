---
title: 'Dogfood 6: goal manager and conversational lifecycle'
audience: maintainer
status: in-progress
---
# Dogfood 6: goal manager and conversational lifecycle

## v0.3.7 is installed; the original resumed run is still unfinished

Current audit snapshot: **2026-10-12 14:14 UTC**, refreshed from the renewed delegation, project goal inventory, CLI records, and all three deployed QA artifact/transcript/provenance sets. This section supersedes the current-state claims in the preserved v0.3.6 audit below. It is a documentation draft, not a host verdict, manual sign-off, or authority to perform another owner operation.

Immutable **v0.3.7** resolves to `a668c278a1401e712d8a714d26df85615f836ed7`; this author re-read both Git HEAD and the tag commit. Earlier v033–v036 tags were not moved. Parent-scoped provenance reports the actual original session serving v037 under **PID 81869**, at `/Users/keatonhoskins/projects/opencode-goal`, with loaded server/UI/skill artifacts. Mandatory compiled `dist/tui.js` SHA256 is `79c9e76ef8626ba70bc434888595af7bffdab1bf965ec9738b566c8804def528`. Exact live ancestor/location/tag/full-artifact comparison passed (`d19df402-ebf8-4233-94a9-a4fcf7682573`, minimum v037, release assertion enabled). These are the parent's exact-session receipts, not this documentor's host or a newest-cache lookup.

The parent reports a genuine native **Composer** Resume answer for decision `e921598b-26b7-4ae6-a9f9-d917c74680fc`, with bound/answered/resolved all true. Fresh project `goal_inventory` independently returns **waiting**, turn **38**, **1/17 proven**, with the same original identity. The authorized resumed run is in an inspection/coordination wait, not complete or replaced:

- key `live:ship-v033-goal-manager-flow:12739b68c001`
- session `ses_ef2b88fafffe4V1lcmyHNrsC60`
- run `12739b68c001`
- lock `1ef34fbfead905f629a45cba6c7252987491c78fd291471c6cff9eb2fb784236`

No new run, replacement contract, cleared history, or manual criterion grading. **S1–S7 are done in the plan; S8 is active.** In particular S5/S6/S7 progress is recorded done, subject to independent criterion review. Plan progress is not criterion proof: the actual criterion board remains 1/17 and no final goal claim has been made. Historical consumed approvals and expired v035/v036 forms still aren't reusable consent. The original installed-engine verification and independent review remain outstanding.

### Published fixes retain their distinct authority and failure scopes

| Task | v037 behavior and retained finding |
| --- | --- |
| T086 | Native Composer forms are the sole lifecycle/amendment decision surface. Exact target/generation binding survives elapsed time and reload without an arbitrary lifecycle clock. Changed targets, commentary, cancellation, and replay still fail. Legacy delivery and launch reviews retain strict expiry; this is not a blanket expiry waiver. |
| T087 | Durable visible launch disposition, pre-run admission/rehearsal progress, and draft/launch review recovery. A recovered review requires new real consent. The reported VidaPeps v036 choice had the correct label but expired with no successful ledger resolution; it wasn't a launch success. |
| T088 | Actual v036 original-run turns 10–36 repeatedly failed with `Model unavailable: openai/gpt-6.1-sol`. Admission success incorrectly decremented the execution-failure counter, leaving failures at 1. v037 pauses non-transient unavailable-model failures immediately, bounds transient retries, and clears the streak only on actual `execution.succeeded`. Red unavailable-model test timed out at 15 seconds (`d3379b20`); repaired host tests passed 2/2, 11 assertions (`8a5bcbda-28b1-4302-9724-8b410d53cb21`). No provider change or consent bypass was used. |
| T089 | Stopped-goal progress returns structured `recorded:false` with current status/session/run, without mutation or resume. Active progress still records normally; the guard is unchanged. An over-400-character agent call was also invalid; both note and next remain limited to 400 characters. |
| T090 | Owner-selected **Repair current manager** ships native-theme fixed header with visible **Close**/**F9**, compact facts/plan/proof, word-wrapped scrollable detail, pinned actions, Tab section focus, and inline action feedback. Fullscreen panel ownership can actually report `panel.current = null`; resize/focus restoration handles that condition without progress refresh stealing input. |

T090's failures remain meaningful: zero-height/shrunk headers and overlapping text, a status toast stealing focus, then a separate fullscreen ownership/resize blur even after removing the toast. The latter supersedes the incomplete popup-only diagnosis. The final compiled/native render set passed **13 tests**, receipt `80cb593d`, including 48/110-column and 22/30-row layouts, a long outcome, 17 criteria, exact-target keyboard/pointer actions, and Close/F9 restoration. This is OpenTUI evidence, not a browser WCAG audit. It doesn't warrant an “all bugs fixed” claim.

### Current proof is scoped to the exact artifact and actual tested files

| Proof | Result and scope |
| --- | --- |
| Fresh committed native JUnit | `.tmp/verification/v037-committed/tests.{xml,json}`: **138 passed, 0 failed, 0 skipped, 811 assertions, 42 actual named files**; receipt `d2e4c9ee-1635-4f7d-8220-eb4c2c9a27a0`; source XML SHA256 `75235de1144c438eabd8305ab3518c98fdd28408261682b22481c518386a69af`. This author re-parsed all 138 cases/42 file attributes and checked XML/summary hash and counts. |
| Pre-commit native proof | Also 138/42, receipt `a06022a2`; `.tmp/verification/v037-release/tests.{xml,json}`, XML SHA256 `aeebdfed9abdaea49c3225d697049a505f9f409c5b3128b1e5ca6cdd15bff076`. It remains pre-commit proof, not relabeled as the later fresh committed run. Earlier 131/41-file timing failures are retained. |
| Source real PTY | **Nine controls passed**, receipt `85c9283b`; artifacts `/private/var/folders/9f/83wg9xhx7hg_6vfc0dks52f00000gn/T/opencode/goal-manager-gates/1791788942744-49709`. Fixture provider, not real-model QA. |
| Exact installed-tag real PTY | **Nine controls passed**, receipt `26f68bac`; artifacts `/private/var/folders/9f/83wg9xhx7hg_6vfc0dks52f00000gn/T/opencode/goal-manager-gates/1791789830821-84959`. This author read `pty-result.json` and `result.json`: pass true, PTY exit 0, fixture provider. Controls are two cards, goal-less manager, expand-before-jump, explicit jump, selected Pause isolation, narrow focus/bounds, visible Close/sidebar, F9 reopen/selected focus, and fresh-tab focus. |
| Published git-install/cache negatives | **2/2 passed**, parent receipt `6afb298e`; not proof of real-model behavior or production owner consent. |
| Covering types/generated freshness | Parent receipt `f2eb04c7` passed; T090 fresh `tool:typecheck` receipt `a9311f22` is also recorded true. No lint run or browser tier is invented. |

Receipt prefixes above are deliberately abbreviated where the delegation supplied only prefixes. SDK teardown `ECONNRESET` and OpenTUI anchor warnings remain disclosed even in passing runs. Native file counts come from actual XML testcases, not command arguments. Protected-oracle/history diffs were empty in the parent's release checks. This author made no source, config, CLI, test, contract, archive, tag, commit, or installation changes and ran no heavy checks.

### Current v037 interview, manager, and lifecycle passed in isolated QA

Supplement received **2026-10-12 13:51 UTC**: current v037 real-model interview and native-approved fresh launch passed, governed receipt `3c05345f-f05d-4ee6-a3a1-db8aa46b7ed1`. Root `/private/var/folders/9f/83wg9xhx7hg_6vfc0dks52f00000gn/T/opencode/real-model-goal-2ZQ5pL/qa-evidence`. This author inspected `context.json`, `answers.json`, `provenance.json`, and `run.json`: automated QA owner true, fixture false, scratch **PID82145/OpenCode2.0.26**, exact v037/a668 revision and compiled UI hash above. Native answer **Start goal now (Recommended)** binds author `ses_ecfa3be2affetXsRzmmb83TUa0` to fresh root `ses_ecfa0cd6fffeJq5zW2MLxmruct`, run `1305f32a7001`, preserving `build` and `openai/gpt-6.1-sol`, variant `high`. The run was waiting for inspection, with no completion claim. The scratch choice requests direct host checks only, no verifier/human criterion or budget, so it doesn't prove the original independent verifier.

Supplement **2026-10-12 13:57 UTC**: current v037 real-model manager passed, receipt `84481553-2712-44fe-b1c4-bdd2644acacd`. This author inspected `manager-pty/{result.json,pty-result.json,provenance.json}` in that same QA root: pass true, exit 0, eight native controls (two rendered cards, goal-less manager, expand-before-jump, explicit session jump, selected Pause isolation, narrow focus/bounds, Close/sidebar, and F9 reopen/selected focus). `qa-manager-one` was paused while `qa-manager-two` stayed waiting. Provenance remains scratch PID82145, exact v037/a668, and matching compiled UI hash. This eight-control real-model manager gate doesn't include the ninth fixture gate's fresh-tab-focus check; that fresh handoff is separately bound by the current interview result. Per-check native captures and real-model transcripts remain at the QA root.

Supplement **2026-10-12 13:58 UTC**: conversational same-run lifecycle QA passed, receipt `905aad9a-41ce-472e-83e0-5f1449b746fe`. This author inspected `lifecycle-{result,ledger,provenance}.json` and the transcript's genuine owner prompt. Before/after retain session `ses_ecf9cc6c3ffeugKKrlbnytnjGc`, run `1306339f6001`, and lock `bf82f2a7e138c31f833d7dd4db58caf95acecd4c9dbb7b9d766821b841982f5d`; paused → resumed → waiting for inspection. Exactly one host `owner-message-consumed` event binds QA message `msg_13066d1a3001F1OLVqpEH9NnBg` to decision `05cc9ba6-e033-492b-83cd-c4f8347568cf`, followed by one resumed event and one successful `decision-resolved`, via `owner-message`, `ok:true`. `forms:[]`, automated QA owner true, fixture false; exact-v037 scratch PID82145 provenance and UI hash remain intact. No new run or completion claim.

These are now three current-v037 deployed QA successes: interview/fresh launch, eight-control manager, and conversational lifecycle. **C13 is not manually graded or claimed host-proven by this document.** The original criterion board and independent review still decide acceptance. QA answers aren't manual sign-off or original-session consent. Don't substitute scratch PID82145 for the production PID81869 binding.

At the 14:14 audit this author re-read all three JSON provenance/result sets and all five real-model transcripts: `author-transcript.json`, `fresh-transcript.json`, `manager-pty/first-transcript.json`, `manager-pty/second-transcript.json`, and `lifecycle-transcript.json`. Their GPT model messages and goal-tool traces were inspected; native launch answers and handoff agent/model agree, manager first/second state isolation agrees, and the original QA user prompt matches the once-only lifecycle ledger. This was read-only inspection of completed evidence, not rerunning the model, synthesizing a report, or operating an owner form.

Retain older real-model successes with their revisions: v036 receipt prefix `53fc6fa4`, scratch suffix `zdjCzy`; v035 scratch `rDMLI8` with interview/manager/lifecycle successes detailed below. Those used automated QA-owner choices and actual GPT model calls. They aren't manual owner sign-off, original-session consent, or current-v037 proof. Conversely, the source and exact-installed nine-control PTY gates above use a scripted fixture provider; “real PTY” doesn't mean “real model.”

### Task completion is separately blocked by a confirmed CLEO defect

Fresh `cleo show T090 --full` returns **pending**, despite AC1's `implemented`, `testsPassed`, and `qaPassed` gates all true. Evidence is bound to exact commit `a668c278a1401e712d8a714d26df85615f836ed7` and tree `54e120e889197369e5603d5429bb876ca8b0feb6`, including the fresh post-landing 138/42-file report. `readyToComplete:true` is not a successful completion receipt.

Actual `cleo complete T090` attempt `bc8caf8d` **exited 45**, refusing scoped-run carry across landed ancestry because the merge identity was unknown. Parent reports the CLEO maintainer confirmed **T13608 (high)** on both 2026.10.9 and main: no merge-SHA source/empty change-set fast-forward ancestry incorrectly rejects an already post-landing scoped report at the current HEAD/tree. The fix is reported merged in **#2171 / `823b0f70`**, but not published; this author's fresh `cleo --version` returned **2026.10.9**, and the supported 2026.10.10 release is still awaited. No whole-suite run, waiver, branch trick, relabeled report, or global CLI edit was used. This bookkeeping defect does not erase shipped UI proof or block unrelated evidence collection; it does prevent saying T090 is done.

Owner clarification: **“cleo-mac-dev coordinating next release install.”** The parent requested a verified coordinated install receipt; it will **not self-upgrade or interpret this coordination statement as global installation/configuration approval**. Await the supported release and that agent's actual installed-version receipt. Any additional owner authorization stays explicit in the native decision flow. A merged fix, promised release, or coordination message alone doesn't prove the CLI changed or T090 can close.

Fresh CLI hierarchy and goal inventory are distinct:

- **Five goal contracts**: unfinished, resumed/waiting original `ship-v033-goal-manager-flow`; complete live-folder `ship-v031-launch-experience` and `ship-v032-trust-the-card`; complete archived `dogfood-buildout` and `ship-v03-feedback-loop`. Historical plan steps can lag terminal goal verdicts and must not be rewritten.
- **T002 pending**, 39/54 direct children done; **T076–T090 all pending**. Code implementation/test receipts are not task completion. T076–T084 retain earlier implementation evidence; T085–T089 still require their own acceptance/gate bindings. T090 alone has the inspected three true AC1 gates and the explicit completion refusal described above.
- **T001 pending**, 1/4 child epics done (T024 done; T002/T035/T039 pending). It requires direct plugin load, persistence, host verification, live TUI, and skill proof plus child closure.
- **T035 pending**, 3/3 children done; its own acceptance requires the council-decided rehearsal, stopped-state integrity, and generation-bound owner amendment model.
- **T039 pending**, 4/4 children done; its own acceptance names immutable v0.2.0, dogfood-2's successful real-model verifier round, host scenarios, and synthetic continuations.

T002 still explicitly names isolated OpenCode **2.0.22** git installation, end-to-end false-claim rejection and verified completion, real TUI, and registered skill. Neither newer QA by similarity nor completed children silently satisfies these parents. No saga/epic/task ID is a goal parent.

### Finish the existing run without rewriting its history

Parent-owned next steps: bind the three inspected exact-v037 real-model QA successes to their appropriate acceptance criteria; await cleo-mac-dev's coordinated supported T13608 release/install receipt without self-upgrading, assuming approval, or bypassing scoped proof; bind each pending task's actual AC/test/QA evidence; complete T076–T079 with valid gates as C14 requires, and explicitly explain pending T035/T039/T002/T001 against their existing acceptance without adding legacy-epic completion to this goal; and obtain the original run's installed-engine checks and independent verifier verdict. S8 is active; no final goal claim or task completion is recorded here. Use `CLEO_SESSION_ID=ses_20261010192447_c707f7` for scoped CLI bookkeeping. Don't invoke a default whole-suite plan, silently upgrade a global CLI, or reuse expired/consumed decisions. Uncommitted real-model QA driver scripts are parent diagnostics and remain untouched.

This update maintains existing SSoT slug `goal-manager-dogfood-6` and mirror `docs/dogfood-6.md`. Current handoff successor is `opencode-goal-handoff-v037-2026-10-12`, mirrored to [the current handoff](HANDOFF.md). The alpha, exact legacy v032, and v036 handoff slugs retain their original bytes. This section comes from parent-scoped receipts plus fresh read-only goal inventory, Git identity, CLI records, JUnit/hash verification, and PTY-result inspection; it doesn't independently certify the parent's un-fetched runtime receipts.

## Closure-scope clarification

Fixed C14 requires verified T076–T079 task completion and permits pending parent work to be reconciled or explicitly explained. Historical parent acceptance is not new v0.2.0/OpenCode2.0.22 implementation work or an added prerequisite for this goal. Current plan S1–S7 is done and S8 active; plan state is not host criterion proof.

## Historical v036 audit — retained, not current state

Everything below is the unchanged body of the approximately 00:13 UTC v036 audit (previous SSoT SHA256 `bccb768876bdb89ab32835024b7b79b0b1c23e7ea2229a9b0492c341686f79f0`). Its paused-run, pending-installation, and missing-Resume statements describe that earlier snapshot only. The current section above supersedes them; failures and scoped evidence remain historical evidence, not newly executed proof.

## v0.3.6 is published; installed proof and original-run completion remain open

Audit snapshot: 2026-10-12, approximately 00:13 UTC. The original run is `ship-v033-goal-manager-flow / 12739b68c001`, in session `ses_ef2b88fafffe4V1lcmyHNrsC60`, with fixed lock `1ef34fbfead905f629a45cba6c7252987491c78fd291471c6cff9eb2fb784236`. Project `goal_inventory` still reports **paused**, 1/17 proven, turn 5. No replacement run was created, original history was not cleared, and historical goal evidence was not rewritten. This document is a draft, not a completion claim or manual owner sign-off. Installation v0.3.6 was queued at delegation (`sh_12d6829f400153vU9ywLAEcOyL`); this audit has no inspected exact-session installation receipt and makes no live-v0.3.6 claim or genuine production Resume receipt claim.

Historical v0.3.5 failure: clicking **Resume** in the actual production popup had no effect; the parent reports pending decision `7c9c…` expired/interrupted without a successful ledger resolution. Earlier source inspection found the `form.asked` listener. T085's correction is now published in v0.3.6, with source and compiled-test proof described below, but its installed final gate and original-run owner operation are not yet proven. The wrong event alone was not established as the full root cause: a ticker also retried, and expiry, dismissal, missing waiting feedback, and failed-resolution feedback required guards. Earlier PTY/conversational passes don't retroactively prove the failed popup path. No claim that all bugs are fixed or final completion is warranted.

Four immutable releases are preserved:

| Release | Git revision | Purpose |
| --- | --- | --- |
| v0.3.3 | `c0f6c139b71444eca0abe59cea70b8749f983b95` | Conversational lifecycle and project manager |
| v0.3.4 | `693b0f39590feff5208702d2dd878138c0f64a32` | Consume genuine explicit owner resume consent once |
| v0.3.5 | `9f49b43ca60b808ad9f5e4237c1621befb68dd61` | Ship deterministic, reactive compiled TUI JavaScript |
| v0.3.6 | `0bebf6d3570c45af54d8360e5064198781cbcc4f` | T085 popup delivery/expiry/dismissal guards (`16e8173`) and explicit typed-test entry (`0bebf6d`) |

## Final v0.3.6 source proof is not installed or owner-operation proof

- Final native report `.tmp/verification/v036-0bebf6d/{tests.xml,tests.json}`: **40 passed, zero failures/skips, 254 assertions, 14 actual files**, receipt `89833722-c385-424e-8f35-2b6fa8ef9baf`. This audit parsed all 40 XML testcases and 14 distinct file paths and verified source SHA256 `7562931f669289eae9ce6148a5f176cdda769354d5e23adb11f0143c9d2b9aec`. The four compiled-popup cases cover pre-form delivery exactly once, expired choices executing nothing, unrelated forms/failed-result visibility, and native dismissal withdrawing an undelivered pick. It includes banner-transition, statement-only amendment, and unit amendment coverage missing from the prior 111/29-file run. It does not replace fresh typed-gate execution for the complete declared file sets.
- Covering typecheck plus generated-byte freshness passed: `fef04c63-72fe-4c75-b38d-2aa8bd963b76`. Published v0.3.6 artifact/cache negative tests **2/2** passed: `5633ec56-7192-41dd-a55e-29d83704c8bb`. These parent receipts are not a substitute for this original session's actual loaded root/revision/UI/skill provenance.
- Source pointer-popup nine-check PTY passed: `013c7bed-b876-4936-a917-298541b2c32f`; artifacts `/private/var/folders/9f/83wg9xhx7hg_6vfc0dks52f00000gn/T/opencode/goal-manager-gates/1791760949321-48797/`. Inspected `pty-result.json` includes delayed native popup and popup-resume-delivered-once. Audit re-read `demo.ledger.jsonl`: exactly **one resumed event and one successful resume decision resolution**. This gate preceded the last compiled cancellation addition; the four-case unit set passed afterward. The current driver explicitly requires `firstResumes == 1`; that final driver/compiled artifact combination still needs the installed rerun.
- Candidate failures remain evidence: first driver assumed a SelectRenderable instead of the host popup's real pointer row handlers/bounds; second observed the route before native tab hydration. The gate now requires both the route and the active hydrated native tab. No assertions were weakened. SDK teardown ECONNRESET and OpenTUI self-anchor warnings remain disclosed.

No new original owner consent was fabricated. The previous interrupted/expired question and already consumed original message do not authorize a new resume. A source/fixture QA resume is not the production original run resuming under v0.3.6.

## The typed-test entry correction preserves the tests and still needs fresh gates

CLEO core 2026.10.8 captured Bun's `test` subcommand as a path to `./test`, a directory. The parent audited `req replace` for T080/T081/T082 to invoke `bun scripts/run-scoped-tests.ts` with the **same named test files**, native output/exit, `expect: exit0`, REQ IDs, and acceptance descriptions. This audit read the current stored acceptance and wrapper source. The entry rejects empty inputs, options, globs, directories, symlinks, absolute/escaping paths before spawning Bun tests; its refusal test is in the final 40 passes.

This changes the fingerprinted command entry, not the oracle assertions or their semantics. No installed CLI/cache/global configuration was edited. Prior capture errors remain historical; new command hashes require fresh typed execution and criterion evidence. No gate is waived or assumed cached, and this documentor did not change any acceptance or run any tests.

The parent reports v0.3.5 installed in its actual project/session under serving PID **8405**. That production binding must be proved by the parent's exact-session provenance, not substituted with this audit's QA host. The separate QA evidence below is explicitly bound to **PID 82145**, OpenCode 2.0.26, endpoint `http://127.0.0.1:49374`, and scratch location `/private/var/folders/9f/83wg9xhx7hg_6vfc0dks52f00000gn/T/opencode/real-model-goal-rDMLI8`. It is not evidence that PID 82145 serves the original project run now.

The QA provenance identifies installed package root `/Users/keatonhoskins/.cache/opencode/npm/git-opencode-goal-271fb756a122/1791752166105/node_modules/opencode-goal`, exact tag v0.3.5 and revision `9f49b43`. Mandatory `dist/tui.js` SHA256 is `60609ac9e6a75d0e093904ce8beab0e3c7ba8ee97cef6c37488c0ec15405ddbc`. Read-only byte comparisons of Git, installed package, and checkout agree for this artifact and sampled manager/server/amendment source files. A newest-cache lookup or version label alone is not installation proof.

## Focused automated proof is retained with its original scope

- Committed v0.3.3 candidate: **119 passed**, zero failed/skipped, across 34 named files. Native JUnit and lossless summary remain at `.tmp/verification/v033-c0f6c13/{tests.xml,tests.json}`. XML SHA256: `a6a55b647d09cfc91a885af1f3a0eaecf08f892790fbcd690cdd470fe5da18cb`; resource receipt `69e9261c-c916-42eb-b89e-5a81c6b1b044`. This is historical c0f6c13 evidence, not a newly executed v0.3.5 run.
- Immutable old/new cache and published-tag proof: **2 passed** (`9b730ae0-d5ac-4e10-a171-699737f8298e`). Identical version labels with old revision/UI bytes failed the artifact comparison.
- Original fixture-provider two-goal PTY: **seven checks passed**, including native pointer expansion/pause, keyboard explicit jump, confirmation, 70-column focus/bounds, and fresh-tab focus. Artifacts: `/private/var/folders/9f/83wg9xhx7hg_6vfc0dks52f00000gn/T/opencode/goal-manager-gates/1791715381809-1761/`; receipt `afb71282-cc6c-4d17-a7e5-a1b46f1b7c72`. This was not a real-model interview.
- T083 baseline failed on explicit owner approval (`28a17e41-5707-4b58-bca0-762b473c45f1`). Repaired nearest authority/review set: **34/34** across nine files (`88cda729-85be-428b-b46a-e55f3b01cfed`). Final source/generation/replay and missed-execution-start set: **13/13** across four files (`49f88bb1-d2dd-47cb-a970-edbd23df4a9c`), retained at `.tmp/verification/v034-693b0f3/{tests.xml,tests.json}`. XML SHA256: `1ddc9d1d078968ea59d58daaa06e878000e591eacff594f32c42b0514c4ffe74`.
- v0.3.4 published installation/artifact tests: **2/2** (`2a89e48c-d7b6-4d2a-b115-f5cafc711a20`). Covering typecheck after the final T083 edits passed (`376e00ae-26df-4247-8924-7f5a58b76905`).
- For v0.3.5, the parent reports **9 passed** in source/installed native delayed-inventory reactivity tests, **2 passed** in compiled-artifact/release tests, and a covering typecheck/freshness pass. The T084 builder observation `O-mv47wy1t-0` records earlier source, compiled refresh, authority, and typecheck proof. Their native output/receipt paths still need binding into the final CLEO evidence; this audit did not rerun or invent those reports.
- Final v0.3.5 focused source regression receipt `fa2ad532-dd81-48f8-ba01-3cf7f2d1c713`: native JUnit `/private/var/folders/9f/83wg9xhx7hg_6vfc0dks52f00000gn/T/opencode/v035-final-tests.xml` reports **111 passed**, zero failed/skipped, 619 assertions. This audit parsed all 111 actual testcases and counted **29 distinct real files**, not 30 command arguments. XML SHA256: `4c9938e5ddd5106930e605841563a5a7d9f5a821cddf729e1673bd97dc0aa3b2`. The requested `test/host/banner-refresh.test.ts` doesn't contribute any testcase. Actual `test/unit/banner-transition.test.ts` is absent and still needs its focused proof. Also absent are `test/host/amend-statements.test.ts` and `test/unit/amendment.test.ts`, which are part of T081's declared typed gate; retain their historical c0f proof and bind their current focused results before closure. This 111-test report proves neither the unresolved T085 race nor code changed after that run.
- Installed v0.3.5 full fixture-provider PTY receipt `5bb3e17b-65cb-470e-91d6-1a3ab955e652`: `/private/var/folders/9f/83wg9xhx7hg_6vfc0dks52f00000gn/T/opencode/goal-manager-gates/1791753455245-2475/{result.json,pty-result.json}` reports **seven checks passed**, PTY exit 0, including `fresh-tab-focus`. The parent reports `OCGOAL_GIT_SPEC` pinned to v0.3.5. Actual screen/tree/state captures are retained per check. This installed-tag gate is separate from the earlier source/fixture gate and from real-model QA; it does not cover a late-arriving popup form unless its reproduction explicitly exercises that race.

Passing earlier tests emitted SDK teardown ECONNRESET and OpenTUI self-anchor warnings. The governor queued jobs; admission was not bypassed. No heavy test, typecheck, build, install, production source, tag, cache, or provider configuration was changed by this documentation audit.

## Real-model v0.3.5 QA now has an inspected manager result

QA root: `/private/var/folders/9f/83wg9xhx7hg_6vfc0dks52f00000gn/T/opencode/real-model-goal-rDMLI8/qa-evidence`.

The interview and approved fresh launch passed under parent receipt `551b9b05-dd85-4639-b830-0603eb3fd0e3`. Inspected `context.json`, `answers.json`, `provenance.json`, and `run.json` bind author `ses_ed3378cbcffe6Yb9GO2KY5PGfO` to fresh root `ses_ed3363491ffeIPl8DitiCZP77p`, QA run `12cc9cb89001`. The native launch answer is the offered **Start goal now (Recommended)**; handoff preserves `build` and `openai/gpt-6.1-sol`, variant `high`. The marker was inspected and the run waited without a fabricated completion claim.

At audit time, actual `manager-pty/result.json` reports `pass: true`, `exit: 0`, exact revision `9f49b43`, `providerIsFixture: false`, and `automatedQATestOwner: true`. `manager-pty/pty-result.json` lists **six passed checks**: two rendered cards, goal-less native manager, expansion before jump, explicit session jump, selected-action isolation, and narrow focus/bounds. Per-check screen/tree/state files and first/second real-model transcripts are retained there. Selected `qa-manager-one` became paused while `qa-manager-two` remained waiting. This observed result replaces the earlier pending status; it does not imply that every original seven-check fixture phase was rerun in this six-check deployed gate. Governed manager receipt: `c74841f7-eaf1-40c8-885f-b3b753213388`.

These are automated QA owner choices against a real model, **not manual human approval** and not consent to resume the original project run. The scratch contract uses direct host checks and no verifier/human criterion; it does not prove the original run's independent verifier round.

## Conversational resume passes separately from the failing popup

Real-model conversational resume receipt: `17cad106-d3cf-43d3-bbac-9550fba4daae`. Inspected files under the same QA root: `lifecycle-result.json`, `lifecycle-transcript.json`, `lifecycle-ledger.json`, and `lifecycle-provenance.json`. Provenance is exact v0.3.5/9f49b43, scratch PID82145, original QA location and installed compiled artifact.

`lifecycle-result.json` reports `pass: true`. Before/after preserve QA session `ses_ed331f946ffezoLPii8v1NaAaM`, run `12cce0761001`, and lock `bf82f2a7e138c31f833d7dd4db58caf95acecd4c9dbb7b9d766821b841982f5d`; state moves paused → resumed → waiting for inspection. Ledger binds automated QA owner message `msg_12cd48bfe0019AI5ZTcD95SoQe` to one `owner-message-consumed`, `resumed`, and `decision-resolved` event for decision `89ea7266-4412-456d-b547-3ff62088ad10`, via `owner-message`, `ok: true`. No redundant native form is reported (`forms: []`), no new run was created, and no completion was claimed.

This proves the conversational one-use owner-source path in its QA scope. It doesn't prove delivery of a popup choice queued before the native form exists. T085 requires that distinct installed timing reproduction and explicit failed/expired recovery proof; the production original run remains paused.

## Preserve the v0.3.4 failures and the compiled-artifact correction

Earlier QA root `/private/var/folders/9f/83wg9xhx7hg_6vfc0dks52f00000gn/T/opencode/real-model-goal-yhp4rE/qa-evidence` preserves failures. The driver missed the offered Recommended launch label and sent custom commentary instead; the host correctly refused it. After correction, the first QA goal legitimately completed when the operator resumed it, so it no longer provided the intended inspection hold. Neither result was concealed or recast as a product pass.

The installed v0.3.4 manager then had two waiting goals in scoped inventory but no rendered cards: `manager-pty/pty-result.json` says `pass: false`, no checks, `sidebar cards missing`. Actual raw TSX in `node_modules` was excluded by the host's Solid transform. Source-only JSX tests missed that deployed failure.

T084 compiles universal Solid JS, keeps host runtimes external, ships `dist/tui.js`, and includes compiled bytes in release manifests. The installed test consumer has its own `package.json`, preventing Bun's package self-reference from silently testing the repository instead. The v0.3.5 six-check manager result and installed delayed-inventory controls are evidence for this correction, not retroactive proof that v0.3.4 worked.

## The original approval was consumed once, not renewed on reinstall

The owner-source message is `msg_12b4162c9001Av2yAwjWxkg7mK`, beginning “I approve you to resume.” The parent reports that v0.3.4 consumed it once to resume the exact original run/session/lock without a redundant form. No duplicate/new run was created. Installing v0.3.5 then paused that same run. A consumed approval does not authorize another resume; this audit stays within the instruction to continue bookkeeping while paused.

The host reads original messages itself and binds one operation under the cross-process review lock. Worker text, custom commentary, conditions, quotations, synthetic input, stale generations, and replay do not grant consent. The final run is still paused; no claim that it resumed after v0.3.5 or completed is made.

## Goal contracts and task parents are separate inventories

Current project inventory contains five contracts: unfinished paused `ship-v033-goal-manager-flow`, completed live-folder `ship-v031-launch-experience` and `ship-v032-trust-the-card`, and completed archived `dogfood-buildout` and `ship-v03-feedback-loop`. No draft or second unfinished project contract was returned. Historical plan steps may lag terminal verified status; their history stays intact. Scratch QA runs are not project task parents.

CLEO hierarchy is `T001` → `T002` → `T076`–`T085`, alongside T001 children T024, T035, and T039. T024 is done. T002 is pending with **39/49** children done: these ten tasks remain pending, including newly filed T085. T035 is pending with **3/3** children done; T039 is pending with **4/4** children done. Their parent-level acceptance and verification records are absent, not extra pending goal contracts. T001 is pending with **1/4** child epics done.

| Tasks | Implemented evidence now recorded | Still required |
| --- | --- | --- |
| T076–T079 | c0f6c13 plus scoped files and AC1 | testsPassed, qaPassed, deployed/PTY evidence and final acceptance closure |
| T080 | c0f6c13 plus banner files and AC1/AC2 | testsPassed, qaPassed, successful REQ-080 binding |
| T081 | c0f6c13 plus launch/amend files and AC1–AC5 | testsPassed, qaPassed, successful REQ-081-AMEND binding |
| T082 | c0f6c13 plus durable decision files and AC1–AC5 | testsPassed, qaPassed, successful REQ-082-DECISIONS binding |
| T083 | 693b0f3 plus owner-intent/review/host files and AC1 | testsPassed, qaPassed and deployed one-use resume receipt |
| T084 | 9f49b43 plus compiled artifact/build/manifest/tests and AC1 | testsPassed, qaPassed and final installed/manager receipts |
| T085 | Published source fix 16e8173/0bebf6d; no CLEO implemented gate recorded by this audit | final installed delayed-popup/once-only gate, v036 live provenance, real-model dogfood, tests/QA/AC evidence and genuine original-run consent |

The audit recorded only implemented gates for T079–T084, using `CLEO_SESSION_ID=ses_20261010192447_c707f7` and `--no-run`. T076–T078 already had implemented gates. Every testsPassed/qaPassed gate remains false. No task was completed, acceptance changed, gate waived, or owner override used.

Historical CLEO diagnostic: the T080/T081/T082 implemented writes returned `success: true` **and** typed-gate `result: error`, duration 0: `Typed gate inputs could not be captured: Typed input is not an unambiguous regular file: /Users/keatonhoskins/projects/opencode-goal/test`. No heavy command ran. Success of the bookkeeping write was not a passing typed gate. Preserve those failures; the audited entry correction above now needs fresh proof, not a waiver or silent reuse of old command evidence.

## Close with targeted evidence, not a whole-suite rerun

From `/Users/keatonhoskins/projects/opencode-goal`, bind CLI writes to `ses_20261010192447_c707f7`.

1. Inspect `cleo done <task> --plan` and `cleo verify <task> --explain`. The automatic plan currently proposes an unscoped `tool:test` and unresolved `tool:lint`; don't execute that default. Explicit commit/files evidence already supplies implementation scope without a new task branch.
2. Preserve and use `.tmp/verification/v033-c0f6c13/tests.json` for historical T076–T082 coverage and `.tmp/verification/v034-693b0f3/tests.json` for T083. Both carry exact native XML hashes and per-file assertions. Bind the v035 native JUnit above through a lossless derived JSON report with its source path/hash and actual 29-file inventory; this audit did not invent or execute a new report. Don't claim missing banner/amendment tests from those 111 passes, or proof of a later T085 patch. Neither historical report becomes fresh by relabeling it.
3. Run only the corrected declared focused gates: `cleo verify T080 --run --req REQ-080`, `cleo verify T081 --run --req REQ-081-AMEND`, and `cleo verify T082 --run --req REQ-082-DECISIONS`, under the parent's governed verification workflow. The native 40-test report supplies the repaired missing banner/statement/unit-amend coverage; the complete declared typed sets still need fresh receipts. Successful new cached gates can be consumed with `--no-run`; cache keys include current tree/HEAD/inputs and the corrected command hash.
4. Record tests with explicit criterion links, for example `cleo verify T083 --gate testsPassed --no-run --evidence 'test-run:.tmp/verification/v034-693b0f3/tests.json;satisfies:T083#AC1'`. For multi-AC tasks, repeat `satisfies:T081#AC1;satisfies:T081#AC2` atoms; comma-joining AC IDs inside one atom is invalid. Record each task's actual coverage rather than treating a passing report as universal proof.
5. Retain the actual parent v0.3.5 typecheck/freshness output and receipt. A `qa-run:<receipt.json>` must describe a real completed check (`kind`, command array, exitCode 0, diagnostics.errors 0, roots, and startTime). CLEO's plan asks for current changed-code roots and currently names `scripts`, `spikes`, and the untracked goal directory; distinguish real code from contract data, and bind the checked source/test/compiled roots as appropriate. No fabricated QA receipt or absent lint toolchain proves QA.
6. Bind deployed manager receipt `c74841f7-eaf1-40c8-885f-b3b753213388`, installed seven-check receipt `5bb3e17b-65cb-470e-91d6-1a3ab955e652`, interview receipt, conversational receipt `17cad106-d3cf-43d3-bbac-9550fba4daae`, production PID8405/session/run provenance, and the original one-use owner-message resolution. The two QA owner messages are distinct from production consent. Resolve T085's actual popup no-op with new focused evidence, not a passing conversational workaround substituted for the failed UI. Commit/publish evidence documentation before final QA capture where tree hashing makes documentation churn relevant. Then `cleo done <task> --plan`, `cleo verify <task> --explain`, and `cleo complete <task>` only when every required gate/typed acceptance is valid.
7. Reconcile T035/T039 with their own historical child and release evidence, then T002 and T001 after child closure. T002 AC2 names isolated OpenCode **2.0.22**; QA on 2.0.26 alone does not satisfy that version-specific acceptance. T039 AC1 explicitly requires the immutable **v0.2.0** release and dogfood-2 verifier evidence, not v0.3.5 substituted by similarity. T001 AC1–AC5 need direct load/persistence/host-verification/live-TUI/skill evidence even after its children close.

## This update maintained one canonical draft

Updated existing SSoT slug `goal-manager-dogfood-6`, attached to T081, and published its mirror at `docs/dogfood-6.md`. No duplicate dogfood/handoff document was created. The fetched historical handoff `opencode-goal-handoff-2026-10-02` still describes the initial alpha and is historical guidance; it was not silently overwritten. Parent diagnostic scripts `scripts/real-model-goal-dogfood.ts`, `scripts/real-model-manager-dogfood.ts`, and `spikes/goal-manager-gate.py` remain unstaged and untouched by this audit. Goal directories and protected historical oracles were not edited.

## Coordination reports do not grant oracle authority

The parent reports read-only Axiom staff confirmed project-wide elsewhere markers match the approved intent and had no first-hand resume no-op. Budget/amendment claims remain unproven; actual canonical budget, accepted-lock diff, real provenance, and failed RPC IDs were requested. No undocumented budget reset or accepted amendment is asserted here.

Another Axiom lane proposed routing a refused `verify.mjs` oracle edit through a main merge. The parent warned affected lanes that native owner review is required; staff confirmed the hold. Design endorsement is not authority, and this audit neither authorizes nor changes any foreign oracle. Outside-team statements are coordination data, not consent or evidence of this project's completion.

Remaining work is parent-owned installation receipt/live exact provenance for v0.3.6, final installed nine-check popup/once-only rerun, real-model v036 dogfood, corrected fresh typed gates, actual QA/task/parent closure, and authorized continuation of the original run followed by its installed-engine checks and independent review. The handoff successor is published through SSoT with prior alpha and legacy v032 bytes preserved. There is no genuine original-run Resume receipt yet under v0.3.6 and no claim that every possible bug is fixed or C14/the full goal is host-proven by this draft alone.
