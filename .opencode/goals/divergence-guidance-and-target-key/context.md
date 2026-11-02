# Context (facts only) — recon 2026-10-15

## Where the vague refusals live today (v0.4.0)
- `src/server/app.ts:1243` — resolver refusal: "The latest actual owner chat does not authorize this action/continuation. Ask a genuine Composer clarification; no command or sidebar acceptance is required." This is what axiom-lab-release saw every time while the disk bytes (timeout 900) differed from the lock (600).
- `src/server/app.ts:1165` — `revertPolicyChange` already says "The disk contract differs from the locked generation; recover the divergence first." (no command, no hashes).
- `src/server/app.ts:2820` — `goal_manage`: "Selected goal identity changed. Refresh its details before acting." after an adopt/restore changed the lock; axiom needed `goal_inventory` to find the new `live:<slug>:<runId>` key.
- `src/server/app.ts:2194-2195` (approx.) — resume/verify prerequisite: "This goal has an unresolved staged amendment. Resolve that exact review in Composer chat with goal_resolve_amendment before resuming or verifying" — wrong advice when the real cause is divergence.
- `manageGoal` (~2563) offers a `requiredReview` decision with "Review pending amendment" while an unanswered review exists.
- `recoverDivergence` returns `{decisionId, slug, runId, lock, diskLock, diff, provenance, status}` — no `key`, so the caller must run `goal_inventory` to resume.
- `goal_status` (`view`) has no target tuple; `GoalSummary`/`GoalTarget` in `src/rpc.ts` define the key/runId/sessionID/lock shape `goal_manage` requires.

## Observed impact (axiom-lab-release, mbx 01M4Z0CMHVG3VCCFNJZXAKVQE6)
- 10+ "Accept amendment" answers, each ending in `decision-form-operation-failed` with the resolver text above; the hidden cause was the divergence. Hours lost.
- After the adopt succeeded, `goal_manage resume` failed once with "Selected goal identity changed"; `goal_inventory` gave the new key and the retry worked.

## Existing protections to keep
- `protect` in this repository's goals covers the host tests; the new tests here are authored red-first.
- Commands: `bun run typecheck`, `cleo run --wait --class test -- bun test <file>`, `bun scripts/check-installed-goal.ts --min-version X --assert-release`, `OCGOAL_GIT_SPEC=github:kryptobaseddev/opencode-goal#v<TAG>` for installed-tag runs.
