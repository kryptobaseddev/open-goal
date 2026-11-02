import { describe, expect, test } from "bun:test"
import { DEFAULT_OVERLAP, describeTriageTarget, overlapScore, triageKickoff, type TriageGoal } from "../../src/engine/kickoff-triage"

// T167 — kickoff triage is pure: the same candidate and inventory always
// produce the same continue/repair/consolidate/new decision, target and reason.

const candidate = {
  title: "Login no longer times out",
  intent: "make the login stop timing out on slow networks",
  outcome: "the login request completes in under two seconds",
}

const lock = "a".repeat(64)

const goal = (over: Partial<TriageGoal> = {}): TriageGoal => ({
  slug: "login-timeout",
  title: "Login no longer times out",
  status: "draft",
  intent: candidate.intent,
  outcome: candidate.outcome,
  lock,
  ...over,
})

describe("kickoff triage (T167)", () => {
  test("an empty inventory is new: nothing to continue, repair or consolidate", () => {
    const result = triageKickoff(candidate, [])
    expect(result).toMatchObject({ decision: "new", targets: [] })
    expect(result.target).toBeUndefined()
    expect(result.reason).toContain("not a duplicate")
  })

  test("a valid existing draft routes to continue with its slug and lock, and no invented run", () => {
    const result = triageKickoff(candidate, [goal()])
    expect(result.decision).toBe("continue")
    expect(result.target).toEqual({ slug: "login-timeout", status: "draft", lock })
    expect(result.target!.runId).toBeUndefined()
    expect(result.reason).toContain("no run yet")
    expect(result.reason).toContain(lock)
  })

  test("a live run of the same work routes to continue with the exact goal/run/lock", () => {
    const result = triageKickoff(candidate, [goal({ status: "running", runId: "run-1" })])
    expect(result.decision).toBe("continue")
    expect(result.target).toEqual({ slug: "login-timeout", runId: "run-1", lock, status: "running" })
    expect(result.reason).toContain("run-1")
  })

  test("paused and blocked runs route to repair, naming the stopped run", () => {
    for (const status of ["paused", "blocked", "needs_review", "budget_limited", "backstop_limited"]) {
      const result = triageKickoff(candidate, [goal({ status, runId: `run-${status}` })])
      expect(result.decision).toBe("repair")
      expect(result.target).toMatchObject({ slug: "login-timeout", runId: `run-${status}`, lock, status })
      expect(result.reason).toContain(status)
    }
  })

  test("a divergent or invalid live goal is repaired even while its run is active", () => {
    const result = triageKickoff(candidate, [goal({ status: "running", runId: "run-1", valid: false, issues: ["Disk contract differs from the locked generation"] })])
    expect(result.decision).toBe("repair")
    expect(result.reason).toContain("Disk contract differs from the locked generation")
  })

  test("two overlapping live/draft goals route to consolidate with every affected target", () => {
    const result = triageKickoff(candidate, [
      goal({ slug: "login-timeout", status: "running", runId: "run-1" }),
      goal({ slug: "slow-login", status: "paused", runId: "run-2" }),
    ])
    expect(result.decision).toBe("consolidate")
    expect(result.targets.map((t) => t.slug)).toEqual(["login-timeout", "slow-login"])
    expect(result.target!.slug).toBe("login-timeout")
    expect(result.reason).toContain("Consolidate them")
    expect(result.reason).toContain("run-2")
  })

  test("a distinct goal is new; shared scaffolding alone is below the threshold", () => {
    const other = goal({ slug: "checkout-latency", title: "Checkout p95 under 250ms", intent: "make checkout faster", outcome: "checkout p95 is under 250ms" })
    expect(triageKickoff(candidate, [other])).toMatchObject({ decision: "new", targets: [] })
  })

  test("archived and finished generations never block a new attempt", () => {
    const archived = triageKickoff(candidate, [goal({ archived: true, status: "complete" })])
    expect(archived.decision).toBe("new")
    for (const status of ["complete", "failed", "aborted", "superseded"])
      expect(triageKickoff(candidate, [goal({ status })]).decision).toBe("new")
    const finished = triageKickoff(candidate, [goal({ status: "complete" })])
    expect(finished.reason).toContain("finished work does not block")
  })

  test("the candidate's own folder is never a duplicate of itself", () => {
    const result = triageKickoff({ ...candidate, slug: "login-timeout" }, [goal({ status: "paused", runId: "run-1" })])
    expect(result).toMatchObject({ decision: "new", targets: [] })
  })

  test("an explicit supersedes pointer is a replacement, not a duplicate", () => {
    const result = triageKickoff({ ...candidate, supersedes: "login-timeout@aaaaaa" }, [goal({ status: "running", runId: "run-1" })])
    expect(result.decision).toBe("new")
  })

  test("starting a named goal ignores other drafts, but admitting a new goal surfaces them", () => {
    const draft = goal({ status: "draft" })
    expect(triageKickoff(candidate, [draft])).toMatchObject({ decision: "continue" })
    expect(triageKickoff(candidate, [draft], { includeDrafts: false })).toMatchObject({ decision: "new", targets: [] })
    // A started run still blocks even when drafts are ignored.
    expect(triageKickoff(candidate, [goal({ status: "paused", runId: "run-1" })], { includeDrafts: false })).toMatchObject({ decision: "repair" })
  })

  test("an unreadable draft falls back to the title, and an invalid one needs repair", () => {
    const unreadable = goal({ intent: undefined, outcome: undefined })
    expect(triageKickoff(candidate, [unreadable]).decision).toBe("continue")
    const invalid = goal({ intent: undefined, outcome: undefined, valid: false, issues: ["Contract could not be read"] })
    expect(triageKickoff(candidate, [invalid])).toMatchObject({ decision: "repair", target: { slug: "login-timeout" } })
  })

  test("overlap is intent-or-outcome and deterministic", () => {
    expect(overlapScore(candidate, goal())).toBe(1)
    expect(overlapScore(candidate, goal({ intent: "unrelated work", outcome: candidate.outcome }))).toBe(1)
    expect(overlapScore(candidate, goal({ intent: "unrelated work", outcome: "unrelated result" }))).toBe(0)
    const first = triageKickoff(candidate, [goal()])
    const second = triageKickoff(candidate, [goal()])
    expect(second).toEqual(first)
    expect(DEFAULT_OVERLAP).toBe(0.6)
  })

  test("describeTriageTarget names the slug, run and lock a refusal must carry", () => {
    expect(describeTriageTarget({ slug: "demo", status: "draft", lock })).toContain("no run yet")
    expect(describeTriageTarget({ slug: "demo", status: "blocked", runId: "run-9", lock })).toBe(`"demo" (run run-9, lock ${lock}, status blocked)`)
  })
})
