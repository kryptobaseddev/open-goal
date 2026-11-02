# Context (facts only) — recon 2026-10-15

## Repo state
- Branch `main`, working tree clean except untracked `.opencode/goals/**` and `docs/research/c5-native-scope-and-change-audit.md`.
- `package.json` version **0.4.5**; tags through **v0.4.5**; HEAD `b07585a fix(T108): a late verdict counts, and a slow round is not a denied one`.
- Completing verifier runs the **installed** engine, so a version-release criterion must reinstall the new tag (`bun scripts/check-installed-goal.ts --min-version … --assert-release`).

## The six follow-ups (all under epic T002, all `pending`/`high`, from `cleo list --parent T002`)
- **T107** — Verifier criteria may name their model and effort. AC1: a host test proves the contract-specified model is used for the verifier child and an invalid value falls back with a recorded ledger reason.
- **T108** — Verifier evidence quotes tolerate JUnit and XML escaping. AC1: a host test reproduces the C5 quote mismatch and passes only after the fix, raw junit **and** plain-text renderer both covered.
- **T109** — Verifier can answer a criterion about git history without a shell. AC1: a host test proves a criterion asking for commit history is judged from that digest without any external path.
- **T110** — Verifier long-round budget is testable below the 60s floor. AC1: the verdict-grace test completes in under 90 seconds and still proves a late verdict is used.
- **T111** — Stall notices name the on_stall option and the owner's choices. AC1: a host test asserts the notice text names both, and the findings doc records the wording.
- **T112** — Bound and document what the live-goal write guard cannot see. AC1: the assessment cites the guard code and a captured example, and states the residual risk without claiming full coverage.
- Linked: T108 ↔ T109 (verifier robustness); T107 ↔ T110 (verifier budget/model effort).

## Code facts (where the work lands)
- Verifier child: `src/server/app.ts:2267 runVerifier` → `resolveVerifierModel` (app.ts:2395; parent session model, then `ctx.model.default()`; no contract input). `verifierAgent: "goal-verifier"`, `verifierTimeoutMs: 240_000`, `verifierGraceMs: 30_000` (DEFAULTS, app.ts:72-84).
- Per-round budget floor: `const perRoundMs = Math.max(60_000, this.options.verifierTimeoutMs)` (app.ts:2308) — T110's "60s floor".
- Verifier tool set: `read`, `glob`, `grep` and `goal_verdict` only; every other action denied (scoped verifier agent, app.ts:2690-2701). No shell → "check the git history" is unanswerable today (T109).
- Quote re-read: `src/verify/pipeline.ts:90 checkQuotes` — literal `collapse(content).includes(collapse(quote))` against the raw file bytes; no entity/escape normalisation (T108).
- Stall notices: `src/server/messages.ts:128 goal.paused.stalled` = ``Goal paused — <why>. /goal resume to continue.`` It does **not** name `autonomy.on_stall`; `goal.stall.reported` (messages.ts:90) does. Stall policy + ledger in app.ts:2080-2098.
- Write guard: `shellWriteTargets` in app.ts (~3661, `mv|cp|install|rm|truncate|touch|chmod|chown|ln|dd` regex + interpreter writes) — static path analysis (T112).

## Baseline / test facts
- Existing verifier host tests: `test/host/verifier-diagnostics.test.ts`, `verifier-empty-response.test.ts`, `verifier-reliability.test.ts`, `verifier-verdict-grace.test.ts`.
- Budget: `cleo run --wait --class <test|build> -- bun test <file>` (one heavy job at a time); typecheck `bun run typecheck`.
- Release recipe (from prior goals): bump `package.json` + `CHANGELOG.md` → commit → `git tag -a vX.Y.Z` → `git push origin main --follow-tags` → `OCGOAL_GIT_SPEC="github:kryptobaseddev/opencode-goal#vX.Y.Z" bun test …` → reinstall + `check-installed-goal.ts`.

## Carried forward, not re-filed
- **T091/T092** (resume and wait round-trips) exist (`pending`). A recon-only draft lives at `.opencode/goals/resume-and-wait-round-trips/` (`context.md` + `decisions.jsonl`; **no `goal.yaml`**). The owner says the previous round was redirected to the run-state work.

## Unread mailbox finding (mbx, my inbox as opencode-goal-builder)
- From `vidapeps-lead@macbook`, 2026-10-15, repro of **opencode-goal 0.4.2 @ e864821** on a VidaPeps run: (a) `goal_progress` on a paused goal returns `recorded:false` yet `goal_provenance` (read-only) still bumps `run.json.updatedAt`/mtime; (b) `src/util/git.ts fingerprint` covers only the shared project root, so work in `.worktrees/<slug>` records `changed:false` and three such turns tripped the stall auto-pause. Issue: github.com/kryptobaseddev/opencode-goal/issues/1.
- Code check: `fingerprint(cwd)` (git.ts:20-38) hashes HEAD + `diff HEAD` + untracked under one cwd; app.ts:2044 calls `fingerprint(this.root)`. `provenance` (app.ts:2662) writes `evidence/…/engine-provenance` for any non-terminal run — a read-only call that still writes.

## Bookkeeping correction the owner reported
- Old task ids T107/T108 were reused by other code/commits/changelog (v0.4.3–0.4.5 are T108 "run-state"); the new T107/T108 titles differ. Two research-note attachments currently carry slugs that do not match their task titles; the owner's re-point attempt made two stray copies that were archived. Canonical docs: `docs/research/host-suite-flake-findings.md`, `docs/research/host-owned-run-state-integrity.md`.
