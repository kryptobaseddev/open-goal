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
}

export const amendmentChoices = [
  { value: "accept", label: "Accept amendment", description: "Re-lock this exact reviewed diff. Changed oracle evidence resets; unchanged evidence remains. The goal stays stopped." },
  { value: "reject", label: "Reject amendment", description: "Discard this proposal, keeping the current contract and all its evidence. The goal stays stopped." },
  { value: "comment", label: "Comment or revise", description: "Return feedback to the agent for a revised proposal. No contract change or resume is authorized." },
] as const

export class AmendmentStore extends OwnerReviewStore<AmendmentRequest> {
  constructor(file: string) { super(file, amendmentChoices) }

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
