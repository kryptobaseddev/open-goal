import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseContract } from "../../src/contract/parse"
import { projectInventory } from "../../src/engine/inventory"
import { initialRun } from "../../src/engine/state"
import { Store } from "../../src/engine/store"

const yaml = (id: string) => `schema: goal/v1
id: ${id}
title: Goal ${id}
intent: {verbatim: prove the marker}
outcome: marker exists
non_goals: [other files]
criteria:
  - {id: C1, statement: marker exists, check: {kind: file, path: marker.txt}}
meta: {cleo_task: T078, relates: [another-goal]}
`

test("inventory keeps live/archive generations distinct and never rewrites archived history", () => {
  const root = mkdtempSync(join(tmpdir(), "ocgoal-inventory-"))
  try {
    const store = new Store(root)
    const original = yaml("demo"), parsed = parseContract(original)
    mkdirSync(store.archivedPath("demo"), { recursive: true })
    writeFileSync(join(store.archivedPath("demo"), "goal.yaml"), original)
    const old = initialRun(parsed.contract!, { sessionID: "ses_old", runId: "run_old", lock: parsed.lock, now: 1 })
    old.status = "complete"
    old.activeSince = null
    old.criteria.C1 = { status: "pass", by: "host", rejections: 0 }
    const history = JSON.stringify(old)
    writeFileSync(join(store.archivedPath("demo"), "run.json"), history)
    mkdirSync(store.dir("demo"), { recursive: true })
    writeFileSync(store.contractPath("demo"), original.replace("Goal demo", "New draft demo"))
    const rows = projectInventory(store)
    expect(rows).toHaveLength(2)
    const archive = rows.find((r) => r.archived)!, draft = rows.find((r) => !r.archived)!
    expect(archive.key).not.toBe(draft.key)
    expect(archive).toMatchObject({ title: old.title, status: "complete", terminal: true, attachable: false, proven: 1, total: 1 })
    expect(draft).toMatchObject({ title: "New draft demo", status: "draft", proven: 0, total: 1 })
    expect(archive.meta).toEqual({ cleo_task: "T078", relates: ["another-goal"] })
    expect((archive as any).parent).toBeUndefined()
    expect(readFileSync(join(store.archivedPath("demo"), "run.json"), "utf8")).toBe(history)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("unaccepted edits do not replace the locked generation's relationships or oracle inventory", () => {
  const root = mkdtempSync(join(tmpdir(), "ocgoal-inventory-lock-"))
  try {
    const store = new Store(root)
    const original = yaml("demo"), parsed = parseContract(original)
    const state = initialRun(parsed.contract!, { sessionID: "ses_owner", runId: "run_owner", lock: parsed.lock })
    state.status = "paused"
    store.writeRun(state)
    store.writeContractSnapshot(state.slug, state.runId, state.lock, original)
    writeFileSync(store.contractPath("demo"), original.replace("T078", "T999").replace("another-goal", "unaccepted-link"))
    const row = projectInventory(store, [state])[0]!
    expect(row.lock).toBe(state.lock)
    expect(row.meta).toEqual(parsed.contract!.meta)
    expect(row.issues).toContain("Disk contract differs from the locked generation")
    expect(row.valid).toBe(false)
    expect(row.attachable).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("invalid drafts and unreadable run records stay visible as explicit unknowns, not invented sessions or progress", () => {
  const root = mkdtempSync(join(tmpdir(), "ocgoal-inventory-invalid-"))
  try {
    const store = new Store(root)
    mkdirSync(store.dir("bad-draft"), { recursive: true })
    writeFileSync(store.contractPath("bad-draft"), "schema: bad\n")
    mkdirSync(store.dir("unknown-run"), { recursive: true })
    writeFileSync(store.contractPath("unknown-run"), yaml("unknown-run"))
    writeFileSync(join(store.dir("unknown-run"), "run.json"), "{torn")
    const rows = projectInventory(store)
    expect(rows).toHaveLength(2)
    const invalid = rows.find((r) => r.slug === "bad-draft")!
    expect(invalid).toMatchObject({ valid: false, status: "draft", proven: 0, total: 0 })
    expect(invalid.issues!.length).toBeGreaterThan(0)
    const unknown = rows.find((r) => r.slug === "unknown-run")!
    expect(unknown.status).toBe("unknown")
    expect(unknown.sessionState).toBe("unknown")
    expect(unknown.sessionID).toBeUndefined()
    expect(unknown.agent).toBeUndefined()
    expect(unknown.progress).toBeUndefined()
    expect(unknown.issues).toContain("Run state is unreadable; status/progress/session cannot be inferred")
    expect(readFileSync(join(store.dir("unknown-run"), "run.json"), "utf8")).toBe("{torn")
  } finally { rmSync(root, { recursive: true, force: true }) }
})
