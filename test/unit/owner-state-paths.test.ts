import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OWNER_STATE_FILES, ownerStatePath, ownerStateReadPaths, ownerStateRel } from "../../src/engine/owner-state"
import { OwnerReviewStore, type ReviewRequest } from "../../src/engine/owner-reviews"
import { resolveStoreRoots } from "../../src/engine/store-root"

// T185 — the owner-state sidecars (decisions, launches, amendments, launch
// approvals) resolve through the store resolver instead of a hardcoded
// `.opencode/goals`. A pre-flip file stays readable; only the resolved file is
// ever written.

const scratch = mkdtempSync(join(tmpdir(), "ocg-owner-state-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const project = (name: string) => {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("the owner-state directory follows the resolved store", () => {
  test("a project with no legacy store writes to the canonical store", () => {
    const root = project("canonical")
    const roots = resolveStoreRoots(root)
    expect(ownerStateRel(roots)).toBe(".cleo/goals")
    expect(ownerStatePath(root, roots, ".owner-decisions.json")).toBe(join(root, ".cleo", "goals", ".owner-decisions.json"))
    expect(ownerStateReadPaths(root, roots, ".owner-decisions.json")).toEqual([
      join(root, ".cleo", "goals", ".owner-decisions.json"),
      join(root, ".opencode", "goals", ".owner-decisions.json"),
    ])
  })

  test("a project that still has the legacy store keeps its records beside it", () => {
    const root = project("pre-flip")
    mkdirSync(join(root, ".opencode", "goals", "demo"), { recursive: true })
    const roots = resolveStoreRoots(root)
    expect(ownerStateRel(roots)).toBe(".opencode/goals")
    expect(ownerStatePath(root, roots, ".owner-launches.json")).toBe(join(root, ".opencode", "goals", ".owner-launches.json"))
    // and the canonical root stays a readable source for a record written there
    expect(ownerStateReadPaths(root, roots, ".owner-launches.json")).toEqual([
      join(root, ".opencode", "goals", ".owner-launches.json"),
      join(root, ".cleo", "goals", ".owner-launches.json"),
    ])
  })

  test("a project pinned to .opencode/goals keeps its current location", () => {
    const root = project("pinned-legacy")
    mkdirSync(join(root, ".cleo"), { recursive: true })
    writeFileSync(join(root, ".cleo", "goal-store.json"), JSON.stringify({ goalsDir: ".opencode/goals" }))
    const roots = resolveStoreRoots(root)
    expect(roots.explicit).toBe(true)
    expect(ownerStateRel(roots)).toBe(".opencode/goals")
    expect(ownerStateReadPaths(root, roots, ".owner-amendments.json")).toEqual([join(root, ".opencode", "goals", ".owner-amendments.json")])
  })

  test("an explicit canonical pin wins even when a legacy store exists", () => {
    const root = project("pinned-canonical")
    mkdirSync(join(root, ".opencode", "goals"), { recursive: true })
    mkdirSync(join(root, ".cleo"), { recursive: true })
    writeFileSync(join(root, ".cleo", "goal-store.json"), JSON.stringify({ goalsDir: ".state/goals" }))
    const roots = resolveStoreRoots(root)
    expect(ownerStateRel(roots)).toBe(".state/goals")
    // the pre-flip file is still a read source, but never the write target
    expect(ownerStateReadPaths(root, roots, ".launch-approvals.json")).toEqual([
      join(root, ".state", "goals", ".launch-approvals.json"),
      join(root, ".opencode", "goals", ".launch-approvals.json"),
    ])
  })

  test("names every owner-state sidecar", () => {
    expect([...OWNER_STATE_FILES]).toEqual([".owner-decisions.json", ".owner-launches.json", ".owner-amendments.json", ".launch-approvals.json"])
  })
})

describe("owner-review reads merge the fallback and write only the primary", () => {
  const request = (id: string, sessionID: string): ReviewRequest => ({
    id, sessionID, slug: "demo", lock: "lock", title: id, question: `${id}?`,
    createdAt: 1, expiresAt: 9_999_999_999_999, issuerPID: 1, status: "pending",
  })

  test("a record that exists only in a fallback file is still visible", () => {
    const dir = project("fallback-only")
    const primary = join(dir, "primary.json"), fallback = join(dir, "fallback.json")
    writeFileSync(fallback, JSON.stringify({ version: 1, requests: { a: request("a", "s1") } }))
    const store = new OwnerReviewStore<ReviewRequest>(primary, [], [fallback])
    expect(store.all().map((p) => p.id)).toEqual(["a"])
  })

  test("the primary file wins on a duplicate id, and a mutation writes only it", () => {
    const dir = project("merge")
    const primary = join(dir, "primary.json"), fallback = join(dir, "fallback.json")
    writeFileSync(fallback, JSON.stringify({ version: 1, requests: { a: request("a", "pre-flip"), b: request("b", "pre-flip") } }))
    writeFileSync(primary, JSON.stringify({ version: 1, requests: { a: request("a", "post-flip") } }))
    const fallbackBefore = readFileSync(fallback, "utf8")
    const store = new OwnerReviewStore<ReviewRequest>(primary, [], [fallback])
    expect(store.all().map((p) => [p.id, p.sessionID])).toEqual([["a", "post-flip"], ["b", "pre-flip"]])

    store.update("b", { status: "rejected", result: "no" })
    expect(readFileSync(fallback, "utf8")).toBe(fallbackBefore)
    const written = JSON.parse(readFileSync(primary, "utf8"))
    expect(Object.keys(written.requests).sort()).toEqual(["a", "b"])
    expect(written.requests.b.status).toBe("rejected")
    // the migrated record is now in the primary file; the fallback is untouched
    expect(store.get("b")?.status).toBe("rejected")
  })

  test("an invalid fallback refuses consent rather than silently ignoring records", () => {
    const dir = project("invalid-fallback")
    const primary = join(dir, "primary.json"), fallback = join(dir, "fallback.json")
    writeFileSync(fallback, JSON.stringify({ version: 2, requests: {} }))
    const store = new OwnerReviewStore<ReviewRequest>(primary, [], [fallback])
    expect(() => store.all()).toThrow(/invalid; refusing consent/)
  })
})
