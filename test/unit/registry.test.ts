import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Registry } from "../../src/engine/registry"

// T026 — the derived machine-level goal registry (council 20261003T162655Z-800c52ca):
// update-driven and scan-driven content must be identical for the same
// on-disk truth, the index lists goals across projects, and it never holds
// anything the .opencode/goals/ folders do not.
//
// D5/hardening: every test gets its OWN temporary registry file. The old shared
// `ocgoal-registry-test-${process.pid}.json` path was the suspected flake (Bun
// workers share a pid), so no run can observe or overwrite another run's file.
// The suite is run with `--rerun-each 20` by the goal's C5 check.

const runJson = (slug: string, status: string, updatedAt: number, title = slug) =>
  JSON.stringify({ version: 1, slug, title, status, runId: "r-" + slug, lock: "lock-" + slug, updatedAt })

function projectWithGoals(name: string, goals: Array<[string, string, number]>) {
  const root = mkdtempSync(join(tmpdir(), `ocgoal-reg-${name}-`))
  cleanup.push(root)
  for (const [slug, status, at] of goals) {
    const dir = join(root, ".opencode", "goals", slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "goal.yaml"), `schema: goal/v1\nid: ${slug}\n`)
    writeFileSync(join(dir, "run.json"), runJson(slug, status, at))
  }
  return root
}

const cleanup: string[] = []
afterAll(() => {
  for (const p of cleanup) rmSync(p, { recursive: true, force: true })
})

/** A registry file that belongs to one test only. */
function freshRegistry(): { registry: Registry; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ocgoal-registry-"))
  cleanup.push(dir)
  const path = join(dir, "registry.json")
  return { registry: new Registry(path), path }
}

describe("goal registry (T026)", () => {
  test("updates on transitions, skips no-op writes, and lists across projects", () => {
    const { registry } = freshRegistry()
    const a = projectWithGoals("a", [["alpha", "running", 1000]])
    const b = projectWithGoals("b", [["beta", "complete", 2000]])

    expect(registry.update(a, "alpha", { title: "alpha", status: "running", runId: "r-alpha", lock: "lock-alpha", updatedAt: 1000 })).toBe(true)
    expect(registry.update(b, "beta", { title: "beta", status: "complete", runId: "r-beta", lock: "lock-beta", updatedAt: 2000 })).toBe(true)
    // a transition refreshes the entry — including archive flags (T032)
    expect(registry.update(a, "alpha", { title: "alpha", status: "paused", runId: "r-alpha", lock: "lock-alpha", updatedAt: 3000 })).toBe(true)
    expect(registry.update(a, "alpha", { title: "alpha", status: "paused", runId: "r-alpha", lock: "lock-alpha", archived: true, updatedAt: 4000 })).toBe(true)
    expect(registry.read().projects[a]!.goals["alpha"]!.archived).toBe(true)
    registry.update(a, "alpha", { title: "alpha", status: "paused", runId: "r-alpha", lock: "lock-alpha", updatedAt: 5000 })
    expect(registry.read().projects[a]!.goals["alpha"]!.archived).toBeUndefined()
    registry.update(a, "alpha", { title: "alpha", status: "paused", runId: "r-alpha", lock: "lock-alpha", archived: true, updatedAt: 6000 })
    // an unchanged update does not rewrite the file
    const before = JSON.stringify(registry.read())
    expect(registry.update(a, "alpha", { title: "alpha", status: "paused", runId: "r-alpha", lock: "lock-alpha", archived: true, updatedAt: 6000 })).toBe(false)
    expect(JSON.stringify(registry.read())).toBe(before)

    const list = registry.list()
    // Classify by the actual root, never by a random temp-suffix heuristic: an
    // mkdtemp path can end in "b", and that was the one-off CI flake.
    expect(list.map((g) => `${g.project === a ? "alpha" : g.project === b ? "beta" : "?"}:${g.status}`).sort()).toEqual(["alpha:paused", "beta:complete"])
    expect(list).toHaveLength(2)
    expect(new Set(list.map((g) => g.project)).size).toBe(2)
  })

  test("rebuild-by-scan reproduces the update-driven index exactly (parity)", () => {
    const { registry } = freshRegistry()
    const a = projectWithGoals("parity-a", [["one", "complete", 1000], ["two", "aborted", 1100]])
    const b = projectWithGoals("parity-b", [["three", "running", 1200]])

    // drive the index through updates
    registry.update(a, "one", { title: "one", status: "complete", runId: "r-one", lock: "lock-one", updatedAt: 1000 })
    registry.update(a, "two", { title: "two", status: "aborted", runId: "r-two", lock: "lock-two", updatedAt: 1100 })
    registry.update(b, "three", { title: "three", status: "running", runId: "r-three", lock: "lock-three", updatedAt: 1200 })
    const driven = JSON.parse(JSON.stringify(registry.read()))

    // wipe and rebuild purely by scanning the same roots
    rmSync(registry.path, { force: true })
    expect(registry.rebuild([a, b])).toBe(true)
    const rebuilt = JSON.parse(JSON.stringify(registry.read()))
    expect(rebuilt).toEqual(driven)

    // rebuilding again is a no-op
    expect(registry.rebuild([a, b])).toBe(false)
  })

  test("a goal folder with an unreadable run.json indexes as a draft; removal prunes empty projects", () => {
    const { registry } = freshRegistry()
    const root = mkdtempSync(join(tmpdir(), "ocgoal-reg-draft-"))
    cleanup.push(root)
    const dir = join(root, ".opencode", "goals", "drafty")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "goal.yaml"), "schema: goal/v1\nid: drafty\n")

    expect(registry.rebuild([root])).toBe(true)
    const entry = registry.read().projects[root]!.goals["drafty"]!
    expect(entry.status).toBe("draft")

    registry.update(root, "drafty", { title: "drafty", status: "running", updatedAt: 1 })
    expect(registry.remove(root, "drafty")).toBe(true)
    expect(registry.read().projects[root]).toBeUndefined()
    expect(registry.list()).toHaveLength(0)
  })

  test("two runs never share a registry file (each instance writes only its own)", () => {
    const first = freshRegistry()
    const second = freshRegistry()
    expect(first.path).not.toBe(second.path)
    const a = projectWithGoals("isolation-a", [["one", "running", 1000]])
    const b = projectWithGoals("isolation-b", [["two", "running", 1000]])
    // interleave rapid writes: the old flow used a pid+millisecond tmp name
    for (let i = 0; i < 50; i++) {
      first.registry.update(a, "one", { title: "one", status: "running", updatedAt: 1000 + i })
      second.registry.update(b, "two", { title: "two", status: "running", updatedAt: 1000 + i })
    }
    expect(first.registry.list().map((g) => g.slug)).toEqual(["one"])
    expect(second.registry.list().map((g) => g.slug)).toEqual(["two"])
  })
})
