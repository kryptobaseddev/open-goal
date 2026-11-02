import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { parseContract } from "../../src/contract/parse"
import { initialRun, type RunState } from "../../src/engine/state"
import { Store } from "../../src/engine/store"
import { executeStoreMigration, planStoreMigration, StoreMigrationError } from "../../src/engine/store-migration"
import { CANONICAL_GOALS_REL, LEGACY_GOALS_REL, resolveStoreRoots } from "../../src/engine/store-root"

// T150 C4 — the opt-in move. The dry run writes nothing; the confirmed move
// copies every migratable goal byte for byte into the active store and keeps the
// legacy folder as the archive. A live run is never relocated.

const scratch = mkdtempSync(join(tmpdir(), "ocg-store-move-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const contractText = (slug: string) => `schema: goal/v1
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
`

function addGoal(store: Store, slug: string, options: { status?: RunState["status"]; archived?: boolean } = {}) {
  const dir = options.archived ? store.archivedPath(slug) : store.dir(slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "goal.yaml"), contractText(slug))
  writeFileSync(join(dir, "notes.md"), `# ${slug}\n`)
  if (options.status === undefined) return
  const parsed = parseContract(contractText(slug), { slug })
  const run = initialRun(parsed.contract!, { sessionID: `ses_${slug}`, runId: `r_${slug}`, lock: parsed.lock, now: 1000 })
  run.status = options.status
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`)
  writeFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ t: 1, type: "note" })}\n`)
}

/** Every file under a directory: relative path → sha256, sorted. */
function snapshot(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {}
  const out: Record<string, string> = {}
  const visit = (abs: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) out[relative(dir, child)] = createHash("sha256").update(readFileSync(child)).digest("hex")
    }
  }
  visit(dir)
  return out
}

function project(name: string) {
  const root = join(scratch, name)
  mkdirSync(root, { recursive: true })
  const source = new Store(root, resolveStoreRoots(root, { goalsDir: LEGACY_GOALS_REL }))
  addGoal(source, "done", { status: "complete" })
  addGoal(source, "draft")
  addGoal(source, "live", { status: "waiting" })
  addGoal(source, "old", { status: "complete", archived: true })
  return { root, source, target: resolveStoreRoots(root) }
}

describe("the opt-in store move", () => {
  test("the dry run lists every goal and writes nothing", () => {
    const { root, source, target } = project("dry")
    const before = snapshot(root)
    const plan = planStoreMigration(source, target)
    expect(plan).toMatchObject({ schemaVersion: 1, dryRun: true, writes: 0 })
    expect(plan.goals.map((g) => `${g.archived ? "archive" : "live"}:${g.slug}`).sort()).toEqual([
      "archive:old",
      "live:done",
      "live:draft",
      "live:live",
    ])
    expect(plan.goals.find((g) => g.slug === "live")!.migratable).toBe(false)
    expect(snapshot(root)).toEqual(before)
    expect(existsSync(join(root, CANONICAL_GOALS_REL))).toBe(false)
  })

  test("a move without confirmation is refused and writes nothing", () => {
    const { root, source, target } = project("refused")
    const before = snapshot(root)
    expect(() => executeStoreMigration(source, target)).toThrow(StoreMigrationError)
    expect(snapshot(root)).toEqual(before)
  })

  test("the confirmed move preserves every byte and keeps the legacy copy", () => {
    const { root, source, target } = project("move")
    const legacyBefore = snapshot(join(root, LEGACY_GOALS_REL))
    const result = executeStoreMigration(source, target, { confirm: true })
    expect(result.dryRun).toBe(false)
    expect(result.legacyRetained).toBe(true)
    expect(result.moved.map((g) => `${g.archived ? "archive" : "live"}:${g.slug}`).sort()).toEqual(["archive:old", "live:done", "live:draft"])
    expect(result.skipped.map((g) => g.slug)).toEqual(["live"])
    expect(result.skipped[0]!.reason).toContain("finish, stop or abort")

    // every moved byte is identical at the target
    for (const moved of result.moved) {
      expect(snapshot(moved.from)).toEqual(snapshot(moved.to))
      expect(statSync(moved.from).isDirectory()).toBe(true)
    }
    // and the legacy copy is untouched
    expect(snapshot(join(root, LEGACY_GOALS_REL))).toEqual(legacyBefore)
    // the live run was not copied
    expect(existsSync(join(root, CANONICAL_GOALS_REL, "live"))).toBe(false)
  })
})
