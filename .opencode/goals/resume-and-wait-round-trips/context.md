# Context (facts only) — recon 2026-10-15

## T091 (resume during a busy turn)
- `src/server/app.ts:294` `deferIfHeld(sessionID, text, sub)`: control/read commands stay immediate (`""`, `status`, `list`, `help`, `pause`, `abort`, `approve`, `reject`); a `resume` already skips deferral when `f.forms.size === 0` and the session owns a run that `ownerCan(own, "resume")` allows (line 307). So the carve-out exists, but what happens after it — immediate status/snapshot publication and exactly one resumed receipt — is not asserted anywhere.
- `case "resume"` in `ownerActLocked`: sets counters/blocker/wrapup, `setStatus(state, "running")`, `fingerprint`, ledger `{type:"resumed"}`, `persist`, transcript notice, then `if (!this.factsOf(state.sessionID).busy) await this.admit(state, "resume")` — i.e. while a turn is busy no kickoff is sent, and the deferred flush is what continues it. Two writes could in principle both admit (`/goal resume` twice while busy, or the deferred flush plus the end-of-turn admit).
- Snapshot publication for the TUI is `emitUpdate(state)` → rpc `updated` event; the resume case does not call it (it calls `persist` only), so a busy-but-immediate resume may not update the published snapshot until something else emits.
- Existing host tests: `test/host/owner-resume.test.ts`, `busy-owner-resume.test.ts`, `command-ack.test.ts`, `waiting-completion.test.ts`, `lifecycle-authority.test.ts`.

## T092 (claims and waits behind a busy turn)
- `onTurnEnd` (app.ts:1685-1698): `if (isActive(state.status)) state.counters.failures = 0`; returns early unless `running`, or `waiting` with a claim; `if (state.claim) return this.verify(state, contract, "claim")` — so a claim in a waiting run verifies at turn end.
- Waits: `state.wait = {until, reason}`; `schedule(state, delay, kind)` (app.ts:1709-1740) clears the session timer and sets a new one; on fire it admits with kind `continue`, and re-schedules if the run is still `waiting` with a future `until` (line 1737-1738). `clearTimeout(this.timers.get(state.sessionID))` is used by verify/pause/abort paths.
- Not asserted anywhere: that an obsolete wait wakeup is cancelled when a claim ends the wait, that a wait expiring during a busy owner turn drains exactly once afterwards, and that no double admission occurs.

## Update 2026-10-15b (after the v0.4.6 goal completed)
- Current installed tag is **v0.4.6** (commit `bf7dc693`), loaded in this project's session. This goal targets **v0.4.7**; the earlier v0.4.3 plan in this file is superseded (the run-state round took v0.4.3-v0.4.5).
- **Protect only EXISTING oracles.** The v0.4.6 run was impossible as written because `protect` listed the new red-first tests the worker had to author; the live-goal write guard refuses the worker those writes. The four new tests here (resume-busy-turn, resume-deferral-cases, wait-drain-round-trip, claim-behind-busy-turn) are left unprotected for that reason.
- The goal store now also uses the `verifierMinRoundMs` floor and the context-part fix from v0.4.6; if a host test needs a lower verifier budget, pass `{verifierMinRoundMs: 1000}` plugin options.

## Commands and rules
- One file: `cleo run --wait --class test -- bun test test/host/<file>`; typecheck `bun run typecheck`.
- Release: bump `package.json`, CHANGELOG entry, `git tag -a v0.4.7`, `git push origin main --follow-tags`, then `OCGOAL_GIT_SPEC="github:kryptobaseddev/opencode-goal#v0.4.7" bun test ...`, then `opencode plugin remove/add` and `bun scripts/check-installed-goal.ts --min-version 0.4.7 --assert-release`.
- `test/host/stress-host-suite.ts` (added by an earlier goal) can run the protected suite under load: `bun scripts/stress-host-suite.ts --runs N --concurrency C [--require-clean]`.
