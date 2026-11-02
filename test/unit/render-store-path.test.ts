import { describe, expect, test } from "bun:test"
import { parseContract } from "../../src/contract/parse"
import { renderSystemBlock, renderTailNote } from "../../src/contract/render"
import { initialRun } from "../../src/engine/state"

// T150 — the prompt text names the store the project actually uses.
//
// The system block used to hardcode `.opencode/goals` in two places (the
// contract-file line and the never-edit line), which would tell a worker to
// protect the wrong folder once the canonical store is the default. The block
// takes the resolved `goalsRel` now; the tail note's compaction reminder takes
// it too. These cases pin both, and pin that omitting the argument keeps the
// exact bytes older callers expect.

const GOAL = (slug: string) => `schema: goal/v1
id: ${slug}
title: ${slug} goal
intent:
  verbatim: "x"
outcome: y
non_goals: [z]
criteria:
  - id: C1
    statement: s
    check: {kind: file, path: f}
plan:
  - {id: S1, title: step, proves: [C1]}
`

const parsed = parseContract(GOAL("demo"), { slug: "demo" })
const contract = parsed.contract!
const lock = parsed.lock

describe("the rendered contract names the resolved store", () => {
  test("the system block points at the canonical store when that is the root", () => {
    const block = renderSystemBlock(contract, lock, ".cleo/goals")
    expect(block).toContain("Contract file: .cleo/goals/demo/goal.yaml")
    expect(block).toContain("anything under .cleo/goals/")
    expect(block).not.toContain(".opencode/goals")
  })

  test("a legacy or overridden root renders verbatim", () => {
    const legacy = renderSystemBlock(contract, lock, ".opencode/goals")
    expect(legacy).toContain("Contract file: .opencode/goals/demo/goal.yaml")
    const custom = renderSystemBlock(contract, lock, ".state/goals")
    expect(custom).toContain("Contract file: .state/goals/demo/goal.yaml")
    expect(custom).toContain("anything under .state/goals/")
    // the lock line is untouched: only the store path follows the resolver
    expect(custom).toContain(`lock="${lock.slice(0, 12)}"`)
  })

  test("omitting the argument keeps the pre-flip bytes", () => {
    expect(renderSystemBlock(contract, lock)).toBe(renderSystemBlock(contract, lock, ".opencode/goals"))
  })

  test("the block stays byte-stable for the same inputs", () => {
    expect(renderSystemBlock(contract, lock, ".cleo/goals")).toBe(renderSystemBlock(contract, lock, ".cleo/goals"))
  })
})

describe("the tail note's compaction reminder names the resolved store", () => {
  const state = { ...initialRun(contract, { sessionID: "ses_x", runId: "r1", lock, now: 1000 }), compacted: true }

  test("names the canonical store when that is the root", () => {
    const note = renderTailNote(state, contract, "continue", 2000, ".cleo/goals")
    expect(note).toContain("re-read .cleo/goals/demo/goal.yaml")
    expect(note).toContain("recent entries of .cleo/goals/demo/ledger.jsonl")
    expect(note).not.toContain(".opencode/goals")
  })

  test("omitting the argument keeps the pre-flip bytes", () => {
    expect(renderTailNote(state, contract, "continue", 2000)).toBe(renderTailNote(state, contract, "continue", 2000, ".opencode/goals"))
  })

  test("an un-compacted run has no reminder at all, whatever the store", () => {
    const fresh = { ...state, compacted: false }
    expect(renderTailNote(fresh, contract, "continue", 2000, ".cleo/goals")).not.toContain("re-read")
  })
})
