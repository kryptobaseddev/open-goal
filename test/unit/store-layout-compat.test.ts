import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { goalStatus } from "../../src/cli/status"
import { parseContract } from "../../src/contract/parse"
import { projectInventory } from "../../src/engine/inventory"
import { initialRun } from "../../src/engine/state"
import { Store } from "../../src/engine/store"
import { resolveStoreRoots } from "../../src/engine/store-root"

// Existing projects keep the layout they already have. T150 flipped the DEFAULT
// to `.cleo/goals`; a project that already lives under `.opencode/goals` keeps
// those bytes by pinning the legacy path in `.cleo/goal-store.json` (or an
// explicit resolver option), and the default store reads them either way.
// These cases build a real legacy tree and prove the paths, status and archive
// behaviour do not change for it.

const scratch = mkdtempSync(join(tmpdir(), "ocg-store-compat-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const project = (name: string) => {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

const CONTRACT = `schema: goal/v1
id: demo
title: Demo goal
intent:
  verbatim: "x"
outcome: y
non_goals: [z]
criteria:
  - id: C1
    statement: the file exists
    check: {kind: file, path: f}
budget: {turns: 10}
`
const parse = (text: string, slug: string) => parseContract(text, { slug })

const LEGACY_PIN = { goalsDir: ".opencode/goals" } as const

function legacyProject(name: string) {
  const root = project(name)
  const store = new Store(root, resolveStoreRoots(root, { ...LEGACY_PIN }))
  mkdirSync(store.dir("demo"), { recursive: true })
  writeFileSync(store.contractPath("demo"), CONTRACT)
  const parsed = parse(CONTRACT, "demo")!
  const run = initialRun(parsed.contract!, { sessionID: "ses_x", runId: "r1", lock: parsed.lock, now: 1000 })
  run.turn = 2
  store.writeRun(run)
  return { root, store, run }
}

describe("an existing .opencode/goals project", () => {
  test("a project pinned to the legacy layout resolves exactly the paths it has always used", () => {
    const { root, store } = legacyProject("paths")
    expect(store.roots.layout).toBe("legacy-opencode")
    expect(store.roots.explicit).toBe(true)
    expect(store.goalsDir).toBe(join(root, ".opencode", "goals"))
    expect(store.archiveDir).toBe(join(root, ".opencode", "goals-archive"))
    expect(store.dir("demo")).toBe(join(root, ".opencode", "goals", "demo"))
    expect(store.contractPath("demo")).toBe(join(root, ".opencode", "goals", "demo", "goal.yaml"))
  })

  test("writes a run where the previous build wrote it", () => {
    const { root, store, run } = legacyProject("write")
    expect(existsSync(join(root, ".opencode", "goals", "demo", "run.json"))).toBe(true)
    expect(JSON.parse(readFileSync(join(root, ".opencode", "goals", "demo", "run.json"), "utf8"))).toMatchObject({ version: 1, slug: "demo", runId: run.runId })
  })

  test("a second reader (the CLI, the tick) sees the same run without OpenCode", () => {
    const { root, run } = legacyProject("reader")
    const reader = new Store(root, resolveStoreRoots(root, { ...LEGACY_PIN }))
    expect(reader.slugs()).toEqual(["demo"])
    expect(reader.readRun("demo")).toMatchObject({ runId: run.runId, status: "running", turn: 2 })
  })

  test("status still reports the live run from the locked contract", () => {
    const { store } = legacyProject("status")
    expect(goalStatus(store, 2000)).toMatchObject({
      schemaVersion: 1,
      goal: "demo",
      runId: "r1",
      title: "Demo goal",
      status: "running",
      proven: 0,
      total: 1,
    })
  })

  test("the project inventory still lists the goal", () => {
    const { store } = legacyProject("inventory")
    expect(projectInventory(store).map((g) => g.slug)).toEqual(["demo"])
  })

  test("ledger and evidence stay inside the goal folder", () => {
    const { root, store } = legacyProject("evidence")
    store.ledger("demo", { type: "note" })
    const file = store.evidence("demo", "r1", "check", { ok: true })
    expect(existsSync(join(root, ".opencode", "goals", "demo", "ledger.jsonl"))).toBe(true)
    expect(file).toBe(join(root, ".opencode", "goals", "demo", "evidence", "r1", "check.json"))
    expect(store.recent("demo", 5).map((e) => e.type)).toEqual(["note"])
  })

  test("archive still moves a finished goal into .opencode/goals-archive", () => {
    const { root, store } = legacyProject("archive")
    writeFileSync(join(root, "done.txt"), "x")
    store.archive("demo")
    expect(existsSync(join(root, ".opencode", "goals", "demo"))).toBe(false)
    expect(existsSync(join(root, ".opencode", "goals-archive", "demo", "goal.yaml"))).toBe(true)
    expect(store.archivedSlugs()).toEqual(["demo"])
    expect(store.readRun("demo", { archived: true })).toMatchObject({ runId: "r1" })

    mkdirSync(join(store.archiveDir, "older"), { recursive: true })
    writeFileSync(join(store.archiveDir, "older", "goal.yaml"), CONTRACT.replace("id: demo", "id: older"))
    expect(projectInventory(store).filter((g) => g.archived).map((g) => g.slug).sort()).toEqual(["demo", "older"])
  })

  test("the default store reads a legacy run but writes a new goal canonically", () => {
    const { root, run } = legacyProject("isolation")
    const canonical = new Store(root)
    // readable through the transition …
    expect(canonical.slugs()).toEqual(["demo"])
    expect(canonical.locate("demo")).toBe(join(root, ".opencode", "goals", "demo"))
    expect(canonical.readRun("demo")).toMatchObject({ runId: run.runId })
    // … and a brand-new slug is written where the default says
    const parsed = parse(CONTRACT.replace("id: demo", "id: fresh"), "fresh")!
    const fresh = initialRun(parsed.contract!, { sessionID: "ses_y", runId: "r2", lock: parsed.lock, now: 2000 })
    canonical.writeRun(fresh)
    expect(existsSync(join(root, ".cleo", "goals", "fresh", "run.json"))).toBe(true)
    expect(canonical.goalsDir).toBe(join(root, ".cleo", "goals"))
    expect(canonical.archiveDir).toBe(join(root, ".cleo", "goals-archive"))
  })
})
