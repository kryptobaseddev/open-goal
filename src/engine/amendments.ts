import { OwnerReviewStore, processAlive, reviewExpired, type ReviewRequest } from "./owner-reviews"
import type { RunState } from "./state"
import type { amendmentDiff } from "./amendment"

export type AmendmentRequest = ReviewRequest & {
  targetSessionID: string
  runId: string
  nextLock: string
  nextText: string
  rationale: string
  /** Non-consenting admission pointer: lets chat reach the agent when its
   * matching native question arrives later. Never authorizes a commit. */
  chatAdmissionMessageID?: string
  diff: ReturnType<typeof amendmentDiff>
  /** Host write-ahead record: populated ONLY after authenticated acceptance. */
  commit?: { state: RunState; acceptedAt: number }
  /** Who authorised application: the owner (default), the owner-set autonomy
   * policy for an in-policy agent change, or the owner's revert. */
  appliedBy?: "owner" | "agent-policy" | "owner-revert"
  policyClasses?: string[]
  /** Divergence recovery: the disk contract is ahead of the lock. lock is the
   * locked generation, nextLock/nextText the disk bytes under review. */
  recovery?: { provenance: string[]; diskMtime?: number }
}

export const amendmentChoices = [
  { value: "accept", label: "Accept amendment", description: "Re-lock this exact reviewed diff. Changed oracle evidence resets; unchanged evidence remains. The goal stays stopped." },
  { value: "reject", label: "Reject amendment", description: "Discard this proposal, keeping the current contract and all its evidence. The goal stays stopped." },
  { value: "comment", label: "Comment or revise", description: "Return feedback to the agent for a revised proposal. No contract change or resume is authorized." },
] as const

export const recoveryChoices = [
  { value: "adopt", label: "Adopt disk version", description: "Make the disk bytes a new journalled generation. Changed criteria reset; unchanged proof remains. The goal stays stopped." },
  { value: "restore", label: "Restore locked version", description: "Write the locked contract back to goal.yaml and keep the disk bytes as evidence. The goal stays stopped." },
  { value: "leave", label: "Leave unchanged", description: "Change nothing. The goal stays stopped until the divergence is resolved." },
] as const

export class AmendmentStore extends OwnerReviewStore<AmendmentRequest> {
  constructor(file: string) { super(file, amendmentChoices) }
  protected override reviewChoices(request: AmendmentRequest) { return request.recovery ? recoveryChoices : amendmentChoices }
  choicesFor(request: AmendmentRequest) { return this.reviewChoices(request) }

  noteChatAdmission(id: string, messageID?: string): AmendmentRequest | undefined {
    return this.mutate((data) => {
      const request = data.requests[id]
      if (!request || !["pending", "interrupted"].includes(request.status) || reviewExpired(request) || request.ownerMessageID
        || request.issuerPID !== process.pid && processAlive(request.issuerPID)) return undefined
      if (messageID) request.chatAdmissionMessageID = messageID
      else delete request.chatAdmissionMessageID
      return request
    })
  }

  takeChatAdmission(id: string, messageID: string): boolean {
    return this.mutate((data) => {
      const request = data.requests[id]
      if (!request || request.status !== "pending" || request.chatAdmissionMessageID !== messageID || request.ownerMessageID || reviewExpired(request)
        || request.issuerPID !== process.pid && processAlive(request.issuerPID)) return false
      delete request.chatAdmissionMessageID
      return true
    })
  }
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
