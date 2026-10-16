import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { REASON_CAP, tick } from "../../src/engine/tick"
import { initialRun, type RunState } from "../../src/engine/state"
import { parseContract } from "../../src/contract/parse"
import { renderTailNote } from "../../src/contract/render"

// v0.6.0 - the tick decision. CLEO's Stop dispatcher reads JSON ONLY from stdout,
// so every case here asserts on the exact stdout: the block+reason continuation,
// the final:false hold, or nothing at all.

const SLUG = "demo"
const GOAL = `schema: goal/v1\nid: ${SLUG}\ntitle: demo goal\nintent:\n  verbatim: "x"\noutcome: y\nnon_goals: [z]\ncriteria:\n  - id: C1\n    statement: s\n    check: {kind: file, path: f}\nplan:\n  - {id: S1, title: first, proves: [C1]}\n`

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const contract = parseContract(GOAL, { slug: SLUG }).contract!

/** A temp project with (or without) a goal folder. */
function project(run?: Partial<RunState> | "no-run"): string {
  const root = mkdtempSync(join(tmpdir(), "ocg-tick-"))
  dirs.push(root)
  if (run === undefined) return root // no .opencode/goals at all
  mkdirSync(join(root, ".opencode", "goals", SLUG), { recursive: true })
  writeFileSync(join(root, ".opencode", "goals", SLUG, "goal.yaml"), GOAL)
  if (run === "no-run") return root
  const base = initialRun(contract, { sessionID: "ses_x", runId: "r1", lock: "a".repeat(64), now: 1 })
  writeFileSync(join(root, ".opencode", "goals", SLUG, "run.json"), JSON.stringify({ ...base, ...run, counters: { noProgress: 0, failures: 0, ...(run.counters ?? {}) } }))
  return root
}

describe("the ocg tick decision (v0.6.0)", () => {
  test("outside a goal project it prints NOTHING and exits cleanly", () => {
    const result = tick({ root: project() })
    expect(result.stdout).toBe("")
    expect(result.log.join(" ")).toContain("no .opencode/goals")
  })

  test("with a goals folder but no run it prints NOTHING", () => {
    const result = tick({ root: project("no-run") })
    expect(result.stdout).toBe("")
    expect(result.log.join(" ")).toContain("no live goal")
  })

  test("a TERMINAL goal is not a live goal: it prints NOTHING", () => {
    for (const status of ["complete", "failed", "aborted", "superseded"] as const) {
      const result = tick({ root: project({ status, turn: 4 }) })
      expect(result.stdout).toBe("")
    }
  })

  test("a live running goal continues: block + the SAME continuation the adapter would send", () => {
    const state = { ...initialRun(contract, { sessionID: "ses_x", runId: "r1", lock: "a".repeat(64), now: 1 }), turn: 4, status: "running" as const }
    const result = tick({ root: project(state), now: 2_000 })
    const parsed = JSON.parse(result.stdout)
    expect(parsed.decision).toBe("block")
    // The reason is byte-identical to the adapter's continuation for the same tail.
    expect(parsed.reason).toBe(renderTailNote(state, contract, "continue", 2_000))
    expect(result.log.join(" ")).toContain("continuing with the continue continuation")
  })

  test("a goal awaiting the owner HOLDS the session: final false", () => {
    const paused = tick({ root: project({ status: "paused", turn: 4 }) })
    expect(JSON.parse(paused.stdout)).toEqual({ final: false })
    expect(paused.log.join(" ")).toContain("holding")
  })

  test("a repeated blocker HOLDS the session rather than asking for more work", () => {
    const blocker = { key: "missing-key", count: 3, reason: "no key", lastTurn: 4 }
    const result = tick({ root: project({ status: "running", turn: 5, blocker }) })
    expect(JSON.parse(result.stdout)).toEqual({ final: false })
    expect(result.log.join(" ")).toContain("blocked")
  })

  test("a stalled run HOLDS the session rather than asking for more work", () => {
    const result = tick({ root: project({ status: "running", turn: 9, counters: { noProgress: 3, failures: 0 } }) })
    expect(JSON.parse(result.stdout)).toEqual({ final: false })
    expect(result.log.join(" ")).toContain("holding")
  })

  test("a goal that used its CONTRACT budget holds the session (the owner must decide)", () => {
    const slack = parseContract(`${GOAL}\nbudget: {tokens: 1000}\n`, { slug: SLUG }).contract!
    const root = mkdtempSync(join(tmpdir(), "ocg-tick-"))
    dirs.push(root)
    mkdirSync(join(root, ".opencode", "goals", SLUG), { recursive: true })
    writeFileSync(join(root, ".opencode", "goals", SLUG, "goal.yaml"), `${GOAL}\nbudget: {tokens: 1000}\n`)
    const base = initialRun(slack, { sessionID: "ses_x", runId: "r1", lock: "a".repeat(64), now: 1 })
    writeFileSync(join(root, ".opencode", "goals", SLUG, "run.json"), JSON.stringify({ ...base, status: "running", turn: 9, wrapup: true, usage: { tokens: 5_000, cost: 0, baseTokens: null, baseCost: null } }))
    const result = tick({ root })
    expect(JSON.parse(result.stdout)).toEqual({ final: false })
  })

  test("the continuation reason is capped at CLEO's 4000 characters", () => {
    const state = { ...initialRun(contract, { sessionID: "ses_x", runId: "r1", lock: "a".repeat(64), now: 1 }), turn: 4, status: "running" as const, verdict: { passed: false, lines: Array.from({ length: 400 }, () => "x".repeat(40)), at: 1, turn: 4 } }
    const result = tick({ root: project(state) })
    const parsed = JSON.parse(result.stdout)
    expect(parsed.reason.length).toBeLessThanOrEqual(REASON_CAP)
    expect(parsed.decision).toBe("block")
  })
})
