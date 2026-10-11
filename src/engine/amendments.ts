import { OwnerReviewStore, type ReviewRequest } from "./owner-reviews"
import type { RunState } from "./state"
import type { amendmentDiff } from "./amendment"

export type AmendmentRequest = ReviewRequest & {
  targetSessionID: string
  runId: string
  nextLock: string
  nextText: string
  rationale: string
  diff: ReturnType<typeof amendmentDiff>
  /** Host write-ahead record: populated ONLY after authenticated acceptance. */
  commit?: { state: RunState; acceptedAt: number }
}

export const amendmentChoices = [
  { value: "accept", label: "Accept amendment", description: "Re-lock this exact reviewed diff. Changed oracle evidence resets; unchanged evidence remains. The goal stays stopped." },
  { value: "reject", label: "Reject amendment", description: "Discard this proposal, keeping the current contract and all its evidence. The goal stays stopped." },
  { value: "comment", label: "Comment or revise", description: "Return feedback to the agent for a revised proposal. No contract change or resume is authorized." },
] as const

export class AmendmentStore extends OwnerReviewStore<AmendmentRequest> {
  constructor(file: string) { super(file, amendmentChoices) }
  writeAhead(id: string, commit: NonNullable<AmendmentRequest["commit"]>): AmendmentRequest {
    return this.mutate((data) => {
      const p = data.requests[id]
      if (!p || p.status !== "executing" || p.issuerPID !== process.pid) throw new Error("No reserved owner acceptance for amendment")
      if (p.commit) throw new Error("Amendment acceptance is already recorded")
      p.commit = commit
      return p
    })
  }
}
