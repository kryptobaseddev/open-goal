# Recon — real-model-dogfood-evidence

Facts only (no decisions). Captured 2026-10-16. HEAD `3f0db02` (pushed), `package.json` **0.5.0**, installed
pin `github:kryptobaseddev/opencode-goal#v0.5.0`. Previous goal `cleo-first-class-integration` is complete
(13/13); T080/T081/T082 and T117 are closed.

## The task this goal serves (CLEO T102, the only pending task under T002)

**"Automate exact-release real-model dogfood and independently readable proof export"** (medium).
Its acceptance:
1. "The workflow records exact release SHA, own serving PID/location, model/agent selections and
   server/UI/skill hashes for each exercised native flow, with raw owner messages/forms/tool calls and
   outcomes preserved."
2. "Readable project-local evidence export retains raw hashes, request IDs and bounded read coordinates for
   current task inventory and real-model records, while labeling fixtures, stale-cache failures, partial
   successes and timeouts honestly."
3. A focused future-release evaluation proves interview/fresh handoff, manager/lifecycle and actual
   claim-to-host completion on the installed artifact; no manual criterion approval, oracle edit,
   old-consent replay or rewriting of the completed run.
Its description adds: **extend, rather than duplicate, the completed T012 dogfood work**; the final summary
C13 carries an actual owner-final provenance caveat that **must not be rewritten or re-graded**; for future
releases, **consolidate the existing drivers into a bounded workflow**.

## What exists today (the five drivers — all require `--assert`)

| script | head comment |
|---|---|
| `scripts/real-model-goal-dogfood.ts` | "Explicitly automated QA owner, real model, installed immutable plugin." |
| `scripts/real-model-manager-dogfood.ts` | "Two real-model goals on the explicitly scoped installed QA host. The PTY…" |
| `scripts/real-model-lifecycle-dogfood.ts` | "Real-model typed lifecycle dogfood. Automated QA owner commands are scoped…" |
| `scripts/real-model-completion-dogfood.ts` | "Explicit automated QA owner asks a real model to finish its inspected…" |
| `scripts/real-model-amendment-dogfood.ts` | "Automated QA owner, isolated project, actual deployed tools and model." |

They are separate programs with no shared record format and no single export. `scripts/real-model-goal-dogfood.ts`
refuses to run without `--assert` (line 14).

## Prior evidence (must NOT be rewritten or re-graded)

`docs/dogfood-1.md` … `dogfood-6.md` and `docs/dogfood-6-history.md` record the earlier T012/T013 runs,
including the owner-final provenance caveat in the C13 summary. They are history; this goal **extends** them.

## Where an export could live (both chosen)

- `docs/research/` already holds committed findings docs (`cleo-goal-integration-proposal.md`,
  `lab-lifecycle-triage-findings.md`, `host-suite-flake-findings.md`, …) — the readable half.
- `.opencode/` currently holds `goals/`, `goals-archive/`, `plugins/` — no data/session directory yet; the
  raw machine-readable half would add one (e.g. `.opencode/dogfood/`).

## Test surface

- `test/unit/` and `test/host/` (85+ host files); `test/host/harness.ts` boots an isolated `opencode serve`
  with a temp HOME/XDG and a scripted OpenAI-compatible fixture provider.
- The only existing test that mentions the real-model drivers is `test/host/verifier-reliability.test.ts`.
- `scripts/run-scoped-tests.ts` is the fingerprinted entry for typed Bun gates.

## The OCG-side Phase-2 items the owner folded in (no CLEO dependency)

From the `cleo-dev-mac` exchange, agreed but not yet implemented:
- `GoalAcRef` must accept all three `satisfies:` forms: `T1234#AC2`, `T1234#<uuid>`, `T1234#AC2@<14-digit pin>`.
  Today the parser accepts only `T<digits>#AC<digits>`.
- `proves` becomes the **sole** AC binding; `cleo.tasks[].acs` is read for compatibility and **warned** as
  deprecated.
- `reportSha256` recorded beside every `test-run:` `reportPath` (sha256 of the report bytes).

The CLEO verbs (`cleo goal draft`/`goal close`/`tasks changeset`) are in review as PRs #2299/#2300/#2301 and
are **not** merged, so nothing here may depend on them. The installed `cleo` is 2026.10.17 and has none.

## Release loop (project rule)

`bun install` (dev only) → `bun test` → `bun run typecheck` → bump `package.json` + `CHANGELOG.md` → commit
`type(T###): summary` → `git tag -a vX.Y.Z` → `git push origin main --follow-tags` → git-install test against
the tag → `opencode plugin remove/add` + reload. The completing verifier round runs the **installed** engine.

## Working tree

Clean. No live goal. Mailbox clear. `cleo` 2026.10.17.
