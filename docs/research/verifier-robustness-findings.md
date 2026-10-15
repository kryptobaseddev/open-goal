---
title: 'Verifier robustness, budget and stall-notice findings (v0.4.6)'
audience: maintainer
status: final
---

# Verifier robustness, budget and stall-notice findings (v0.4.6)

These are the four follow-ups from the previous goal's own verification rounds
(T107–T110) plus the stall-notice wording (T111). Each was reproduced red-first
on v0.4.5 before the fix; nothing here is claimed fixed that was not.

## T107 — criteria may name the verifier's model and effort

`runVerifier` resolved the child's model from the parent session and never read
the contract, so a criterion could not say which model judged it. The contract
now accepts `verification.model` (`providerID/modelID[#variant]`) and
`verification.effort` (used as the variant when the model carries none). A name
that cannot be parsed **falls back to the previous resolution** and journals
`verifier-model-fallback` with `requested`, `reason` and `used`, so a typo never
blocks a run. The used model is still journalled as `verifier-model`.

## T108 — evidence quotes tolerate JUnit/XML escaping

The live failure: a verifier read a JUnit file, decoded it, and quoted the
readable line, but the raw bytes carry entity escapes (`&#10;`, `&quot;`,
`&lt;`). `checkQuotes` compared literally, so a correct quote was rejected as
"quoted text not found". It now matches the raw bytes **or** their
entity-decoded equivalent (decoding both sides), covering the raw junit and a
plain-text renderer of the same line.

## T109 — a commit-history criterion is answerable without a shell

The verifier child has `read`, `glob`, `grep` and `goal_verdict` only — no shell
— so "check the git history" was unanswerable and burned the round budget; that
was the real cause of the C4/C5 timeouts. The host now computes a bounded
`gitDigest` (HEAD, branch, a short log, linked-worktree HEADs), puts it in the
child prompt, and saves a quotable copy at
`.opencode/goals/<slug>/evidence/<runId>/git-history-turn-*.json` **inside the
project**. The verifier answers from that digest with no shell and no external
path.

## T110 — the per-round budget is testable below the 60s floor

`perRoundMs` was clamped with a hard `Math.max(60_000, …)`, so the tests that
prove verdict handling each took a minute or more. The floor is now the option
`verifierMinRoundMs` (default 60_000). A host test sets it to 1000 ms and the
verdict-grace round completes well under 90 seconds while still using a
`goal_verdict` that lands after the budget and inside the grace window.

## T111 — the stall notice names `on_stall` and the owner's choices

`goal.paused.stalled` said only "Goal paused — <why>. /goal resume to continue."
With the policy shipped, a stalled owner should also see the policy that would
have continued a genuinely working run. The notice now reads (recorded here as
the wording the host test asserts):

> Goal paused — <why>. Your autonomy.on_stall is "`<pause|continue>`". Choices: /goal resume to continue, /goal abort to stop, or set `autonomy.on_stall: continue` in goal.yaml so a stalled-but-active run keeps going with a recorded report.

`app.ts` passes `contract.autonomy.on_stall` into the builder at the stall-pause
site, so the value shown is the owner's actual setting.

## The two VidaPeps mailbox items (T115, T116)

Reproduced first on the current tree (the report is against v0.4.2):

- **T115 — read-only calls wrote under a live goal folder.** `goal_provenance`
  called `store.evidence(..., "engine-provenance", …)` for any non-terminal run,
  so a read created a file under `.opencode/goals`. It now writes nothing; the
  host records that evidence in `verify()` instead, which is where the protected
  `check-installed-goal.ts` checker expects to find it.
- **T116 — the fingerprint was blind to linked worktrees.** `fingerprint(cwd)`
  hashed only the root worktree's HEAD/diff/untracked, so a commit in
  `.worktrees/<slug>` recorded `changed:false` and three such turns tripped the
  stall auto-pause. It now includes `git worktree list --porcelain` (every
  worktree's HEAD and branch).

Both items reproduced on v0.4.5 and are fixed with tests; neither was taken on
faith from the v0.4.2 report.

## A pre-existing defect the I1 invariant exposed

Running the protected `test/host/verifier-diagnostics.test.ts` on this machine
failed **on pristine v0.4.5** (reproduced by stashing the source changes): a real
`external_directory` denial was reported as an unknown timeout cause.

Two readers assumed a context shape this OpenCode no longer uses:

- `verifierCause` and `verdictsFromTranscript` iterated `message.parts`, but the
  context carries parts under `message.content` (an array).
- `verifierCause` stringified `part.state.output`, but the denial is an object in
  `part.state.error` — `String(object)` is `"[object Object]"`, so the regex
  never matched. `verdictsFromTranscript` also looked for the tool name in
  `part.tool`, while the context sets `part.name`.

All three readers (plus `compactTranscript`) now share one `messageParts()`
extractor and serialise `state.content ?? state.error ?? state.output` the same
way. This was not caused by the v0.4.6 changes; it was found while proving the
I1 invariant and is recorded here rather than silently folded in.

`test/host/runtime-provenance.test.ts` and `test/unit/verifier-timeout.test.ts`
were updated to the new intended behaviour (host-recorded evidence; the
configurable floor). Neither is a protected oracle; their core assertions are
unchanged. Three failures in the wider suite (a TUI dialog assertion, the T025
goal-help wording, and a `decision-ledger` id format) reproduce on pristine
HEAD and are unrelated to this goal.
