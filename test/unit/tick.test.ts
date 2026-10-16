import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tick, type TickStore } from "../../src/engine/tick"
import { initialRun, type RunState } from "../../src/engine/state"
import { parseContract } from "../../src/contract/parse"
import { renderTailNote } from "../../src/contract/render"
import type { VerifyOutcome } from "../../src/verify/pipeline"

// v0.7.0 - the tick end to end: RECORD the turn, DECIDE, then act. These tests
// drive it over an injected store, so every recorded write and every ledger event
// is visible without booting a host.

const SLUG = "demo"
const GOAL = `schema: goal/v1\nid: ${SLUG}\ntitle: demo goal\nintent:\n  verbatim: "x"\noutcome: y\nnon_goals: [z]\ncriteria:\n  - id: C1\n    statement: s\n    check: {kind: file, path: proof.txt}\nplan:\n  - {id: S1, title: first, proves: [C1]}\n`
const contract = parseContract(GOAL, { slug: SLUG }).contract!

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

/** A real temp project so the `.opencode/goals` guard sees a goal project. */
function project(withGoalsDir = true): string {
  const root = mkdtempSync(join(tmpdir(), "ocg-tick-"))
  dirs.push(root)
  if (withGoalsDir) mkdirSync(join(root, ".opencode", "goals", SLUG), { recursive: true })
  return root
}

function run(over: Partial<RunState> = {}): RunState {
  const base = initialRun(contract, { sessionID: "ses_x", runId: "r1", lock: "a".repeat(64), now: 1 })
  return { ...base, turn: 3, status: "running", ...over, counters: { noProgress: 0, failures: 0, ...(over.counters ?? {}) } }
}

function storeOf(state?: RunState) {
  const runs = new Map<string, RunState>()
  const events: Array<Record<string, unknown> & { type: string }> = []
  const writes: number[] = []
  if (state) runs.set(state.slug, state)
  const store: TickStore = {
    slugs: () => [...runs.keys()],
    readRun: (slug) => runs.get(slug),
    writeRun: (s) => {
      runs.set(s.slug, { ...s })
      writes.push(s.turn)
    },
    readContract: (slug) => (runs.has(slug) ? { contract, text: GOAL } : undefined),
    ledger: (_slug, event) => void events.push(event),
    evidence: () => "evidence.json",
  }
  return { store, runs, events, writes }
}

const okOutcome = (passed: boolean): VerifyOutcome => ({ passed, needsHuman: [], integrity: [], results: [{ id: "C1", pass: passed, by: "host", detail: passed ? "proof.txt exists" : "proof.txt missing" }], lines: [passed ? "C1 pass" : "C1 fail: proof.txt missing"] })

describe("the ocg tick, recording the turn (v0.7.0)", () => {
  test("outside a goal project it prints NOTHING", async () => {
    const result = await tick({ root: project(false), store: storeOf().store })
    expect(result.stdout).toBe("")
    expect(result.log.join(" ")).toContain("no .opencode/goals")
  })

  test("with no live goal it prints NOTHING", async () => {
    const result = await tick({ root: project(), store: storeOf().store })
    expect(result.stdout).toBe("")
    expect(result.log.join(" ")).toContain("no live goal")
  })

  test("it RECORDS the turn before deciding, in the adapter's own shape", async () => {
    const state = run({ turn: 3 })
    const h = storeOf(state)
    let fingerprints = 0
    const result = await tick({ root: project(), store: h.store, fingerprint: () => (++fingerprints === 1 ? "fp-A" : "fp-B"), now: 10 })
    expect(state.turn).toBe(4) // incremented
    const turnEvent = h.events.find((e) => e.type === "turn")
    expect(turnEvent).toMatchObject({ turn: 4, kind: "tick", changed: true, progress: true, noProgress: 0 })
    expect(h.writes).toContain(4)
    expect(JSON.parse(result.stdout).decision).toBe("block")
  })

  test("a fingerprint move counts as progress; no move does not", async () => {
    const moving = run({ fingerprint: "fp-A" })
    const hm = storeOf(moving)
    await tick({ root: project(), store: hm.store, fingerprint: () => "fp-B", now: 10 })
    expect(hm.events.find((e) => e.type === "turn")).toMatchObject({ changed: true, progress: true, noProgress: 0 })

    const still = run({ fingerprint: "fp-A", counters: { noProgress: 2, failures: 0 } })
    const hs = storeOf(still)
    await tick({ root: project(), store: hs.store, fingerprint: () => "fp-A", now: 10 })
    expect(hs.events.find((e) => e.type === "turn")).toMatchObject({ changed: false, progress: false, noProgress: 3 })
  })

  test("the reason is the SAME continuation the adapter would send", async () => {
    const state = run({ turn: 3 })
    const h = storeOf(state)
    const result = await tick({ root: project(), store: h.store, fingerprint: () => undefined, now: 2_000 })
    expect(JSON.parse(result.stdout)).toEqual({ decision: "block", reason: renderTailNote(state, contract, "continue", 2_000) })
  })

  test("a CLAIM is verified, and a host-only pass COMPLETES the goal (nothing on stdout, the session may end)", async () => {
    const state = run({ turn: 4, claim: { at: 1, turn: 4, summary: "wrote proof.txt", evidence: { C1: "exists" } } })
    const h = storeOf(state)
    const result = await tick({ root: project(), store: h.store, fingerprint: () => "fp", now: 10, verify: async () => okOutcome(true) })
    expect(result.stdout).toBe("")
    expect(h.runs.get(SLUG)!.status).toBe("complete")
    expect(h.runs.get(SLUG)!.claim).toBeUndefined() // the claim is consumed
    expect(h.events.map((e) => e.type)).toContain("complete")
    expect(h.events.map((e) => e.type)).toContain("verify-start")
    expect(h.events.find((e) => e.type === "complete")).toMatchObject({ turn: state.turn })
  })

  test("a claim that does NOT pass keeps the run going and hands the agent the verdict", async () => {
    const state = run({ turn: 4, claim: { at: 1, turn: 4, summary: "I think so", evidence: {} } })
    const h = storeOf(state)
    const result = await tick({ root: project(), store: h.store, fingerprint: () => "fp", now: 10, verify: async () => okOutcome(false) })
    const parsed = JSON.parse(result.stdout)
    expect(parsed.decision).toBe("block")
    expect(parsed.reason).toContain("C1 fail")
    expect(h.runs.get(SLUG)!.status).toBe("running")
  })

  test("a claim with no verifier available HOLDS rather than pretending", async () => {
    const state = run({ turn: 4, claim: { at: 1, turn: 4, summary: "s", evidence: {} } })
    const result = await tick({ root: project(), store: storeOf(state).store, fingerprint: () => "fp", now: 10 })
    expect(JSON.parse(result.stdout)).toEqual({ final: false })
    expect(result.log.join(" ")).toContain("cannot verify")
  })

  test("a goal awaiting the owner HOLDS the session", async () => {
    const result = await tick({ root: project(), store: storeOf(run({ status: "paused" })).store, fingerprint: () => "fp", now: 10 })
    expect(JSON.parse(result.stdout)).toEqual({ final: false })
  })

  test("it says what it could NOT see, and degrades instead of inventing", async () => {
    const h = storeOf(run({ turn: 3 }))
    const result = await tick({ root: project(), store: h.store, fingerprint: () => undefined, now: 10 })
    const log = result.log.join("\n")
    expect(log).toContain("could not see the agent's tool calls and progress call (the harness passed no Stop payload)")
    // nothing was invented: progress stayed false and the counters advanced honestly
    expect(h.events.find((e) => e.type === "turn")).toMatchObject({ progress: false, noProgress: 1 })
  })
})
