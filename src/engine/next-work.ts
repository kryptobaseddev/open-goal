// v0.8.0 — what the loop does after a goal completes.
//
// Sources, in order (the design note states this too):
//   1. a ready CLEO item in THIS project — the owner's own task board;
//   2. work offered by a peer over AgentMBX (a reply to our availability notice);
//   3. nothing — go idle and announce availability (rate-limited).
//
// A candidate is a proposal, never consent: the stop rules are evaluated for
// every candidate before it can be started, and the adapter records what it
// started. Pure so the host is not needed to test the decision.

import { loopStop, type StopDecision } from "./loop-stop"
import { announceDue, type AnnounceState } from "./peer-announce"

export type WorkCandidate = {
  source: "cleo" | "peer"
  /** Project identity the work belongs to (absolute path or project id). */
  project: string
  taskId?: string
  title: string
  acceptance?: string[]
  /** Peer identity, for peer candidates. */
  from?: string
  messageId?: string
  at?: number
}

export type NextWorkInput = {
  candidates: WorkCandidate[]
  currentProject: string
  visitedProjects?: string[]
  /** Safety stops, evaluated before any candidate. */
  humanCriterionPending?: boolean
  blocker?: string
  outwardActRequired?: boolean
  /** Per-candidate limits from the source contract. */
  budgetExhausted?: boolean
  allowBudgetExhaustion?: boolean
  allowNewProjects?: boolean
  announce: AnnounceState
  now: number
  cooldownMs: number
}

export type NextWorkDecision =
  | { kind: "start"; candidate: WorkCandidate }
  | { kind: "announce" }
  | { kind: "hold"; reason: "outstanding" | "cooldown" | "no-work" }
  | { kind: "stop"; code: Extract<StopDecision, { stop: true }>["code"]; reason: string }

export function nextWork(input: NextWorkInput): NextWorkDecision {
  // The three stops no policy may waive.
  const safety = loopStop({
    ...(input.humanCriterionPending ? { humanCriterionPending: true } : {}),
    ...(input.blocker ? { blocker: input.blocker } : {}),
    ...(input.outwardActRequired ? { outwardActRequired: true } : {}),
    currentProject: input.currentProject,
  })
  if (safety.stop) return { kind: "stop", code: safety.code, reason: safety.reason }

  // CLEO first, then peers. The caller supplies each source already ordered.
  const ordered = [...input.candidates].sort((a, b) => (a.source === b.source ? 0 : a.source === "cleo" ? -1 : 1))
  for (const candidate of ordered) {
    const stop = loopStop({
      ...(input.humanCriterionPending ? { humanCriterionPending: true } : {}),
      ...(input.blocker ? { blocker: input.blocker } : {}),
      ...(input.outwardActRequired ? { outwardActRequired: true } : {}),
      ...(input.budgetExhausted ? { budgetExhausted: true } : {}),
      ...(input.allowBudgetExhaustion ? { allowBudgetExhaustion: true } : {}),
      ...(input.allowNewProjects ? { allowNewProjects: true } : {}),
      candidateProject: candidate.project,
      currentProject: input.currentProject,
      ...(input.visitedProjects ? { visitedProjects: input.visitedProjects } : {}),
    })
    if (stop.stop) return { kind: "stop", code: stop.code, reason: stop.reason }
    return { kind: "start", candidate }
  }

  const announce = announceDue(input.announce, input.now, input.cooldownMs)
  if (announce.due) return { kind: "announce" }
  return { kind: "hold", reason: announce.reason }
}
