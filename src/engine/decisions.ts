import type { EngineMessage } from "../server/messages"
import { OwnerReviewStore, type ReviewChoice, type ReviewRequest } from "./owner-reviews"

export type DecisionKind = "needs_review" | "paused-after-verdict" | "blocked" | "budget_limited" | "amend-proposed" | "supersede-ack" | "complete" | "start-picker" | "owner-operation"
export type DecisionTarget = { slug: string; runId?: string; sessionID?: string; lock: string; status: string }
export type DecisionRequest = ReviewRequest & {
  kind: DecisionKind
  message: EngineMessage
  target: DecisionTarget
  /** Draft choices (start-picker) bind each candidate's bytes, too. */
  candidates: Record<string, DecisionTarget>
  extra: Record<string, unknown>
}

export function decisionChoices(request: DecisionRequest): ReviewChoice[] {
  return request.message.choices.map((c, i) => ({ value: String(i), label: c.label, description: `${c.act ? "" : "Guidance only; no operation: "}${c.run}` }))
}

export class DecisionStore extends OwnerReviewStore<DecisionRequest> {
  constructor(file: string) { super(file, []) }
  protected reviewChoices(request: DecisionRequest) { return decisionChoices(request) }
}
