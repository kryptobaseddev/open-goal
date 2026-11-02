// T167 — kickoff triage. Before a new goal is admitted, compare it with this
// project's existing goals (the same inventory goal_inventory reports) and
// answer one question: should the owner continue, repair or consolidate an
// existing goal, or is this genuinely new? Pure and deterministic — no I/O and
// no model call, so the answer can be tested and replayed.
//
// Rules:
// - The candidate's own folder is never a duplicate of itself; launching an
//   existing draft is not a new goal.
// - Archived generations are history and never block; a terminal generation
//   (complete/failed/aborted/superseded) does not block a new attempt either.
// - `supersedes: <slug>@<lock-prefix>` is an explicit owner replacement, so
//   the predecessor is not treated as a duplicate.
// - Overlap is near-identical intent OR outcome (the fields a duplicate goal
//   would share), or an identical title when neither contract is readable.
// - One overlapping goal routes to continue (a live run or valid draft) or
//   repair (stopped, blocked, divergent or unreadable); two or more route to
//   consolidate so duplicates are merged before another goal is written.
// - `includeDrafts: false` is the direct-start rule: the owner named an
//   existing goal to run, so other drafts are alternatives, not blockers.

import { similarity } from "./similarity"

export const TRIAGE_DECISIONS = ["continue", "repair", "consolidate", "new"] as const
export type TriageDecision = (typeof TRIAGE_DECISIONS)[number]

/** Near-identical intent or outcome. Jaccard at 0.6 ignores shared scaffolding
 *  ("make X work") but catches a re-skinned version of the same work. */
export const DEFAULT_OVERLAP = 0.6

export type TriageCandidate = {
  /** The candidate's own existing folder (a draft being launched), if any. */
  slug?: string
  title: string
  intent: string
  outcome: string
  /** "<slug>@<lock-prefix>" — this goal deliberately replaces that one. */
  supersedes?: string
}

export type TriageGoal = {
  slug: string
  title: string
  status: string
  intent?: string
  outcome?: string
  runId?: string
  lock?: string
  sessionID?: string
  archived?: boolean
  /** Inventory's verdict: false for an invalid draft or a divergent run. */
  valid?: boolean
  issues?: string[]
}

export type TriageTarget = { slug: string; status: string; runId?: string; lock?: string }

export type TriageAssessment = {
  decision: TriageDecision
  target?: TriageTarget
  /** Every overlapping goal, most relevant first. More than one ⇒ consolidate. */
  targets: TriageTarget[]
  reason: string
}

const ACTIVE = new Set(["running", "waiting", "verifying"])
const TERMINAL = new Set(["complete", "failed", "aborted", "superseded"])

/** Stable identity for a refusal: the slug, run and lock the owner must act on. */
export function describeTriageTarget(target: TriageTarget): string {
  const run = target.runId ? `run ${target.runId}` : "no run yet"
  const lock = target.lock ? `lock ${target.lock}` : "no lock"
  return `"${target.slug}" (${run}, ${lock}, status ${target.status})`
}

function targetOf(goal: TriageGoal): TriageTarget {
  return {
    slug: goal.slug,
    status: goal.status,
    ...(goal.runId ? { runId: goal.runId } : {}),
    ...(goal.lock ? { lock: goal.lock } : {}),
  }
}

/** Near-identical intent OR outcome. Falls back to the title only when neither
 *  side has a readable contract, so a torn/invalid draft stays comparable. */
export function overlapScore(candidate: TriageCandidate, goal: TriageGoal): number {
  const intent = similarity(candidate.intent, goal.intent ?? "")
  const outcome = similarity(candidate.outcome, goal.outcome ?? "")
  const byContract = Math.max(intent, outcome)
  if (byContract > 0) return byContract
  if (!goal.intent && !goal.outcome) return similarity(candidate.title, goal.title)
  return 0
}

function invalid(goal: TriageGoal): boolean {
  return goal.valid === false || (Array.isArray(goal.issues) && goal.issues.length > 0)
}

function overlapping(candidate: TriageCandidate, goals: readonly TriageGoal[], threshold: number): Array<{ goal: TriageGoal; score: number }> {
  const candidateSlug = candidate.slug?.trim().toLowerCase()
  const superseded = candidate.supersedes?.split("@")[0]?.trim().toLowerCase()
  return goals
    .filter((goal) => !goal.archived)
    .filter((goal) => ![candidateSlug, superseded].includes(goal.slug.trim().toLowerCase()))
    .map((goal) => ({ goal, score: overlapScore(candidate, goal) }))
    .filter((match) => match.score >= threshold)
    .sort((a, b) => b.score - a.score || a.goal.slug.localeCompare(b.goal.slug))
}

/**
 * The kickoff decision for a candidate goal. Deterministic: the same candidate
 * and inventory always produce the same decision, targets and reason.
 */
export function triageKickoff(
  candidate: TriageCandidate,
  goals: readonly TriageGoal[],
  options: { threshold?: number; includeDrafts?: boolean } = {},
): TriageAssessment {
  const threshold = options.threshold ?? DEFAULT_OVERLAP
  const matches = overlapping(candidate, goals, threshold)
    // A draft is a written proposal, not work in flight. When the owner names
    // an existing draft to start, other drafts are alternatives, not blockers;
    // when a NEW goal is being admitted, a matching draft is the cheaper route
    // and must be surfaced instead of duplicated.
    .filter((match) => options.includeDrafts !== false || match.goal.status !== "draft")
  const blocking = matches.filter((match) => !TERMINAL.has(match.goal.status))
  const terminal = matches.filter((match) => TERMINAL.has(match.goal.status))

  const reasonForHistory = terminal.length
    ? ` ${terminal.length === 1 ? "One finished generation" : `${terminal.length} finished generations`} (${terminal.map((m) => `"${m.goal.slug}"`).join(", ")}) overlap${terminal.length === 1 ? "s" : ""}, but finished work does not block a new attempt.`
    : ""

  if (!blocking.length)
    return {
      decision: "new",
      targets: [],
      reason: `No existing goal in this project overlaps this work; it is not a duplicate.${reasonForHistory}`,
    }

  const targets = blocking.map((match) => targetOf(match.goal))
  if (targets.length > 1)
    return {
      decision: "consolidate",
      target: targets[0],
      targets,
      reason: `More than one existing goal covers this work: ${targets.map(describeTriageTarget).join("; ")}. Consolidate them before creating another goal.`,
    }

  const goal = blocking[0]!.goal
  const target = targets[0]!
  if (invalid(goal))
    return {
      decision: "repair",
      target,
      targets,
      reason: `Existing goal ${describeTriageTarget(target)} covers this work but needs repair (${goal.issues?.join("; ") || "its contract or run is invalid"}); repair it instead of creating a duplicate.`,
    }
  if (ACTIVE.has(goal.status))
    return {
      decision: "continue",
      target,
      targets,
      reason: `Existing goal ${describeTriageTarget(target)} is already running this work; continue it instead of creating a duplicate.`,
    }
  if (goal.status === "draft")
    return {
      decision: "continue",
      target,
      targets,
      reason: `Existing draft ${describeTriageTarget(target)} already covers this work; review and launch it instead of writing a duplicate.`,
    }
  return {
    decision: "repair",
    target,
    targets,
    reason: `Existing goal ${describeTriageTarget(target)} covers this work but its run is ${goal.status}; repair or resume it instead of creating a duplicate.`,
  }
}
