// T168 — one question/decision engine for the write-goal interview.
//
// The same interview serves three modes:
//   new       nothing existing covers this work; draft a contract (today's flow)
//   continue  an existing goal already covers this work; resume/repair it
//   optimize  the owner wants to CHANGE an existing goal; stage an amendment
//
// The mode comes from the T167 kickoff triage and/or an explicit owner choice.
// The questions never change: each topic is resolved against what the existing
// contract already answers, so an existing goal is asked ONLY about the
// decisions it does not answer (plus anything the owner's change reopens).
// Pure and deterministic — no I/O and no model call, so the skip table can be
// tested and replayed. `app.ts` supplies the goal/inventory facts and the host
// tools enforce the outcomes; this module only decides.

import { describeTriageTarget, type TriageAssessment, type TriageTarget } from "./kickoff-triage"

export const INTERVIEW_MODES = ["new", "continue", "optimize"] as const
export type InterviewMode = (typeof INTERVIEW_MODES)[number]

/** The decisions the interview asks about, in asking order. */
export const INTERVIEW_TOPICS = ["outcome", "done-when", "evidence", "oracles", "invariants", "scope", "escalation", "budget", "autonomy", "priority"] as const
export type InterviewTopic = (typeof INTERVIEW_TOPICS)[number]

type TopicDefinition = {
  topic: InterviewTopic
  question: string
  hint: string
  /** A contract without this answer fails validation or cannot be executed. */
  required: boolean
  /** Ask only when the owner wants it (budget/autonomy), never as a blocker. */
  optional?: boolean
  /** Only a real decision when the project already has another live goal. */
  conditional?: "live-goal"
}

const TOPICS: readonly TopicDefinition[] = [
  { topic: "outcome", question: "Which end state should be true when this goal finishes?", hint: "the narrowest state that satisfies the owner's words; offer one broader and one narrower alternative", required: true },
  { topic: "done-when", question: "What proves it?", hint: "existing commands from recon first: the failing test, the suite, the build, a bench; a new check only if none exists", required: true },
  { topic: "evidence", question: "How strict is completion?", hint: "host checks + independent verifier (Recommended) · host checks only · strict", required: true },
  { topic: "oracles", question: "Which files must the worker never change?", hint: "the tests and benchmarks named in Done-when", required: false },
  { topic: "invariants", question: "What must keep working the whole time?", hint: "the full test suite, the build, typecheck", required: false },
  { topic: "scope", question: "Where may the work reach, and what is explicitly out?", hint: "the module recon found; the non-goal is the most tempting adjacent change", required: true },
  { topic: "escalation", question: "When should it stop and ask instead of pushing on?", hint: "irreversible data changes, public API changes, new dependencies, credentials", required: false },
  { topic: "budget", question: "Cap the spend?", hint: "no cap (Recommended for well-proven goals) · a token cap sized to the work · a wall-clock cap", required: false, optional: true },
  { topic: "autonomy", question: "If you type while it runs?", hint: "steer: your message guides the next turn (Recommended) · pause", required: false, optional: true },
  { topic: "priority", question: "Where does this goal rank against the live one if you must choose where work goes first?", hint: "medium (Recommended; the default lane) · high · low · skip (no field)", required: false, conditional: "live-goal" },
]

/** What an existing goal's contract already answers. Absent fields are open
 *  decisions, not empty values: the caller only fills a field when the contract
 *  or the owner explicitly states it. */
export type GoalAnswers = {
  slug: string
  status: string
  runId?: string
  lock?: string
  intent?: string
  outcome?: string
  /** How many essential criteria the contract already fixes. */
  criteria?: number
  /** The explicit verification mode (not the parser's default). */
  evidence?: string
  protect?: string[]
  invariants?: number
  nonGoals?: string[]
  escalation?: string[]
  /** The contract has an explicit autonomy block. */
  autonomy?: boolean
  /** The contract has an explicit budget block. */
  budget?: boolean
  priority?: string
  /** Validation problems; each known path reopens its topic. */
  issues?: string[]
}

export type InterviewChange = {
  /** The owner's words for the change (optimize). */
  text?: string
  /** Which decisions the change touches; only these reopen. */
  topics?: readonly InterviewTopic[]
}

export type InterviewRequest = {
  /** The owner's words (a new goal's intent). */
  intent?: string
  title?: string
  outcome?: string
  /** The existing goal the owner named, when it resolves. */
  goal?: GoalAnswers
  /** The T167 triage of a candidate goal, when one was computed. */
  triage?: TriageAssessment
  /** The owner's explicit mode choice, when they named one. */
  requested?: InterviewMode
  /** The requested change, for optimize. */
  change?: InterviewChange
  /** Topics the owner's words contradict; reopened even when answered. */
  contradicts?: readonly InterviewTopic[]
  /** At least one other goal is live here, so priority is a real choice. */
  hasLiveGoal?: boolean
}

export type TopicStatus = "open" | "resolved" | "optional" | "not-applicable"

export type TopicState = {
  topic: InterviewTopic
  status: TopicStatus
  question: string
  hint: string
  required: boolean
  because: string
  source?: "contract" | "owner" | "triage"
}

export type ModeDecision = {
  mode: InterviewMode
  /** False when the requested mode is impossible (e.g. optimizing nothing). */
  allowed: boolean
  target?: TriageTarget
  /** Every affected goal (more than one means consolidate before amending). */
  targets: TriageTarget[]
  reason: string
}

export type InterviewAction = "write-draft" | "resume" | "stage-amendment" | "edit-draft" | "refused"

export type InterviewPlan = {
  mode: InterviewMode
  allowed: boolean
  action: InterviewAction
  target?: TriageTarget
  targets: TriageTarget[]
  /** Decisions the owner still has to make. Ask ONLY these. */
  open: TopicState[]
  /** Decisions the contract (or the owner's words) already answer. */
  resolved: TopicState[]
  /** Valid but opt-in decisions (budget/autonomy). */
  optional: TopicState[]
  /** Questions that do not apply to this goal. */
  notApplicable: TopicState[]
  /** Contract problems no interview question can fix. */
  contractIssues: string[]
  reason: string
  /** The one supported next step; it never crosses a guard. */
  directive: string
  /** True when a parallel goal for the same work must be refused. */
  duplicateRefused: boolean
}

function targetOfGoal(goal?: GoalAnswers): TriageTarget | undefined {
  if (!goal) return undefined
  return {
    slug: goal.slug,
    status: goal.status,
    ...(goal.runId ? { runId: goal.runId } : {}),
    ...(goal.lock ? { lock: goal.lock } : {}),
  }
}

const describe = (target: TriageTarget) => describeTriageTarget(target)

/**
 * Which mode the interview runs in. The owner's explicit choice wins when it is
 * possible; otherwise the T167 triage decides. `allowed: false` means the
 * requested mode cannot proceed (optimize/continue with no target, or a new
 * goal for work that is already covered) — never a silent fallback.
 */
export function decideInterviewMode(input: InterviewRequest): ModeDecision {
  const triage = input.triage
  const named = targetOfGoal(input.goal)
  const triageTargets = triage && triage.decision !== "new" ? triage.targets : []
  const target = named ?? triageTargets[0]

  if (input.requested === "optimize") {
    if (!target)
      return {
        mode: "optimize",
        allowed: false,
        targets: [],
        reason: "There is no existing goal to optimize. Optimizing changes an existing goal by staging an amendment on its own run; it never writes a second goal. Name the goal to change, or write a new goal.",
      }
    return {
      mode: "optimize",
      allowed: true,
      target,
      targets: triageTargets.length ? triageTargets : [target],
      reason: triageTargets.length > 1
        ? `More than one existing goal covers this work (${triageTargets.map(describe).join("; ")}). Consolidate them by choosing one target and staging the amendment on its exact run/lock; never write another goal.`
        : `Change ${describe(target)} by staging an amendment on its exact run/lock; the owner accepts and goal.yaml stays unchanged until then.`,
    }
  }

  if (input.requested === "continue") {
    if (!target)
      return {
        mode: "continue",
        allowed: false,
        targets: [],
        reason: "There is no existing goal to continue. Name the goal to resume, or write a new goal.",
      }
    return {
      mode: "continue",
      allowed: true,
      target,
      targets: [target],
      reason: `Continue ${describe(target)} in its own run. A second goal for the same work is not created.`,
    }
  }

  // requested === "new" or no explicit choice.
  if (!triage) {
    if (named)
      return {
        mode: "continue",
        allowed: true,
        target: named,
        targets: [named],
        reason: `The owner named existing goal ${describe(named)}; continue it instead of writing a second goal.`,
      }
    return { mode: "new", allowed: true, targets: [], reason: "No existing goal was considered; this is a new goal." }
  }

  if (triage.decision === "new") {
    // The triage compared a candidate. A named existing goal is the owner's
    // explicit target, so it wins over "the candidate text looked new".
    if (input.requested !== "new" && named)
      return {
        mode: "continue",
        allowed: true,
        target: named,
        targets: [named],
        reason: `The owner named existing goal ${describe(named)}; continue it instead of writing a second goal.`,
      }
    return { mode: "new", allowed: true, targets: [], reason: triage.reason }
  }

  // continue/repair → continue in the existing run; consolidate → optimize the
  // surviving goal. A new goal for the same work is refused either way.
  const mode: InterviewMode = triage.decision === "consolidate" ? "optimize" : "continue"
  return {
    mode,
    allowed: input.requested !== "new",
    target: triageTargets[0],
    targets: triageTargets,
    reason: input.requested === "new"
      ? `This is not new work. ${triage.reason} The shared interview resolves it to mode ${mode}; a parallel goal for the same work is refused.`
      : triage.reason,
  }
}

type Answer = { source: "contract" | "owner"; because: string }

function answerOf(topic: InterviewTopic, goal: GoalAnswers): Answer | undefined {
  const byContract = (value: unknown, because: string): Answer | undefined =>
    value === undefined || value === null || value === false || (Array.isArray(value) && value.length === 0) || value === 0 ? undefined : { source: "contract", because }
  switch (topic) {
    case "outcome": return byContract(goal.outcome, "the existing contract fixes the outcome")
    case "done-when": return byContract(goal.criteria, `the existing contract already has ${goal.criteria} criteria`)
    case "evidence": return byContract(goal.evidence, `the existing contract sets verification to ${goal.evidence}`)
    case "oracles": return byContract(goal.protect, "the existing contract already names protected oracles")
    case "invariants": return byContract(goal.invariants, `the existing contract already has ${goal.invariants} invariants`)
    case "scope": return byContract(goal.nonGoals, "the existing contract already fixes scope and non-goals")
    case "escalation": return byContract(goal.escalation, "the existing contract already says when to escalate")
    case "budget": return byContract(goal.budget, "the existing contract already sets a budget")
    case "autonomy": return byContract(goal.autonomy, "the existing contract already sets autonomy")
    case "priority": return byContract(goal.priority, `the existing contract already ranks this goal ${goal.priority}`)
  }
}

/** Known contract-problem paths reopen their topic; the rest are reported as
 *  problems no question can fix. */
const ISSUE_TOPICS: ReadonlyArray<[RegExp, InterviewTopic]> = [
  [/^outcome\b/i, "outcome"],
  [/^(criteria|plan)\b/i, "done-when"],
  [/^(verification|verifier)\b/i, "evidence"],
  [/^protect\b/i, "oracles"],
  [/^invariants\b/i, "invariants"],
  [/^(non_goals|scope)\b/i, "scope"],
  [/^stop\b/i, "escalation"],
  [/^budget\b/i, "budget"],
  [/^autonomy\b/i, "autonomy"],
  [/^priority\b/i, "priority"],
]

function reopenedTopics(input: InterviewRequest, mode: InterviewMode): Set<InterviewTopic> {
  const reopened = new Set<InterviewTopic>(input.contradicts ?? [])
  if (mode === "optimize") for (const topic of input.change?.topics ?? []) reopened.add(topic)
  for (const issue of input.goal?.issues ?? []) {
    const hit = ISSUE_TOPICS.find(([pattern]) => pattern.test(issue.trim()))
    if (hit) reopened.add(hit[1])
  }
  return reopened
}

function stateOf(def: TopicDefinition, status: TopicStatus, because: string, extra: { source?: TopicState["source"] } = {}): TopicState {
  return { topic: def.topic, status, question: def.question, hint: def.hint, required: def.required, because, ...(extra.source ? { source: extra.source } : {}) }
}

function resolveTopic(def: TopicDefinition, input: InterviewRequest, mode: InterviewMode, reopened: ReadonlySet<InterviewTopic>): TopicState {
  // A topic the owner's change touches (or their words contradict) is asked
  // again even when the contract answers it: the new answer is the decision.
  if (reopened.has(def.topic))
    return stateOf(def, "open", input.change?.topics?.includes(def.topic)
      ? "the owner's change reopens this decision"
      : "this decision contradicts or invalidates the contract; ask for the replacement")

  if (def.conditional === "live-goal" && !input.hasLiveGoal)
    return stateOf(def, "not-applicable", "no other goal is live here, so there is nothing to rank against")

  // A brand-new goal has no contract to answer anything; only the owner's
  // words in the seed count (an outcome they already stated).
  if (mode === "new") {
    if (def.topic === "outcome" && input.outcome)
      return stateOf(def, "resolved", "the owner already stated the outcome", { source: "owner" })
  } else if (input.goal) {
    const answer = answerOf(def.topic, input.goal)
    if (answer) return stateOf(def, "resolved", answer.because, { source: answer.source })
  }

  if (def.optional) return stateOf(def, "optional", "opt-in: ask only when the owner wants it, never as a blocker")
  return stateOf(def, "open", "the existing contract does not answer this")
}

function directiveFor(decision: ModeDecision, action: InterviewAction): string {
  const target = decision.target
  if (!decision.allowed || !target)
    return `Refused: ${decision.reason} Nothing was created or changed.`
  switch (action) {
    case "write-draft":
      return "Write the goal with the write-goal interview and ask ONLY the open questions. Validate, show the exact contract, then call goal_prepare_launch; the host triages again before any run is created."
    case "resume":
      return ["running", "waiting", "verifying"].includes(target.status)
        ? `Do not write a second goal or start ${describe(target)} again: it is already ${target.status}. Answer only the open decisions; if the contract itself must change, stage goal_propose_amendment on its exact run/lock.`
        : `Do not write a second goal. Resolve ${describe(target)} and use the supported path: goal_manage resume for a stopped run, or goal_prepare_launch for an existing draft. Ask only the open questions first; never re-ask what the contract already answers.`
    case "stage-amendment":
      return `Do not write a second goal and do not call goal_prepare_launch. Read ${describe(target)}, apply only the owner's change, then call goal_propose_amendment({slug:"${target.slug}", expectedLock:"${target.lock ?? "<locked sha256>"}", yaml:"<full replacement>", rationale:"..."}). The owner accepts the reviewed diff; goal.yaml stays byte-identical until that acceptance.`
    case "edit-draft":
      return `The target ${describe(target)} is a draft with no run or lock: edit its goal.yaml through the write-goal draft path, then prepare its launch. Do not stage an amendment and do not write a second goal.`
    case "refused":
      return `Refused: ${decision.reason} Nothing was created or changed.`
  }
}

/**
 * The interview plan. Same topics for every mode; only the resolution source
 * changes, so `new`, `continue` and `optimize` cannot drift apart.
 */
export function planInterview(input: InterviewRequest): InterviewPlan {
  const decision = decideInterviewMode(input)
  const mode = decision.mode
  const goal = mode === "new" ? undefined : input.goal
  const reopened = reopenedTopics(input, mode)
  const states = TOPICS.map((def) => resolveTopic(def, input, mode, reopened))
  const open = states.filter((s) => s.status === "open")
  const resolved = states.filter((s) => s.status === "resolved")
  const optional = states.filter((s) => s.status === "optional")
  const notApplicable = states.filter((s) => s.status === "not-applicable")
  const contractIssues = (goal?.issues ?? []).filter((issue) => !ISSUE_TOPICS.some(([pattern]) => pattern.test(issue.trim())))
  const action: InterviewAction = !decision.allowed
    ? "refused"
    : mode === "new"
      ? "write-draft"
      : mode === "continue"
        ? "resume"
        : decision.target?.runId
          ? "stage-amendment"
          : "edit-draft"
  return {
    mode,
    allowed: decision.allowed,
    action,
    ...(decision.target ? { target: decision.target } : {}),
    targets: decision.targets,
    open,
    resolved,
    optional,
    notApplicable,
    contractIssues,
    reason: decision.reason,
    directive: directiveFor(decision, action),
    // A requested NEW goal for work the triage already covers: the parallel
    // goal is what must be refused, not the work itself.
    duplicateRefused: input.requested === "new" && !decision.allowed,
  }
}
