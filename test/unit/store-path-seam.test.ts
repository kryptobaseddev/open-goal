import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CANONICAL_ARCHIVE_REL,
  CANONICAL_GOALS_REL,
  DEFAULT_RESOLVED_LAYOUT,
  DEFAULT_TARGET_LAYOUT,
  LEGACY_ARCHIVE_REL,
  LEGACY_GOALS_REL,
  STORE_CONFIG_REL,
  STORE_PROTOCOL_VERSION,
  StoreRootError,
  describeStore,
  resolveStoreRoots,
  storePathKind,
} from "../../src/engine/store-root"

// The store root is one resolved decision (T152), not a string repeated in the
// engine, the CLI, the tick and the guard. T150 flipped the default: with
// nothing configured the answer is the canonical `.cleo/goals`, a project may
// pin any root (including the legacy one) through `.cleo/goal-store.json`, and
// an invalid root refuses to resolve.

const scratch = mkdtempSync(join(tmpdir(), "ocg-store-root-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const project = (name: string) => {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe("the store root with nothing configured", () => {
  test("resolves the canonical layout by default", () => {
    const root = project("default")
    const roots = resolveStoreRoots(root)
    expect(roots.layout).toBe("cleo")
    expect(roots.layout).toBe(DEFAULT_RESOLVED_LAYOUT)
    expect(roots.explicit).toBe(false)
    expect(roots.protocolVersion).toBe(STORE_PROTOCOL_VERSION)
    expect(roots.goals).toBe(join(root, ".cleo", "goals"))
    expect(roots.archive).toBe(join(root, ".cleo", "goals-archive"))
    expect(roots.goalsRel).toBe(CANONICAL_GOALS_REL)
    expect(roots.archiveRel).toBe(CANONICAL_ARCHIVE_REL)
    expect(roots.legacy.goals).toBe(join(root, ".opencode", "goals"))
  })

  test("keeps the legacy paths addressable for reading during the transition", () => {
    const root = project("legacy-readable")
    const roots = resolveStoreRoots(root, { goalsDir: CANONICAL_GOALS_REL })
    expect(roots.legacy.goals).toBe(join(root, ".opencode", "goals"))
    expect(roots.legacy.archive).toBe(join(root, ".opencode", "goals-archive"))
    expect(roots.legacy.goalsRel).toBe(LEGACY_GOALS_REL)
    expect(roots.legacy.archiveRel).toBe(LEGACY_ARCHIVE_REL)
  })

  test("the default IS the canonical target after the flip", () => {
    expect(DEFAULT_TARGET_LAYOUT).toBe("cleo")
    expect(DEFAULT_RESOLVED_LAYOUT).toBe("cleo")
    expect(CANONICAL_GOALS_REL).toBe(".cleo/goals")
    expect(CANONICAL_ARCHIVE_REL).toBe(".cleo/goals-archive")
  })

  test("still resolves a relative project root to an absolute one", () => {
    const roots = resolveStoreRoots(".")
    expect(roots.goals).toBe(join(roots.root, ".cleo", "goals"))
    expect(roots.goals.startsWith("/")).toBe(true)
  })
})

describe("a configured store root", () => {
  test("resolves the canonical layout and its sibling archive", () => {
    const root = project("canonical")
    const roots = resolveStoreRoots(root, { goalsDir: CANONICAL_GOALS_REL })
    expect(roots.layout).toBe("cleo")
    expect(roots.explicit).toBe(true)
    expect(roots.goals).toBe(join(root, ".cleo", "goals"))
    expect(roots.archive).toBe(join(root, ".cleo", "goals-archive"))
    expect(roots.goalsRel).toBe(CANONICAL_GOALS_REL)
    expect(roots.archiveRel).toBe(CANONICAL_ARCHIVE_REL)
  })

  test("a custom root keeps its archive beside it", () => {
    const root = project("custom")
    const roots = resolveStoreRoots(root, { goalsDir: ".state/goals" })
    expect(roots.layout).toBe("cleo")
    expect(roots.goalsRel).toBe(".state/goals")
    expect(roots.archiveRel).toBe(".state/goals-archive")
  })

  test("an explicit archive wins over the sibling default", () => {
    const root = project("explicit-archive")
    const roots = resolveStoreRoots(root, { goalsDir: ".state/goals", archiveDir: ".state/done" })
    expect(roots.archive).toBe(join(root, ".state", "done"))
    expect(roots.archiveRel).toBe(".state/done")
  })

  test("a project may pin the legacy path through its own override file", () => {
    const root = project("pinned-legacy")
    mkdirSync(join(root, ".cleo"), { recursive: true })
    writeFileSync(join(root, STORE_CONFIG_REL), JSON.stringify({ goalsDir: LEGACY_GOALS_REL }))
    const roots = resolveStoreRoots(root)
    expect(roots.layout).toBe("legacy-opencode")
    expect(roots.goalsRel).toBe(LEGACY_GOALS_REL)
    expect(roots.explicit).toBe(true)
  })
})

describe("the project override file (.cleo/goal-store.json)", () => {
  const withConfig = (name: string, body: string) => {
    const root = project(name)
    mkdirSync(join(root, ".cleo"), { recursive: true })
    writeFileSync(join(root, STORE_CONFIG_REL), body)
    return root
  }

  test("selects a custom goals directory and its sibling archive", () => {
    const root = withConfig("config-custom", JSON.stringify({ goalsDir: ".state/goals" }))
    const roots = resolveStoreRoots(root)
    expect(roots.explicit).toBe(true)
    expect(roots.goalsRel).toBe(".state/goals")
    expect(roots.archiveRel).toBe(".state/goals-archive")
  })

  test("explicit options win over the file", () => {
    const root = withConfig("config-options", JSON.stringify({ goalsDir: ".state/goals" }))
    expect(resolveStoreRoots(root, { goalsDir: ".other/goals" }).goalsRel).toBe(".other/goals")
  })

  test("a malformed file fails closed", () => {
    expect(() => resolveStoreRoots(withConfig("config-bad-json", "{not json"))).toThrow(StoreRootError)
    expect(() => resolveStoreRoots(withConfig("config-array", "[]"))).toThrow(StoreRootError)
    expect(() => resolveStoreRoots(withConfig("config-unknown", JSON.stringify({ root: ".x" })))).toThrow(/unknown key/)
    expect(() => resolveStoreRoots(withConfig("config-type", JSON.stringify({ goalsDir: 7 })))).toThrow(StoreRootError)
  })
})

describe("an invalid root fails closed", () => {
  const bad: Array<[string, string]> = [
    ["empty", ""],
    ["whitespace", "   "],
    ["absolute", "/tmp/elsewhere/goals"],
    ["parent escape", "../outside/goals"],
    ["nested escape", ".cleo/../../outside"],
    ["the project root", "."],
    ["inside .git", ".git/goals"],
    ["inside node_modules", "node_modules/goals"],
    ["the CLEO state directory", ".cleo"],
    ["inside the legacy store", `${LEGACY_GOALS_REL}/nested`],
    ["an ancestor of the legacy store", ".opencode"],
  ]
  for (const [name, value] of bad)
    test(`refuses ${name}`, () => {
      const root = project(`bad-${name.replace(/[^a-z]+/gi, "-")}`)
      expect(() => resolveStoreRoots(root, { goalsDir: value })).toThrow(StoreRootError)
    })

  test("refuses a path that is a file", () => {
    const root = project("file-target")
    writeFileSync(join(root, "goals"), "not a directory")
    expect(() => resolveStoreRoots(root, { goalsDir: "goals" })).toThrow(StoreRootError)
  })

  test("refuses a symlink that resolves outside the project", () => {
    const root = project("symlink-escape")
    const outside = join(scratch, "outside-store")
    mkdirSync(outside, { recursive: true })
    symlinkSync(outside, join(root, "escape"))
    expect(() => resolveStoreRoots(root, { goalsDir: "escape/goals" })).toThrow(StoreRootError)
  })

  test("refuses an archive that contains the goals directory", () => {
    const root = project("archive-contains-goals")
    expect(() => resolveStoreRoots(root, { goalsDir: ".state/goals", archiveDir: ".state" })).toThrow(StoreRootError)
    expect(() => resolveStoreRoots(root, { goalsDir: ".state", archiveDir: ".state/goals" })).toThrow(StoreRootError)
  })
})

describe("path classification for the write guard", () => {
  test("covers the active store and the legacy one during the transition", () => {
    const root = project("classify")
    const roots = resolveStoreRoots(root, { goalsDir: CANONICAL_GOALS_REL })
    expect(storePathKind(roots, ".cleo/goals/demo")).toBe("active")
    expect(storePathKind(roots, ".cleo/goals/demo/run.json")).toBe("active")
    expect(storePathKind(roots, ".cleo/goals-archive/old/goal.yaml")).toBe("active-archive")
    expect(storePathKind(roots, ".opencode/goals/legacy")).toBe("legacy")
    expect(storePathKind(roots, ".opencode/goals-archive/legacy")).toBe("legacy-archive")
    expect(storePathKind(roots, "src/engine/store.ts")).toBeUndefined()
    expect(storePathKind(roots, ".cleo/goalz/demo")).toBeUndefined()
  })

  test("with the default root the canonical store is active and the legacy one stays classified", () => {
    const root = project("classify-default")
    const roots = resolveStoreRoots(root)
    expect(storePathKind(roots, ".cleo/goals/demo")).toBe("active")
    expect(storePathKind(roots, ".cleo/goals-archive/demo")).toBe("active-archive")
    expect(storePathKind(roots, ".opencode/goals/demo")).toBe("legacy")
    expect(storePathKind(roots, ".opencode/goals-archive/demo")).toBe("legacy-archive")
  })
})

describe("the store descriptor", () => {
  test("names the resolved layout and counts what lives there, without writing", () => {
    const root = project("descriptor")
    const roots = resolveStoreRoots(root, { goalsDir: CANONICAL_GOALS_REL })
    for (const slug of ["one", "two"]) {
      mkdirSync(join(roots.goals, slug), { recursive: true })
      writeFileSync(join(roots.goals, slug, "goal.yaml"), "schema: goal/v1\n")
    }
    mkdirSync(join(roots.archive, "old"), { recursive: true })
    writeFileSync(join(roots.archive, "old", "goal.yaml"), "schema: goal/v1\n")
    expect(describeStore(roots)).toMatchObject({
      protocolVersion: STORE_PROTOCOL_VERSION,
      layout: "cleo",
      explicit: true,
      goals: CANONICAL_GOALS_REL,
      archive: CANONICAL_ARCHIVE_REL,
      legacy: { goals: LEGACY_GOALS_REL, archive: LEGACY_ARCHIVE_REL },
      live: 2,
      archived: 1,
    })
  })

  test("an absent store reports zero, not an error", () => {
    const root = project("descriptor-empty")
    expect(describeStore(resolveStoreRoots(root))).toMatchObject({
      layout: "cleo",
      explicit: false,
      goals: CANONICAL_GOALS_REL,
      archive: CANONICAL_ARCHIVE_REL,
      legacy: { goals: LEGACY_GOALS_REL, archive: LEGACY_ARCHIVE_REL },
      live: 0,
      archived: 0,
    })
  })
})
