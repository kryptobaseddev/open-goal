import { describe, expect, test } from "bun:test"
import { parseContract } from "../../src/contract/parse"
import { renderSystemBlock } from "../../src/contract/render"
import { acsByGateFromProves } from "../../src/engine/cleo-bridge"

// T171 C1 — the criterion → CLEO task map. A criterion declares the ACs its own
// evidence demonstrates (`proves: ["T171#AC2"]`), and the contract declares the
// hierarchy the work rolls into (`cleo.saga` / `cleo.epics` / `cleo.tasks`).
// Validation is the guarantee: a `proves:` that names an undeclared task is an
// error, not a silently-open AC.

const contract = (cleo: string, extra = "") => `schema: goal/v1
id: map
title: criterion map
intent:
  verbatim: "map criteria to tasks"
outcome: every criterion maps to the CLEO AC it proves
non_goals:
  - inventing a mapping by position
criteria:
  - id: C1
    statement: src/engine/cleo-rollup.ts exists
    check: {kind: file, path: src/engine/cleo-rollup.ts}
    proves: ["T171#AC1"]
  - id: C2
    statement: the rollup tests pass
    check: {kind: command, run: "bun test test/unit/cleo-rollup.test.ts"}
    proves: ["T171#AC2"]
${extra}cleo:
${cleo}`

const errors = (text: string) => parseContract(text).issues.filter((i) => i.level === "error")
const warnings = (text: string) => parseContract(text).issues.filter((i) => i.level === "warning").map((i) => `${i.path}: ${i.message}`)

describe("the criterion → CLEO task map (T171 C1)", () => {
  test("saga, epics and tasks parse, and each criterion keeps its exact proves: refs", () => {
    const result = parseContract(contract("  saga: T001\n  epics: [T166, T169]\n  tasks: [T171]\n"))
    expect(result.issues.filter((i) => i.level === "error")).toEqual([])
    expect(result.contract!.cleo).toEqual({ saga: "T001", epics: ["T166", "T169"], tasks: [{ id: "T171" }] })
    expect(result.contract!.criteria[0]!.proves).toEqual(["T171#AC1"])
    expect(result.contract!.criteria[1]!.proves).toEqual(["T171#AC2"])
  })

  test("a proves: ref to a task cleo.tasks does not declare is an ERROR (it could never be written)", () => {
    const bad = parseContract(contract("  tasks: [T999]\n"))
    const found = bad.issues.filter((i) => i.level === "error")
    expect(found.length).toBeGreaterThan(0)
    expect(found.map((i) => `${i.path}: ${i.message}`).join("\n")).toContain("T171#AC1 names T171, which cleo.tasks does not declare")
  })

  test("a proves: ref on a check that proves no gate is warned, and the ref is kept verbatim", () => {
    const extra = `  - id: C3
    statement: an independent verifier agrees
    check: {kind: verifier, ask: "is it mapped?"}
    proves: ["T171#AC3"]
`
    const result = parseContract(contract("  tasks: [T171]\n", extra))
    expect(result.issues.filter((i) => i.level === "error")).toEqual([])
    expect(warnings(contract("  tasks: [T171]\n", extra)).join("\n")).toContain("proves no CLEO gate")
    expect(result.contract!.criteria[2]!.proves).toEqual(["T171#AC3"])
  })

  test("a gate-provable criterion with no proves: is warned when the goal declares tasks", () => {
    const extra = `  - id: C3
    statement: src/engine/cleo-bridge.ts exists
    check: {kind: file, path: src/engine/cleo-bridge.ts}
`
    expect(warnings(contract("  tasks: [T171]\n", extra)).join("\n")).toContain("declares no CLEO AC")
    // with no CLEO block at all there is no warning: nothing to record
    expect(warnings(contract("  tasks: []\n", extra)).join("\n")).not.toContain("declares no CLEO AC")
  })

  test("saga/epic ids are validated and de-duplicated", () => {
    expect(errors(contract("  saga: not-an-id\n  tasks: [T171]\n")).map((i) => i.path)).toContain("cleo.saga")
    const badEpics = errors(contract("  epics: [T166, T166, nope]\n  tasks: [T171]\n"))
    expect(badEpics.map((i) => i.path)).toEqual(expect.arrayContaining(["cleo.epics[1]", "cleo.epics[2]"]))
  })

  test("the worker sees the criterion → task map in its own contract block", () => {
    const parsed = parseContract(contract("  saga: T001\n  epics: [T166]\n  tasks: [T171]\n"))
    const block = renderSystemBlock(parsed.contract!, parsed.lock)
    expect(block).toContain("CLEO saga T001 · epics T166 — tasks this goal serves")
    // per task: which criterion proves which AC — the reverse direction, derived
    // from the criteria, never assigned by position
    expect(block).toContain("T171 (C1→AC1, C2→AC2)")
    // and the criterion lines still state the binding
    expect(block).toContain("proves CLEO: T171#AC1")
  })

  test("the bridge cites exactly those ACs on the gate the criterion's own check proves", () => {
    const parsed = parseContract(contract("  tasks: [T171]\n"))
    const map = acsByGateFromProves(parsed.contract!.criteria, "T171")
    expect(map).toEqual({ implemented: ["AC1"], testsPassed: ["AC2"] })
  })
})
