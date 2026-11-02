# Context (facts only) — recon 2026-10-14

## Repository state
- main == origin/main at c8243d0 (v0.3.15 release cccda35 + evidence). Untracked: two completed goal folders, docs/research/c5-native-scope-and-change-audit.md.
- Installed plugin: github:kryptobaseddev/opencode-goal#v0.3.15. Installed OpenCode binary now reports v2.0.29 (server for the previous goal ran 2.0.28; axiom's server reported 2.0.27).
- Commands: `bun test` (all), `bun test test/host/<file>`, `bun run typecheck`, installed proof `bun scripts/check-installed-goal.ts --min-version <v> --assert-release`; host tests honour `OPENCODE_BINARY` and `OCGOAL_GIT_SPEC`.

## Issue 1 — disk contract ahead of the lock (axiom release-lane-completion)
- Axiom report (mbx 01M4XZV6TB3DP2GXGZX81Z5260): run 12d66f6b7001, lock 718612bf…; disk goal.yaml SHA equals pending amendment 0e115e55's nextLock (timeout 900 vs locked 600). Proposal has NO commit/acceptedAt; no amendment-commit journal. Authoring session believed dead; review owned by staging session ses_ed4b064a.
- Refusals in v0.3.15 source:
  - src/server/app.ts:937 staging: "Disk contract differs from the locked goal; resolve the existing edit before staging".
  - src/server/app.ts:1087 accept: requires disk.lock === request.lock, so a pending proposal whose disk already equals nextLock fails as "review binding changed".
  - src/engine/store.ts:107 commit write tolerates disk == nextLock (write-ahead recovery only).
  - goal_resolve_amendment from a non-owning Composer session is refused ("No current amendment review owned by this Composer session").
- CLEO T101 (pending, research): plan guarded disposition of manually divergent contracts; acceptance forbids unsupported recovery or editing history without owner review.

## Issue 2 — verifier timeouts
- src/server/app.ts:1964-1973: on per-round timeout (verifierTimeoutMs 240000) the loop interrupts and breaks BEFORE session.context, so the transcript records messages: [] (seen in this project's turn-1 verdict and in axiom's C2 x3).
- Axiom-api-help: child verifier is CWD-scoped; read/glob/grep of sibling repos fail "permission denied: external_directory".

## Issue 3 — parallel launch slug mix-ups
- Protected oracle test/host/lab-lifecycle-triage.test.ts covers correlated parallel slugs; passed on immutable v0.3.12/v0.3.15 under 2.0.28. Original 2.0.27 boundary records missing (docs/research/lab-lifecycle-triage-t103.md).

## Project rule touched by the autonomy request
- AGENTS.md: the worker must never be able to edit the contract or `.opencode/goals/**`, edit protect globs, call goal_verdict, or resume/extend/clear a goal. Owner-set autonomy policy must keep the criteria/oracle/verdict guards.
