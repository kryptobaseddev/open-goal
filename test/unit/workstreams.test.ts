import { describe, expect, test } from "bun:test"
import { parseContract } from "../../src/contract/parse"
import { aggregate, dispatchBrief, parseReturn, planWorkstreams, validateReturn, workstreamRows, type WorkstreamState } from "../../src/engine/workstreams"

// T169 — declared workstreams: one goal, several CLEO tasks, named workers.
// These tests hold the pure model to its two promises: the dispatch brief is
// bounded and names the worker the contract declared, and a return is believed
// only when it carries the evidence atoms the task asked for.

const GOAL = `schema: goal/v1
id: demo
title: demo goal
intent:
  verbatim: "x"
outcome: the engine reports T169 evidence
non_goals: [z]
criteria:
  - id: C1
    statement: proof.txt SHALL exist
    check: {kind: file, path: proof.txt}
cleo:
  tasks:
    - id: T169
      acs: {implemented: [AC1], testsPassed: [AC2]}
workstreams:
  - id: engine
    title: the engine work
    task: T169
    worker: builder@macbook
    done_when: T169 evidence is returned with atoms
  - id: docs
    title: the docs work
    task: T169
    worker: writer@macbook
    done_when: the note carries the new block
`

const contract = parseContract(GOAL, { slug: "demo" }).contract!

describe("declared workstreams (T169)", () => {
  test("a workstream maps to its CLEO task, ACs and gates", () => {
    const planned = planWorkstreams(contract)
    expect(planned.map((w) => ({ id: w.id, task: w.task, worker: w.worker, acs: w.acs, gates: w.gates }))).toEqual([
      { id: "engine", task: "T169", worker: "builder@macbook", acs: ["AC1", "AC2"], gates: ["implemented", "testsPassed"] },
      { id: "docs", task: "T169", worker: "writer@macbook", acs: ["AC1", "AC2"], gates: ["implemented", "testsPassed"] },
    ])
  })

  test("a contract without workstreams is unchanged", () => {
    const bare = parseContract(GOAL.replace(/workstreams:[\s\S]*$/, ""), { slug: "demo" }).contract!
    expect(bare.workstreams).toBeUndefined()
    expect(planWorkstreams(bare)).toEqual([])
    expect(workstreamRows(bare, undefined)).toEqual([])
  })

  test("the parser refuses a wildcard, an unlinked task, a duplicate id and a missing return", () => {
    const base = GOAL
    const issuesFor = (replacement: string) => parseContract(base.replace(/workstreams:[\s\S]*$/, replacement), { slug: "demo" }).issues
    expect(issuesFor('workstreams:\n  - {id: a, title: t, task: T169, worker: "*", done_when: d}\n').some((i) => /wildcard/.test(i.message))).toBe(true)
    expect(issuesFor('workstreams:\n  - {id: a, title: t, task: T999, worker: a@b, done_when: d}\n').some((i) => /cleo.tasks/.test(i.message))).toBe(true)
    expect(issuesFor('workstreams:\n  - {id: a, title: t, task: T169, worker: a@b, done_when: d}\n  - {id: a, title: u, task: T169, worker: c@d, done_when: e}\n').some((i) => /duplicate workstream id/.test(i.message))).toBe(true)
    expect(issuesFor('workstreams:\n  - {id: a, title: t, task: T169, worker: a@b}\n').some((i) => /done_when/.test(i.message))).toBe(true)
  })

  test("the brief names the task, the return and the atoms, and stays bounded", () => {
    const brief = dispatchBrief({ contract, workstream: planWorkstreams(contract)[0]! })
    expect(brief).toContain("workstream engine")
    expect(brief).toContain("CLEO task: T169")
    expect(brief).toContain("satisfies:T169#AC1")
    expect(brief).toContain("prose-only return is rejected")
    expect(brief.length).toBeLessThanOrEqual(1200)
  })

  test("a prose-only return is rejected by name", () => {
    const workstream = planWorkstreams(contract)[0]!
    const verdict = validateReturn(workstream, "All done, the engine looks great. T169 complete.")
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain("prose-only return for engine")
  })

  test("the atoms must prove the declared ACs and the declared gates", () => {
    const workstream = planWorkstreams(contract)[0]!
    const missingAc = validateReturn(workstream, "commit:abcdef123; files:src/a.ts,src/b.ts; satisfies:T169#AC1")
    expect(missingAc.ok).toBe(false)
    expect(missingAc.reason).toContain("AC2")
    const wrongTask = validateReturn(workstream, "commit:abcdef123; files:src/a.ts; satisfies:T170#AC1; satisfies:T170#AC2")
    expect(wrongTask.ok).toBe(false)
    expect(wrongTask.reason).toContain("AC1")
    const missingGate = validateReturn(workstream, "commit:abcdef123; files:src/a.ts; satisfies:T169#AC1; satisfies:T169#AC2")
    expect(missingGate.ok).toBe(false)
    expect(missingGate.reason).toContain("testsPassed")
  })

  test("a complete return is accepted and its atoms are kept", () => {
    const workstream = planWorkstreams(contract)[0]!
    const verdict = validateReturn(workstream, "commit:abcdef123\nfiles:src/a.ts,src/b.ts\ntest-run:.tmp/report.json\nsatisfies:T169#AC1 satisfies:T169#AC2")
    expect(verdict.ok).toBe(true)
    expect(verdict.atoms).toEqual(["commit:abcdef123", "files:src/a.ts,src/b.ts", "test-run:.tmp/report.json"])
    expect(parseReturn("satisfies:T169#AC1").satisfies).toEqual([{ task: "T169", ac: "AC1" }])
  })

  test("the aggregate is one status, and a workstream never invents a goal", () => {
    const states: Record<string, WorkstreamState> = {
      engine: { id: "engine", task: "T169", worker: "builder@macbook", status: "accepted", atoms: ["commit:abcdef123"] },
      docs: { id: "docs", task: "T169", worker: "writer@macbook", status: "rejected", reason: "prose-only" },
    }
    expect(aggregate(Object.values(states))).toEqual({ total: 2, accepted: 1, rejected: 1, pending: 0, proven: false })
    expect(workstreamRows(contract, states).map((row) => `${row.id}:${row.status}`)).toEqual(["engine:accepted", "docs:rejected"])
    expect(aggregate([])).toEqual({ total: 0, accepted: 0, rejected: 0, pending: 0, proven: false })
    expect(aggregate([{ id: "x", task: "T169", worker: "a@b", status: "pending" }])).toMatchObject({ pending: 1, proven: false })
  })
})
