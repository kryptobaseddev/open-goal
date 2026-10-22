import { describe, expect, test } from "bun:test"
import { continuationTail, decide, type LoopLimits, type LoopSignals } from "../../src/engine/loop"
import { initialRun, type RunState } from "../../src/engine/state"
import { parseContract } from "../../src/contract/parse"

// v0.6.0 - the pure loop decision. Every case the OpenCode adapter can take is
// pinned here, so the extraction can be shown to be behaviour-preserving and the
// `ocg tick` entry point can reuse the same decisions under another harness.

const contract = parseContract(
  `schema: goal/v1\nid: demo\ntitle: demo\nintent:\n  verbatim: "x"\noutcome: y\nnon_goals: [z]\ncriteria:\n  - id: C1\n    statement: s\n    check: {kind: file, path: f}\n`,
).contract!

const limits: LoopLimits = { blockerRepeats: 3, stallTurns: 4, recoveryAt: 2, backstopTurns: 40 }

function state(over: Partial<RunState> = {}): RunState {
  const base = initialRun(contract, { sessionID: "ses_demo", runId: "r1", lock: "a".repeat(64), now: 1_000 })
  return { ...base, ...over, counters: { noProgress: 0, failures: 0, ...(over.counters ?? {}) } }
}

const signals = (over: Partial<LoopSignals> = {}): LoopSignals => ({
  turn: "succeeded",
  changed: false,
  progressRecorded: false,
  stepsChanged: false,
  activeStalled: false,
  stallReason: "stalled: no change the host could see for 4 turns",
  onStall: "pause",
  budgetRatio: 0,
  backstop: false,
  cooldownMs: 3_000,
  ...over,
})

describe("the pure loop decision (v0.6.0)", () => {
  test("a failed or interrupted turn is not this decision's business", () => {
    expect(decide(state({ turn: 3 }), signals({ turn: "failed" }), limits)).toEqual({ kind: "none" })
    expect(decide(state({ turn: 3 }), signals({ turn: "interrupted" }), limits)).toEqual({ kind: "none" })
  })

  test("only a running run continues; a waiting run continues only because it claimed", () => {
    expect(decide(state({ status: "paused", turn: 3 }), signals(), limits)).toEqual({ kind: "none" })
    expect(decide(state({ status: "complete", turn: 3 }), signals(), limits)).toEqual({ kind: "none" })
    expect(decide(state({ status: "waiting", turn: 3 }), signals(), limits)).toEqual({ kind: "none" })
    // ...but a WAITING run that claimed is verified
    const claim = { at: 1, turn: 3, summary: "done", evidence: { C1: "yes" } }
    expect(decide(state({ status: "waiting", turn: 3, claim }), signals(), limits)).toEqual({ kind: "verify" })
  })

  test("a claim is verified before anything else", () => {
    const claim = { at: 1, turn: 3, summary: "done", evidence: {} }
    expect(decide(state({ turn: 3, claim }), signals({ pending: "continue" }), limits)).toEqual({ kind: "verify" })
  })

  test("turn 0 admits the kickoff", () => {
    expect(decide(state({ turn: 0 }), signals(), limits)).toEqual({ kind: "admit", tail: "kickoff" })
  })

  test("a finished wrap-up turn stops the run for the owner", () => {
    expect(decide(state({ turn: 5, wrapup: true }), signals({ pending: "wrapup" }), limits)).toEqual({
      kind: "stop",
      status: "budget_limited",
      code: "wrapup",
      reason: "budget used; wrap-up turn done",
    })
  })

  test("a repeated blocker stops the run for the owner", () => {
    const blocker = { key: "missing-key", count: 3, reason: "no stripe key", needs: "credential" as const, lastTurn: 4 }
    const action = decide(state({ turn: 5, blocker }), signals(), limits)
    expect(action).toMatchObject({ kind: "stop", status: "blocked", code: "blocked" })
    expect((action as { reason: string }).reason).toContain("missing-key")
    // below the threshold it keeps going
    expect(decide(state({ turn: 5, blocker: { ...blocker, count: 2 } }), signals(), limits)).toMatchObject({ kind: "schedule", tail: "continue" })
  })

  test("the budget admits ONE wrap-up turn, then stops", () => {
    expect(decide(state({ turn: 9, wrapup: false }), signals({ budgetRatio: 1 }), limits)).toEqual({ kind: "admit", tail: "wrapup" })
    expect(decide(state({ turn: 9, wrapup: true }), signals({ budgetRatio: 1.2 }), limits)).toEqual({
      kind: "stop",
      status: "budget_limited",
      code: "budget",
      reason: "budget used",
    })
  })

  test("the backstop has its own status and names the missing budget", () => {
    expect(decide(state({ turn: 40, wrapup: false }), signals({ backstop: true }), limits)).toEqual({ kind: "admit", tail: "wrapup" })
    const action = decide(state({ turn: 41, wrapup: true }), signals({ backstop: true }), limits)
    expect(action).toMatchObject({ kind: "stop", status: "backstop_limited", code: "backstop" })
    expect((action as { reason: string }).reason).toContain("backstop of 40 turns")
    expect((action as { reason: string }).reason).toContain("no contract budget set")
  })

  test("a stalled-but-active run continues under the owner's on_stall policy, and pauses otherwise", () => {
    const stalled = state({ turn: 6, counters: { noProgress: 4, failures: 0 } })
    expect(decide(stalled, signals({ activeStalled: true, onStall: "continue" }), limits)).toEqual({ kind: "schedule", tail: "continue", delayMs: 3_000 })
    const paused = decide(stalled, signals({ activeStalled: true, onStall: "pause" }), limits)
    expect(paused).toMatchObject({ kind: "stop", status: "paused", code: "stalled" })
    expect((paused as { reason: string }).reason).toContain("no change the host could see")
    // an idle run stops even under the continue policy
    expect(decide(stalled, signals({ activeStalled: false, onStall: "continue" }), limits)).toMatchObject({ kind: "stop", status: "paused" })
  })

  test("a future wait schedules the continuation at its deadline", () => {
    const action = decide(state({ turn: 6, wait: { until: 50_000, reason: "waiting for CI" } }), signals({ now: 40_000 }), limits)
    expect(action).toEqual({ kind: "schedule", tail: "continue", delayMs: 10_000, waiting: { reason: "waiting for CI" } })
    // an expired wait falls through to an ordinary continuation
    expect(decide(state({ turn: 6, wait: { until: 30_000, reason: "old" } }), signals({ now: 40_000 }), limits)).toMatchObject({ kind: "schedule", delayMs: 3_000 })
  })

  test("the ordinary case continues, and switches to recovery once progress has been missing long enough", () => {
    expect(decide(state({ turn: 6 }), signals(), limits)).toEqual({ kind: "schedule", tail: "continue", delayMs: 3_000 })
    expect(decide(state({ turn: 6, counters: { noProgress: 2, failures: 0 } }), signals(), limits)).toEqual({ kind: "schedule", tail: "recovery", delayMs: 3_000 })
  })

  test("continuationTail names the continuation for admitting/scheduling actions and null otherwise", () => {
    expect(continuationTail({ kind: "admit", tail: "kickoff" })).toBe("kickoff")
    expect(continuationTail({ kind: "schedule", tail: "recovery", delayMs: 1 })).toBe("recovery")
    expect(continuationTail({ kind: "verify" })).toBeNull()
    expect(continuationTail({ kind: "none" })).toBeNull()
    expect(continuationTail({ kind: "stop", status: "paused", code: "stalled", reason: "r" })).toBeNull()
  })

  test("decide is pure: it never mutates the state it is given", () => {
    const before = state({ turn: 0 })
    const snapshot = JSON.stringify(before)
    decide(before, signals(), limits)
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})
