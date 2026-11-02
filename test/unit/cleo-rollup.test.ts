import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleoRollupReport, cleoRollupSummary, proofTotals, readRollup, taskProof, type CleoRollupTargets } from "../../src/engine/cleo-rollup"
import type { CleoRun } from "../../src/engine/cleo-bridge"
import { goalStatus, statusRollupInput } from "../../src/cli/status"
import { parseContract } from "../../src/contract/parse"
import { initialRun } from "../../src/engine/state"
import { Store } from "../../src/engine/store"

// T171 C3 — the rollup is read-only and evidence-derived. These fixtures are the
// exact JSON shapes the real `cleo` CLI returned on 2026-11-02 (saga members,
// saga rollup, show, list --parent --full), trimmed to the fields the rollup uses.
// Nothing here writes, and a task's status is never inferred: it is copied.

const ok = (data: unknown) => ({ stdout: JSON.stringify({ success: true, data }), exit: 0 })

const task = (input: { id: string; title: string; status: string; gates: boolean[]; acceptance: string[]; satisfies?: string[] }) => ({
  id: input.id,
  title: input.title,
  status: input.status,
  acceptance: input.acceptance,
  verification: {
    passed: input.gates.every(Boolean),
    gates: { implemented: input.gates[0] ?? false, testsPassed: input.gates[1] ?? false, qaPassed: input.gates[2] ?? false },
    evidence: Object.fromEntries(
      ["implemented", "testsPassed", "qaPassed"].map((name, index) => [
        name,
        input.gates[index]
          ? {
              atoms: [
                { kind: "commit", sha: "abc" },
                ...(index === 0 ? (input.satisfies ?? []).map((alias) => ({ kind: "satisfies", targetTaskId: input.id, targetAcAlias: alias })) : []),
              ],
            }
          : {},
      ]),
    ),
  },
})

const TASKS = [
  task({ id: "T911", title: "Write the rollup", status: "done", gates: [true, true, true], acceptance: ["one", "two"], satisfies: ["AC1", "AC2"] }),
  task({ id: "T912", title: "Show it in status", status: "pending", gates: [false, false, false], acceptance: ["one", "two"] }),
]

function fakeCli(overrides: Record<string, { stdout: string; exit: number }> = {}): { run: CleoRun; calls: string[][] } {
  const calls: string[][] = []
  const run: CleoRun = async (argv) => {
    calls.push(argv)
    const key = argv.join(" ")
    if (overrides[key]) return overrides[key]!
    if (key === "saga members T900") return ok({ sagaId: "T900", members: [{ epicId: "T910" }], total: 1 })
    if (key === "saga rollup T900") return ok({ sagaId: "T900", total: 1, done: 0, active: 1, blocked: 0, pending: 0, completionPct: 0 })
    if (key === "show T900") return ok({ task: { id: "T900", title: "Evidence saga", status: "pending" } })
    if (key === "show T910") return ok({ task: { id: "T910", title: "Rollup epic", status: "pending" } })
    if (key === "list --parent T910 --full --limit 0") return ok({ tasks: TASKS, total: 2 })
    if (key === "show T920 --full") return ok({ tasks: [task({ id: "T920", title: "Loose task", status: "done", gates: [true, true, true], acceptance: ["only"], satisfies: ["AC1"] })], count: 1 })
    return { stdout: JSON.stringify({ success: false, error: { message: `unexpected cleo ${key}` } }), exit: 1 }
  }
  return { run, calls }
}

const TARGETS: CleoRollupTargets = { saga: "T900", epics: ["T910"], tasks: ["T911", "T912", "T920"] }

describe("the read-only CLEO evidence rollup (T171 C3)", () => {
  test("proven vs unproven is derived from evidence, not from status or a note", async () => {
    const { run } = fakeCli()
    const rollup = await readRollup(TARGETS, run, [
      { id: "C1", statement: "the rollup exists", status: "pass", essential: true, proves: ["T911#AC1"] },
    ])
    expect(rollup.unread).toEqual([])
    expect(rollup.saga).toMatchObject({ id: "T900", title: "Evidence saga", status: "pending", cleo: { total: 1, done: 0, completionPct: 0 } })
    expect(rollup.epics).toHaveLength(1)
    const [done, pending] = rollup.epics[0]!.tasks
    expect(done).toMatchObject({ id: "T911", status: "done", proven: true, evidenceAtoms: 5, acs: { total: 2, proven: 2, open: [] } })
    expect(pending).toMatchObject({ id: "T912", status: "pending", proven: false, unprovenGates: ["implemented", "testsPassed", "qaPassed"], acs: { total: 2, proven: 0, open: ["AC1", "AC2"] } })
    // a declared task outside the listed epic is still reported, from its own read
    expect(rollup.tasks.map((t) => t.id)).toEqual(["T920"])
    expect(rollup.totals).toEqual({ tasks: 3, proven: 2, unproven: 1, closed: 2, acs: { total: 5, proven: 3, unproven: 2 } })
    expect(rollup.epics[0]!.proof).toEqual({ tasks: 2, proven: 1, unproven: 1, closed: 1, acs: { total: 4, proven: 2, unproven: 2 } })
    // the goal half rides along verbatim
    expect(rollup.goal).toEqual([{ id: "C1", statement: "the rollup exists", status: "pass", essential: true, proves: ["T911#AC1"] }])
  })

  test("the report and the compact status summary name proof, open ACs and the criterion map", async () => {
    const { run } = fakeCli()
    const rollup = await readRollup(TARGETS, run, [{ id: "C1", statement: "the rollup exists", status: "pass", essential: true, proves: ["T911#AC1"] }])
    const report = cleoRollupReport(rollup)
    expect(report).toContain("read-only")
    expect(report).toContain("saga T900 Evidence saga (pending)")
    expect(report).toContain("epic T910 Rollup epic (pending) · 1/2 tasks proven")
    expect(report).toContain("✓ T911 Write the rollup (done)")
    expect(report).toContain("· T912 Show it in status (pending)")
    expect(report).toContain("open AC1, AC2")
    expect(report).toContain("goal criteria → CLEO ACs")
    expect(report).toContain("C1 the rollup exists → T911#AC1")
    expect(report).not.toContain("not read")
    const summary = cleoRollupSummary(rollup)
    expect(summary).toContain("CLEO rollup: saga T900 (pending)")
    expect(summary).toContain("epics: T910 1/2 proven")
    expect(summary.split("\n").length).toBeLessThanOrEqual(3)
  })

  test("a failed read is reported verbatim and its node is absent — never zero, never invented", async () => {
    const { run } = fakeCli({
      "saga members T900": { stdout: JSON.stringify({ success: false, error: { message: "saga T900 has no members" } }), exit: 1 },
      "saga rollup T900": { stdout: JSON.stringify({ success: false, error: { message: "saga T900 not found" } }), exit: 1 },
    })
    const rollup = await readRollup({ saga: "T900", epics: [], tasks: [] }, run)
    expect(rollup.epics).toEqual([])
    expect(rollup.saga).toMatchObject({ id: "T900", proof: { tasks: 0, proven: 0, unproven: 0 } })
    expect(rollup.saga?.cleo).toBeUndefined()
    expect(rollup.unread.join("\n")).toContain("saga T900 has no members")
    expect(rollup.unread.join("\n")).toContain("saga T900 not found")
    expect(cleoRollupSummary(rollup)).toContain("2 CLEO read(s) unavailable")
  })

  test("a done status with no satisfies atom is closed but NOT proven at AC level", () => {
    const proof = taskProof(task({ id: "T999", title: "typed only", status: "done", gates: [true, true, true], acceptance: ["one", "two"] }))
    expect(proof.proven).toBe(true) // every gate holds evidence
    expect(proof.status).toBe("done") // status is copied, not judged
    expect(proof.acs).toEqual({ total: 2, proven: 0, open: ["AC1", "AC2"] }) // no criterion link
  })

  test("an empty task set aggregates to zeros without a special case", () => {
    expect(proofTotals([])).toEqual({ tasks: 0, proven: 0, unproven: 0, closed: 0, acs: { total: 0, proven: 0, unproven: 0 } })
  })

  // T171 C3 — `cleo-goal status --json` carries the same read-only rollup, and
  // a goal whose contract has no CLEO scope keeps the exact old shape.

  test("status rollup input comes from the locked contract + run, and status carries it additively", () => {
    const root = mkdtempSync(join(tmpdir(), "ocgoal-rollup-status-"))
    try {
      const store = new Store(root)
      const text = `schema: goal/v1
id: demo
title: rollup goal
intent:
  verbatim: "x"
outcome: y
non_goals: [z]
criteria:
  - id: C1
    statement: the file exists
    check: {kind: file, path: f}
    proves: ["T171#AC1"]
cleo:
  saga: T001
  epics: [T166]
  tasks: [T171]
`
      mkdirSync(store.dir("demo"), { recursive: true })
      writeFileSync(store.contractPath("demo"), text)
      const parsed = parseContract(text, { slug: "demo" })
      store.writeRun(initialRun(parsed.contract!, { sessionID: "ses_x", runId: "r1", lock: parsed.lock, now: 1000 }))

      const input = statusRollupInput(store)!
      expect(input.targets).toEqual({ saga: "T001", epics: ["T166"], tasks: ["T171"] })
      expect(input.goal).toEqual([{ id: "C1", statement: "the file exists", status: "unknown", essential: true, proves: ["T171#AC1"] }])

      const rollup = {
        schemaVersion: 1 as const,
        source: "cleo-cli" as const,
        goal: input.goal,
        saga: null,
        epics: [],
        tasks: [],
        totals: proofTotals([]),
        unread: [],
      }
      expect(goalStatus(store, 2000).cleo).toBeUndefined() // additive: absent unless computed
      expect(goalStatus(store, 2000, { cleo: rollup }).cleo).toEqual(rollup)
      expect(goalStatus(store, 2000, { cleo: rollup }).schemaVersion).toBe(1)

      // no cleo block ⇒ no CLEO call is ever suggested
      writeFileSync(store.contractPath("demo"), text.replace(/cleo:\n(  .*\n)+/, ""))
      expect(statusRollupInput(store)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
