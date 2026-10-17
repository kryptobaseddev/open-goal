// v0.8.0 — a decision that can never legitimately be answered must never be
// shown again.
//
// Three ways a stored owner question goes stale without an answer:
//   - the target generation moved on (lock/run/session changed) or the goal was
//     superseded — the old question is about bytes that no longer exist;
//   - the review's own clock expired (legacy/timed reviews only);
//   - it was already answered or otherwise settled.
//
// A dismissed review (`interrupted`) is NOT stale: it is unanswered and may be
// re-presented by an explicit reload or goal_review. Pure on purpose.

import { reviewExpired } from "./owner-reviews"

export type DecisionLike = {
  status: string
  expiresAt: number
  expiryPolicy?: "time" | "target"
}

export type TargetLike = {
  slug: string
  runId?: string
  sessionID?: string
  lock: string
  status?: string
}

export type Staleness =
  | { stale: false }
  | { stale: true; code: "answered" | "expired" | "superseded" | "target-changed" | "missing"; reason: string }

const OPEN = ["pending", "interrupted"]

export function decisionStaleness(request: DecisionLike, current: TargetLike | undefined, now = Date.now()): Staleness {
  if (!OPEN.includes(request.status))
    return { stale: true, code: "answered", reason: `the decision is already ${request.status}; old choices cannot be replayed` }
  if (reviewExpired(request, now))
    return { stale: true, code: "expired", reason: "the review expired; a new exact review is required" }
  if (!current)
    return { stale: true, code: "missing", reason: "the decision's target no longer exists" }
  if (current.status === "superseded")
    return { stale: true, code: "superseded", reason: "the goal was superseded by a successor" }
  return { stale: false }
}

/** Whether the target tuple the review was bound to still names the same run. */
export function sameTarget(
  bound: { slug: string; runId?: string; sessionID?: string; lock: string },
  current: TargetLike | undefined,
): boolean {
  return !!current && current.slug === bound.slug && current.lock === bound.lock
    && current.runId === bound.runId && current.sessionID === bound.sessionID
}

/** The full check the engine uses before re-presenting: staleness + tuple. */
export function staleDecision(
  request: DecisionLike,
  bound: { slug: string; runId?: string; sessionID?: string; lock: string },
  current: TargetLike | undefined,
  now = Date.now(),
): Staleness {
  const base = decisionStaleness(request, current, now)
  if (base.stale) return base
  if (!sameTarget(bound, current))
    return { stale: true, code: "target-changed", reason: "the goal generation or owning session changed; the old review is invalid" }
  return { stale: false }
}
