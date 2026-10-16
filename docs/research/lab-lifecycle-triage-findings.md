---
title: 'Lab lifecycle and reporting findings: what T103-T106 are covered by'
audience: maintainer
status: final
---

# Lab lifecycle and reporting findings (T103–T106)

The four lab lifecycle/reporting cases were filed against behaviour in
`axiom-instrument-studio`. On this tree they are **already implemented and proven
by existing, passing oracles** (baseline 2026-10-16: 14 tests across the suites
below, 0 fail). This document consolidates what each task is actually covered by,
names the exact observable, and separates what remains open — it claims **no** fix
that no oracle proves.

## T103 — reproduce lab typed lifecycle reporting and native-review cases

- **Covered by:** `test/host/lab-lifecycle-triage.test.ts`.
- **Proves:** the typed lifecycle/reporting outcomes — an incomplete-identity
  diagnostic is explicit rather than silently normalized; an already-applied
  amendment reports its owned settled disposition; a post-resolution review reports
  a succeeded outcome rather than a target-change error; and parallel launch calls
  keep their own input slug with a correlated output.
- **Remains open:** the historical **OpenCode 2.0.27** parallel-slug report is
  *unreproduced* on the current runtime and is **not** claimed fixed; it is retained
  as historical evidence.

## T104 — report missing identity and settled lab review dispositions

- **Covered by:** `test/host/lab-review-dispositions.test.ts`.
- **Proves:** a missing live-goal identity (`runId`/`sessionID`) is named and the
  complete fresh tuple is requested, never inferred; an already-resolved amendment
  reports `alreadyResolved:true`, `actionExecuted:false`, `ok:false` and consumes no
  further owner message; pending target/generation guards stay intact.
- **Remains open:** nothing beyond the reporting contract — no missing-identity
  normalisation or fallback goal is introduced.

## T105 — repair owner launch approval and recursive blocked-resume

- **Covered by:** `test/host/owner-chat-launch.test.ts` (authenticated owner chat
  start/continue, consumed once, bound to the displayed contract and mode) and
  `test/host/amendment-resume-prerequisite.test.ts` (an unresolved amendment is
  reported as the prerequisite of a resume instead of re-offering an impossible
  resume; an owned unpresented prerequisite can restore its exact diff).
- **Proves:** an explicit, authenticated owner instruction launches/starts the exact
  displayed contract once; expired, quoted, conditional, foreign, changed, ambiguous
  and spent authority cannot; and the recursive blocked-resume is resolved by
  surfacing the prerequisite rather than repeating the resume.
- **Remains open:** no universal "all recursion fixed" claim; a genuinely unavailable
  original Core session still needs the supported owner-confirmed `attach`.

## T106 — divergence hints name `goal_recover_divergence`

- **Covered by:** `test/host/divergence-guidance.test.ts`,
  `test/host/divergence-prerequisite-guidance.test.ts` and
  `test/host/recovery-target-key.test.ts`.
- **Proves:** every refusal whose real cause is a disk contract differing from its
  lock names the locked and disk hashes and the exact
  `goal_recover_divergence {"slug":…,"expectedLock":…}` call; `goal_review` refuses
  to re-present the impossible acceptance review while divergent; and a recovered
  divergence returns the refreshed `live:<slug>:<runId>` target tuple that
  `goal_manage` accepts.
- **Remains open:** the disposition of a *manually divergent* contract is a separate
  read-only plan (`docs/research/manual-divergence-disposition-plan.md`, T101), not
  part of this hinting contract.

## What is not claimed

- No oracle proves the historical OpenCode 2.0.27 slug mix-up was fixed; it remains
  unreproduced.
- The peer-reported manual ledger/`resolved` divergence is **not** blessed here; its
  disposition is the read-only T101 plan.
- No other project's goal state was read-modified: the suites are host tests in this
  repository, and the lab evidence is cited, not edited.
