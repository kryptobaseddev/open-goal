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

/**
 * Should the native form be re-offered when a turn ends?
 *
 * An unanswered decision is not stale, but re-asking it on every turn end is
 * noise (the owner sees the same question forever). The policy is: ask once
 * per process; after that, silence until an explicit `goal_review` (which
 * calls the form directly) or a reload (a new process, so `alreadyAsked` is
 * false again). Dismissed reviews (`interrupted`) and open forms never re-ask.
 */
export function shouldReaskDecision(input: {
  alreadyAsked: boolean
  status: string
  stale: boolean
  formOpen: boolean
}): { ask: boolean; reason?: "already-asked" | "interrupted" | "stale" | "form-open" } {
  if (input.stale) return { ask: false, reason: "stale" }
  if (input.formOpen) return { ask: false, reason: "form-open" }
  if (input.status === "interrupted") return { ask: false, reason: "interrupted" }
  if (input.alreadyAsked) return { ask: false, reason: "already-asked" }
  return { ask: true }
}

export class DecisionStore extends OwnerReviewStore<DecisionRequest> {
  constructor(file: string) { super(file, []) }
  protected reviewChoices(request: DecisionRequest) { return decisionChoices(request) }
}
