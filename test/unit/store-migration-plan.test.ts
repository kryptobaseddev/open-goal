import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { parseContract } from "../../src/contract/parse"
import { initialRun, type RunState } from "../../src/engine/state"
import { Store } from "../../src/engine/store"
import { StoreMigrationError, planStoreMigration } from "../../src/engine/store-migration"
import { CANONICAL_GOALS_REL, LEGACY_GOALS_REL, resolveStoreRoots } from "../../src/engine/store-root"

// The migration dry run is READ ONLY. These cases prove the plan lists every
// goal, reports what it cannot move, and leaves the project byte-identical.

const scratch = mkdtempSync(join(tmpdir(), "ocg-store-migration-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const project = (name: string) => {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

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
const contract = (slug: string) => parseContract(contractText(slug), { slug }).contract!

function addGoal(store: Store, slug: string, options: { status?: RunState["status"]; archived?: boolean; unreadable?: boolean; extra?: string; withRun?: boolean } = {}) {
  const dir = options.archived ? store.archivedPath(slug) : store.dir(slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "goal.yaml"), contractText(slug))
  if (options.extra) writeFileSync(join(dir, "note.txt"), options.extra)
  if (options.unreadable) {
    writeFileSync(join(dir, "run.json"), "{ not json")
    return
  }
  if (options.withRun === false) return
  const parsed = parseContract(contractText(slug), { slug })
  const run = initialRun(contract(slug), { sessionID: `ses_${slug}`, runId: `r_${slug}`, lock: parsed.lock, now: 1000 })
  run.status = options.status ?? "running"
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`)
}

/** Every file under `dir`, relative path + size + content hash. */
function snapshot(dir: string, base = dir): Array<{ path: string; bytes: number; sha256: string }> {
  if (!existsSync(dir)) return []
  const out: Array<{ path: string; bytes: number; sha256: string }> = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...snapshot(abs, base))
      continue
    }
    const bytes = statSync(abs).size
    out.push({ path: relative(base, abs), bytes, sha256: createHash("sha256").update(readFileSync(abs)).digest("hex") })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

describe("planning a migration", () => {
  test("lists every live and archived goal and writes nothing", () => {
    const root = project("dry-run")
    const store = new Store(root)
    addGoal(store, "finished", { status: "complete" })
    addGoal(store, "old", { status: "complete", archived: true })
    addGoal(store, "draft")
    const before = snapshot(root)
    const target = resolveStoreRoots(root, { goalsDir: CANONICAL_GOALS_REL })

    const plan = planStoreMigration(store, target)

    expect(plan).toMatchObject({ schemaVersion: 1, dryRun: true, writes: 0 })
    expect(plan.source).toEqual({ layout: "legacy-opencode", goals: LEGACY_GOALS_REL, archive: ".opencode/goals-archive" })
    expect(plan.target).toEqual({ layout: "cleo", goals: CANONICAL_GOALS_REL, archive: ".cleo/goals-archive" })
    expect(plan.goals.map((g) => `${g.archived ? "archive" : "live"}:${g.slug}`).sort()).toEqual(["archive:old", "live:draft", "live:finished"])
    expect(plan.goals.find((g) => g.slug === "old")!.to).toBe(join(root, ".cleo", "goals-archive", "old"))
    expect(plan.goals.find((g) => g.slug === "finished")!.to).toBe(join(root, ".cleo", "goals", "finished"))
    expect(existsSync(join(root, ".cleo"))).toBe(false)
    expect(snapshot(root)).toEqual(before)
  })

  test("a live run is reported, never moved", () => {
    const root = project("live-run")
    const store = new Store(root)
    addGoal(store, "running", { status: "waiting" })
    const plan = planStoreMigration(store, resolveStoreRoots(root, { goalsDir: CANONICAL_GOALS_REL }))
    expect(plan.goals[0]).toMatchObject({ slug: "running", status: "waiting", migratable: false })
    expect(plan.goals[0]!.reason).toContain("finish, stop or abort")
    expect(plan.totals).toEqual({ goals: 1, bytes: plan.goals[0]!.bytes, migratable: 0 })
  })

  test("a contract-only goal has no run and is still movable", () => {
    const root = project("draft")
    const store = new Store(root)
    addGoal(store, "draft", { withRun: false })
    const plan = planStoreMigration(store, resolveStoreRoots(root, { goalsDir: CANONICAL_GOALS_REL }))
    expect(plan.goals[0]).toMatchObject({ slug: "draft", status: "draft", migratable: true })
  })

  test("an unreadable run blocks its own goal", () => {
    const root = project("unreadable")
    const store = new Store(root)
    addGoal(store, "broken", { unreadable: true })
    const plan = planStoreMigration(store, resolveStoreRoots(root, { goalsDir: CANONICAL_GOALS_REL }))
    expect(plan.goals[0]).toMatchObject({ slug: "broken", status: "unknown", migratable: false })
    expect(plan.goals[0]!.reason).toContain("unreadable")
  })

  test("counts files and bytes and keeps the digest stable across plans", () => {
    const root = project("bytes")
    const store = new Store(root)
    addGoal(store, "finished", { status: "complete", extra: "0123456789" })
    const target = resolveStoreRoots(root, { goalsDir: CANONICAL_GOALS_REL })
    const first = planStoreMigration(store, target)
    const second = planStoreMigration(store, target)
    const goal = first.goals[0]!
    const onDisk = snapshot(store.dir("finished"))
    expect(goal.files).toBe(onDisk.length)
    expect(goal.bytes).toBe(onDisk.reduce((sum, f) => sum + f.bytes, 0))
    expect(goal.digest).toBe(second.goals[0]!.digest)
    expect(first.totals).toEqual({ goals: 1, bytes: goal.bytes, migratable: 1 })
  })

  test("a target that already holds the slug is a reported conflict", () => {
    const root = project("conflict")
    const store = new Store(root)
    addGoal(store, "finished", { status: "complete" })
    const target = resolveStoreRoots(root, { goalsDir: CANONICAL_GOALS_REL })
    mkdirSync(join(target.goals, "finished"), { recursive: true })
    writeFileSync(join(target.goals, "finished", "goal.yaml"), "different bytes\n")
    const plan = planStoreMigration(store, target)
    expect(plan.goals[0]).toMatchObject({ slug: "finished", migratable: false })
    expect(plan.conflicts).toEqual([{ slug: "finished", archived: false, reason: "the target already holds this slug with different bytes" }])
  })

  test("identical bytes already at the target say so instead of copying twice", () => {
    const root = project("identical")
    const store = new Store(root)
    addGoal(store, "finished", { status: "complete" })
    const target = resolveStoreRoots(root, { goalsDir: CANONICAL_GOALS_REL })
    mkdirSync(join(target.goals, "finished"), { recursive: true })
    for (const name of ["goal.yaml", "run.json"]) writeFileSync(join(target.goals, "finished", name), readFileSync(join(store.dir("finished"), name)))
    const plan = planStoreMigration(store, target)
    expect(plan.conflicts[0]!.reason).toContain("identical bytes")
  })
})

describe("a migration refuses unsafe geometry", () => {
  test("the same store is not a migration", () => {
    const root = project("same")
    const store = new Store(root, resolveStoreRoots(root, { goalsDir: CANONICAL_GOALS_REL }))
    expect(() => planStoreMigration(store, resolveStoreRoots(root, { goalsDir: CANONICAL_GOALS_REL }))).toThrow(StoreMigrationError)
  })

  test("a target inside the source is refused", () => {
    const root = project("overlap")
    const source = new Store(root, resolveStoreRoots(root, { goalsDir: CANONICAL_GOALS_REL }))
    const target = resolveStoreRoots(root, { goalsDir: ".cleo/goals/nested" })
    expect(() => planStoreMigration(source, target)).toThrow(/overlap/)
  })
})
