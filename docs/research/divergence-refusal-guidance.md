---
title: 'Divergence refusals name the fix; adoption returns the new target'
audience: maintainer
status: draft
---
# Divergence refusals name the fix; adoption returns the new target

## The report (axiom-lab-release, mbx 01M4Z0CMHVG3VCCFNJZXAKVQE6)

Two failures cost that lane hours:
- **(a)** `goal_manage resume` with the bare slug/lock was refused with "Selected goal identity changed" after an adoption. The goal KEY is `live:<slug>:<runId>`; nothing surfaced it, so `goal_inventory` had to be discovered first.
- **(b)** The amendment loop — the form was answered "Accept" ten or more times and each attempt ended in `decision-form-operation-failed` with "the latest actual owner chat does not authorize". The real cause was a disk `goal.yaml` that already differed from the locked generation. The resolver knew nothing about it.

## What changed

| Refusal path | Before | Now |
|---|---|---|
| `goal_resolve_amendment` (owner chat) | generic "does not authorize" | names the divergence, both hashes and the exact `goal_recover_divergence {"slug":…,"expectedLock":…}` call |
| Amendment review (`goal_review`) | "The reviewed amendment target changed" | divergence is named first, and the review is **not** re-presented while the disk differs |
| `goal_manage` resume/verify prerequisite | "unresolved staged amendment… resolve in Composer chat" | divergence is named first; no resume question is offered |
| `goal_manage` invalid-goal refusal | "This selected goal is read-only (draft, archived or invalid)" | a goal whose only fault is the divergence names the recovery instead |
| Revert of an agent-policy change | "disk contract differs… recover the divergence first" | the full call with both hashes |

`goal_status` and the `goal_recover_divergence` result now carry the `target` tuple
(`key`, `lock`, `runId`, `sessionID`) that `goal_manage` accepts, and an
identity-changed refusal names the refreshed tuple rather than only saying to refresh.

Non-divergence refusals keep their exact previous wording, and the divergence
check reads the locked snapshot versus the disk bytes — never the presence of a
pending proposal.

## Evidence

- Red before the fix, Junit `.tmp/verification/v041-red/red-final.xml`
  (SHA256 8b674021f3f945df5b4c7aae5d8c33c1b1989d6917f70d2ed890cff2d65f4cd5): 2 pass / 6 fail.
- Green after the fix in the same three files: 8 pass / 0 fail.
- Invariant run (recovery, autonomy, verifier diagnostics, target-bound, launch,
  Composer amendment, owner-chat launch, amendment prerequisite): 38 pass / 0 fail.
- TypeScript and generated TUI freshness: clean.
- The pre-existing unrelated unit failures (real-TUI dialog, goal help text) are
  unchanged and predate this work.

The recovery flow itself is unchanged: the owner still chooses Adopt disk version,
Restore locked version or Leave unchanged, and no earlier proposal or approval is
counted as acceptance.