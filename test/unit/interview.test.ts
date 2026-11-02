import { describe, expect, test } from "bun:test"
import { triageKickoff, type TriageGoal } from "../../src/engine/kickoff-triage"
import {
  INTERVIEW_TOPICS,
  decideInterviewMode,
  planInterview,
  type GoalAnswers,
  type InterviewMode,
} from "../../src/engine/interview"

// T168 — new, continue and optimize share one question engine. These tests pin
// the mode decision and the skip table: a fully specified goal is asked nothing;
// a partial one is asked exactly what its contract does not answer.

const lock = "b".repeat(64)
const otherLock = "c".repeat(64)
const INTENT = "stop the login timing out on slow networks"
const OUTCOME = "the login request completes in under two seconds"

const full: GoalAnswers = {
  slug: "login-timeout",
  status: "paused",
  runId: "run-1",
  lock,
  intent: INTENT,
  outcome: OUTCOME,
  criteria: 3,
  evidence: "host+verifier",
  protect: ["test/login.test.ts"],
  invariants: 1,
  nonGoals: ["no redesign of the login page"],
  escalation: ["the fix needs a backend API change"],
  autonomy: true,
  budget: true,
  priority: "high",
}

const partial: GoalAnswers = {
  slug: "login-timeout",
  status: "draft",
  lock,
  intent: INTENT,
  outcome: OUTCOME,
  criteria: 2,
  nonGoals: ["no redesign of the login page"],
}

const candidates = { title: "Login no longer times out", intent: INTENT, outcome: OUTCOME }
const existing = (over: Partial<TriageGoal> = {}): TriageGoal => ({
  slug: "login-timeout",
  title: "Login no longer times out",
  status: "paused",
  intent: INTENT,
  outcome: OUTCOME,
  runId: "run-1",
  lock,
  ...over,
})

const topics = (states: ReadonlyArray<{ topic: string }>) => states.map((s) => s.topic)

describe("interview mode decision (T168)", () => {
  test("an empty history is a new goal", () => {
    const decision = decideInterviewMode({ intent: INTENT })
    expect(decision).toMatchObject({ mode: "new", allowed: true, targets: [] })
    expect(decision.target).toBeUndefined()
  })

  test("the T167 triage decides: continue, repair → continue, consolidate → optimize", () => {
    const cont = decideInterviewMode({ triage: triageKickoff(candidates, [existing({ status: "running" })]) })
    expect(cont).toMatchObject({ mode: "continue", allowed: true, target: { slug: "login-timeout", runId: "run-1", lock } })

    const repair = decideInterviewMode({ triage: triageKickoff(candidates, [existing({ status: "blocked" })]) })
    expect(repair.mode).toBe("continue")
    expect(repair.reason).toContain("blocked")

    const merge = decideInterviewMode({
      triage: triageKickoff(candidates, [existing({ status: "running" }), existing({ slug: "slow-login", status: "draft", runId: undefined })]),
    })
    expect(merge.mode).toBe("optimize")
    expect(merge.targets.map((t) => t.slug)).toEqual(["login-timeout", "slow-login"])
    expect(merge.reason).toContain("Consolidate")
  })

  test("an explicit owner choice wins when it is possible", () => {
    expect(decideInterviewMode({ requested: "optimize", goal: full })).toMatchObject({ mode: "optimize", allowed: true })
    expect(decideInterviewMode({ requested: "continue", goal: full })).toMatchObject({ mode: "continue", allowed: true })
    // Naming an existing goal is a continue even when no triage was computed.
    expect(decideInterviewMode({ goal: full })).toMatchObject({ mode: "continue", allowed: true })
  })

  test("a requested new goal for covered work is refused as a duplicate", () => {
    const decision = decideInterviewMode({
      requested: "new",
      triage: triageKickoff(candidates, [existing({ status: "running" })]),
    })
    expect(decision).toMatchObject({ mode: "continue", allowed: false })
    expect(decision.reason).toContain("not new work")
    expect(decision.reason).toContain('"login-timeout"')
  })

  test("optimize and continue with no existing goal are refused, never silently new", () => {
    for (const requested of ["optimize", "continue"] as const) {
      const decision = decideInterviewMode({ requested, intent: INTENT })
      expect(decision.mode).toBe(requested)
      expect(decision.allowed).toBe(false)
      expect(decision.reason).toContain("no existing goal")
    }
  })
})

describe("the question engine (T168)", () => {
  test("a new goal asks every required decision, in the one canonical order", () => {
    const plan = planInterview({ intent: INTENT })
    expect(plan).toMatchObject({ mode: "new", action: "write-draft", allowed: true, duplicateRefused: false })
    expect(topics(plan.open)).toEqual(["outcome", "done-when", "evidence", "oracles", "invariants", "scope", "escalation"])
    expect(topics(plan.optional)).toEqual(["budget", "autonomy"])
    expect(topics(plan.notApplicable)).toEqual(["priority"])
    // Every mode asks from the same bank, in the same order.
    for (const state of [...plan.open, ...plan.resolved, ...plan.optional, ...plan.notApplicable])
      expect(INTERVIEW_TOPICS).toContain(state.topic)
  })

  test("an owner-stated outcome is not asked again", () => {
    const plan = planInterview({ intent: INTENT, outcome: OUTCOME })
    expect(topics(plan.open)).not.toContain("outcome")
    expect(plan.resolved.find((s) => s.topic === "outcome")).toMatchObject({ status: "resolved", source: "owner" })
  })

  test("a fully specified existing goal is asked NOTHING in continue", () => {
    const plan = planInterview({ requested: "continue", goal: full, hasLiveGoal: true })
    expect(plan.open).toEqual([])
    expect(topics(plan.resolved)).toEqual([...INTERVIEW_TOPICS])
    expect(plan.optional).toEqual([])
    expect(plan.notApplicable).toEqual([])
    expect(plan.resolved.every((s) => s.source === "contract")).toBe(true)
  })

  test("a partially specified goal is asked only the decisions it does not answer", () => {
    const plan = planInterview({ requested: "continue", goal: partial })
    // Answered by the contract: outcome, done-when (2), scope/non-goal.
    expect(topics(plan.resolved)).toEqual(["outcome", "done-when", "scope"])
    // Missing and required: evidence. Missing but recommended: oracles,
    // invariants, escalation. Opt-in only: budget, autonomy. No live goal:
    // priority does not apply.
    expect(topics(plan.open)).toEqual(["evidence", "oracles", "invariants", "escalation"])
    expect(topics(plan.optional)).toEqual(["budget", "autonomy"])
    expect(topics(plan.notApplicable)).toEqual(["priority"])
    expect(plan.directive).toContain("never re-ask what the contract already answers")
  })

  test("the skip table is exactly the contract's answers (partial vs full)", () => {
    const asked = (goal: GoalAnswers) => topics(planInterview({ requested: "continue", goal }).open)
    expect(asked(full)).toEqual([])
    expect(asked(partial)).toEqual(["evidence", "oracles", "invariants", "escalation"])
    expect(asked({ ...partial, evidence: "host" })).toEqual(["oracles", "invariants", "escalation"])
    expect(asked({ ...partial, evidence: "host", protect: ["oracle.txt"] })).toEqual(["invariants", "escalation"])
    expect(asked({ ...partial, evidence: "host", protect: ["oracle.txt"], invariants: 1 })).toEqual(["escalation"])
    expect(asked({ ...partial, evidence: "host", protect: ["oracle.txt"], invariants: 1, escalation: ["ask"] })).toEqual([])
  })

  test("optimize reopens only the topics the owner's change touches", () => {
    const plan = planInterview({
      requested: "optimize",
      goal: full,
      change: { text: "also export XML", topics: ["done-when"] },
      hasLiveGoal: true,
    })
    expect(plan).toMatchObject({ mode: "optimize", action: "stage-amendment", allowed: true })
    expect(plan.target).toEqual({ slug: "login-timeout", status: "paused", runId: "run-1", lock })
    expect(topics(plan.open)).toEqual(["done-when"])
    expect(topics(plan.resolved)).toHaveLength(INTERVIEW_TOPICS.length - 1)
    expect(plan.directive).toContain("goal_propose_amendment")
    expect(plan.directive).toContain(`expectedLock:"${lock}"`)
    expect(plan.directive).toContain("byte-identical")
  })

  test("an optimize with no change reopens nothing: the contract's answers stand", () => {
    const plan = planInterview({ requested: "optimize", goal: full, change: { text: "share the goal with CI" } })
    expect(plan.open).toEqual([])
    expect(plan.action).toBe("stage-amendment")
  })

  test("optimizing a draft edits the draft — there is no run to amend", () => {
    const plan = planInterview({ requested: "optimize", goal: partial })
    expect(plan).toMatchObject({ mode: "optimize", action: "edit-draft", allowed: true })
    expect(plan.target).toEqual({ slug: "login-timeout", status: "draft", lock })
    expect(plan.target!.runId).toBeUndefined()
    expect(plan.directive).toContain("draft with no run")
  })

  test("optimize with nothing to optimize is refused, not turned into a new goal", () => {
    const plan = planInterview({ requested: "optimize", intent: INTENT, outcome: OUTCOME })
    expect(plan).toMatchObject({ mode: "optimize", action: "refused", allowed: false })
    expect(plan.directive.startsWith("Refused:")).toBe(true)
  })

  test("contradictions reopen an answered decision", () => {
    const plan = planInterview({ requested: "continue", goal: full, contradicts: ["scope"] })
    expect(topics(plan.open)).toEqual(["scope"])
    expect(plan.open[0]!.because).toContain("contradicts")
  })

  test("contract problems reopen their topic and unmappable problems are reported", () => {
    const plan = planInterview({
      requested: "continue",
      goal: { ...full, issues: ["criteria[0]: C1 has no check", "id: id does not match the directory"] },
    })
    expect(topics(plan.open)).toEqual(["done-when"])
    expect(plan.contractIssues).toEqual(["id: id does not match the directory"])
  })

  test("priority is a question only when another goal is live", () => {
    const base: GoalAnswers = { ...full, priority: undefined }
    expect(topics(planInterview({ requested: "continue", goal: base, hasLiveGoal: true }).open)).toEqual(["priority"])
    expect(topics(planInterview({ requested: "continue", goal: base, hasLiveGoal: false }).notApplicable)).toEqual(["priority"])
  })

  test("a requested new goal for covered work carries the refusal into the plan", () => {
    const plan = planInterview({
      requested: "new",
      intent: INTENT,
      outcome: OUTCOME,
      triage: triageKickoff(candidates, [existing({ status: "waiting" })]),
    })
    expect(plan).toMatchObject({ mode: "continue", action: "refused", allowed: false, duplicateRefused: true })
    expect(plan.target!.runId).toBe("run-1")
  })

  test("the mode is deterministic and every mode shares the one topic bank", () => {
    const plans: Array<[InterviewMode, ReturnType<typeof planInterview>]> = [
      ["new", planInterview({ intent: INTENT })],
      ["continue", planInterview({ requested: "continue", goal: partial })],
      ["optimize", planInterview({ requested: "optimize", goal: full, change: { topics: ["outcome"] } })],
    ]
    const seen = new Set<string>()
    for (const [mode, plan] of plans) {
      expect(plan.mode).toBe(mode)
      for (const state of [...plan.open, ...plan.resolved, ...plan.optional, ...plan.notApplicable]) seen.add(state.topic)
    }
    expect([...seen].sort()).toEqual([...INTERVIEW_TOPICS].sort())
    expect(planInterview({ requested: "continue", goal: partial })).toEqual(planInterview({ requested: "continue", goal: partial }))
  })

  test("a consolidate target is amendable when its triage entry carries a run", () => {
    const triage = triageKickoff(candidates, [existing({ status: "running" }), existing({ slug: "slow-login", status: "waiting", runId: "run-2", lock: otherLock })])
    const plan = planInterview({ requested: "optimize", triage })
    expect(plan.action).toBe("stage-amendment")
    expect(plan.targets).toHaveLength(2)
  })
})
