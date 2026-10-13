---
title: 'Lab lifecycle triage: preserve identity and spent consent'
audience: maintainer
status: draft
---
# Lab lifecycle triage: preserve identity and spent consent

## Current follow-up: T104 is executing; no autonomous goal started

The owner explicitly approved executing this plan after three launch reviews expired. No expired consent was replayed or receipt edited. v0.3.13 cannot consume direct chat launch approval; ordinary approved work is tracked separately as T104. The draft contract and completed original are unchanged. Earlier T103 product-unchanged statements below describe its retained baseline, not current implementation.

T104 repairs only diagnostics: named missing runId/sessionID refusal, owned settled amendment metadata (ok:false/actionExecuted:false/alreadyResolved:true/actual status and result), and owned settled lifecycle review reporting before pending target comparison. No normalization, inferred continuation, cross-session takeover, new consent consumption, guard weakening, or launch-chat feature was added. Executing/expired/foreign/changed pending cases still refuse.

Fresh27pass/0fail/273assertions across5 named host files: f8f30771-165f-4408-aed6-77c01d686a56. Its JUnit output failed because the directory was missing; this is console evidence, not a valid report file. Covering TypeScript/generated freshness passed f719c579-4227-421d-be5c-5e14b8a20dc2. Strict red baseline0231fc28-f38f-4d50-a354-a1159af529c3 had2pass/2fail; source greenfa8683ea-b7a5-4d2c-9269-bf9223adc597 had4pass/60assertions. The protected oracle is unchanged since red. New disposition tests correctly require an executing receipt to recover as failed/uncertain after reload; the initial fixture expected executing and failed fadbd093-8eb6-4851-a563-dd621adf3e84, preserved rather than weakening recovery.

Peer01M4VB7MQP5942CY5RCXKP40P6 supplies explabs/glm-5.3-flash-abliterated and three direct native parallel calls, no wrapper, historicalOpenCode2.0.27. Original per-call IDs and boundary snapshots remain missing. Immutable312/OpenCode28 correct slugs don't prove a historical repair. Raw records were requested read-only; no live-goal repro.

Dead-author review report01M4VPF9JJHCDYVHZ22KTK5RZZ and VidaPeps binding/stall reports01M4VMA2GKXFVR28KQBJZVE60F/01M4VP5G581BHZ2GDT5VCER1HK are separate recovery-design gaps. MBX release isn't OpenCode-session death, and relayed approval isn't actual engine consent. No takeover, baseline/status rewrite or blind resume is implemented; T099/T100 remain separate.

## Retained T103 baseline findings

## Three diagnostics reproduce; parallel slug aliasing remains unconfirmed

T103 adds passive fixture instrumentation and four scoped host scenarios. Product code, production goals, contracts, receipts, provider settings, and release tags are unchanged. All goal starts, form answers, and amendments below are explicitly automated **isolated test fixtures**, not production owner consent or recovery.

The recovered mailbox is opencode-goal-builder, OpenCode session `ses_ec9b07c72ffeWHkmiuQxRJXUha`; CLEO session `ses_20261013172951_2d2241`. Source HEAD is `3d455cd4c38e28e63be3c5a2ec9111d72390b881`, package0.3.13. Session-native provenance reports PID46974/OpenCode2.0.28, installed immutable0.3.13/`5ea9874783b4988e915c79522cd9f326d668d067`. This is not the lab's original runtime.

## Keep peer evidence separate from independent reproduction

Read current trust-framed mailbox records `01M4V2V2RVC0712F73GFPYSB3Q`, `01M4V3A386M4HQJDCPP54YAP0V`, and `01M4V53FA34BPSAA9MSNYDG9SV`. The last corrects the original account: **all three launch goals were live**, call order was mq-r1-approvals, release-lane-completion, lab-panel-click-review-release, and fresh was omitted. The peer reports three identical refusal errors naming the first slug. Reported original actor: axiom-lab-dev/session `ses_eccb3913bffehdsmDtD8Qs6ojS`, axiom-instrument-studio, PID93472/OpenCode2.0.27, immutable0.3.12/`2bf4109318351f8524ed45b5829bd4d299000776`. Current peer runtime now reports0.3.13. Its original raw call IDs, provider/model, transport batching records, full inventory snapshots, and per-call plugin-boundary trace have not been supplied. Reported contract headers and ledger ordering are peer evidence, not independently read production files.

The peer's corrected #4 review occurred **after** successful native-form resolution. Don't classify it as guard/form divergence. #3 was already form-applied; no accept replay or manual recovery is appropriate.

## Trace each boundary before attributing the slug mismatch

`test/fixtures/lab-tool-boundary/server.ts` records model tool-call identity at execute.before, actual plugin executor input, and execute.after result/error. It changes no arguments, choices, or permissions. `test/host/lab-lifecycle-triage.test.ts` includes:

1. All three live goals, exact reported call order, omitted fresh, one parallel model batch, plus sequential controls. Each independently observed refusal names its own requested slug; all call IDs and provider-visible tool outputs match.
2. Two drafts plus one live goal, fresh true: two correct draft receipts and one correct live refusal. Preparation doesn't start either draft. Earlier same-authoring-session preparation can be cancelled by the next preparation; two concurrently pending reviews are not promised.
3. Missing sessionID/runId refusal, genuinely changed lock refusal, exact native resume staged and answered once, then post-resolution review refusal. Identity and once-only guards stay intact.
4. Exact real fixture amendment form accepted once, then a model resolve call and review on that spent decision. Contract/run/proof remain unchanged by the later calls; no consumed owner message or second amendment/resume appears.

The immutable0.3.12 test used **OpenCode2.0.28**, not the historical2.0.27, so it cannot disprove that historical host/transport failure. There is no reproduced aliasing fix to ship. `prepareLaunch` (`src/server/app.ts:561-588`) uses its local slug for contract lookup, run filtering, refusal, and receipt; no await precedes the live-run refusal. The wrapper (`:2645-2653,2677`) forwards that call's args directly. v0.3.13's app diff didn't change either path. A module-level first-goal cache is not supported by current evidence. Next localization needs original raw call records or a bounded historical2.0.27/actual-provider fixture; never probe by launching or manipulating the lab's live goals.

## Confirm the narrow reporting defects without weakening guards

| Case | Independent baseline | Responsible layer | Proposed repair, separate from T103 |
| --- | --- | --- | --- |
| #1 | Inventory is stable; omitting target.sessionID (or runId) returns `Selected goal identity changed. Refresh its details before acting.` Exact full tuple stages the native review; changed lock fails. | `manageGoal`, app.ts:2462-2466; public GoalTarget schema makes runId/sessionID optional but exact comparison requires both for a live goal. | Refuse incomplete live identity explicitly, naming missing fields and fresh-inventory action. Keep full tuple comparison and actual-owner confirmation unchanged; no normalization, implicit identity, or fallback goal. |
| #3 | Authentic fixture form re-locks once. Subsequent resolve returns `No current amendment review owned by this Composer session; nothing authorized.` Exact review says `Amendment review is succeeded; old approval cannot be replayed.` | `resolveAmendmentChat`, app.ts:958-965, collapses unknown, foreign, expired, and settled reviews into one error. | After ownership check, report settled status/result as already resolved and actionExecuted:false; never consume another owner message, execute again, or infer continuation. Distinguish unknown/foreign, expired, and target-changed pending records. |
| #4 | Resume form has a succeeded receipt; same lock/run, transitioned status. Later review returns `The reviewed target changed; old choices cannot be reused. Inspect current goal status.` Exactly one resume remains. | `reviewDecision`, app.ts:845-870, compares target status before checking settled decision disposition. | For an owned settled decision, report its actual status/result before mutable target comparison. Keep exact lock/run/session/status check for every pending/interrupted/expired review; foreign reviews remain refused. |

The repair needs tests for missing versus wrong identity, already-succeeded/failed/rejected/commented/expired dispositions, foreign actor, target-change, reload, and replay. Re-presenting a review never authorizes an operation. A failed or uncertain disposition isn't application proof. A new release must carry these narrow changes only, not workspace/oracle binding or manual ledger recovery.

## Inspect the captured evidence and its limits

Fresh isolated source run: request `f6f563d0-8314-4175-9230-926ba2400ecc`,3pass/28assertions. `.tmp/verification/t103-source/{parallel-launch,applied-amendment,identity-and-review}.json` preserve actual provenance, input/result/error, form/receipt, run/ledger, and provider requests. Hashes respectively `c6c72b2c4b37b1d617c817c619d3bb5af082fcf8cf161426b8a99138c34091db`, `c2b9d7b1a4f4a7f82fe4329b824e03556186fd5a627f49bddd5f3d690c6cc173`, `ea79c61943f23a6653d9cd55f78060061fdfe6c0105bbc71e61ebc5f2bf15315`.

Immutable0.3.12 baseline: request `3ab068bf-8adb-4944-b1f9-b240f518c339`,4pass/46assertions. `.tmp/verification/t103-v0312-full/{parallel-all-live,parallel-launch,applied-amendment,identity-and-review}.json` include scoped artifact hashes and immutable source revision per actual host. The all-live baseline PID79683/OpenCode2.0.28 preserves six distinct call outputs (three parallel, three sequential). Further test-only strengthening binds provider-visible outputs and removes assertions that would freeze misleading wording. Final evidence must be rerun after those edits before task closure.

A first typecheck failed only on the new fixture test's un-narrowed FormField options; those two fixture accesses now narrow field.type to string. This isn't a product defect. Fresh final typecheck remains required. No lint toolchain exists; don't invent a lint pass. No production state mutation, complete-goal regrading, workspace recovery, permission change, tag movement, or release is claimed by T103.