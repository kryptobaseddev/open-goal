import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildHandoff } from "../../src/engine/handoff"
import { CANONICAL_GOALS_REL, LEGACY_GOALS_REL, resolveStoreRoots, type StoreRoots } from "../../src/engine/store-root"
import type { GoalView } from "../../src/rpc"
import { goalHelp } from "../../src/server/help"
import { cardCompactLines, cardExpandedLines, dialogDigest } from "../../src/tui/dashboard"
import { bannerText, goalFolder } from "../../src/tui/format"

// T187 — every surface names the store THIS project resolved.
//
// The help text, the TUI terminal copy and the launch handoff used to hardcode
// `.opencode/goals`, which told an owner (and a fresh session) to look in the
// wrong folder once the canonical store became the default. These cases take
// the path from `resolveStoreRoots` — canonical by default, the legacy path
// when pinned, a custom root when configured — and never from a literal.

const scratch = mkdtempSync(join(tmpdir(), "ocg-store-surfaces-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let n = 0
function project(config?: { goalsDir: string }): StoreRoots {
  const root = join(scratch, `project-${++n}`)
  mkdirSync(root, { recursive: true })
  if (config) {
    mkdirSync(join(root, ".cleo"), { recursive: true })
    writeFileSync(join(root, ".cleo", "goal-store.json"), JSON.stringify(config))
  }
  return resolveStoreRoots(root)
}

const helpFor = (roots: StoreRoots) =>
  goalHelp({
    version: "test",
    goalsRel: roots.goalsRel,
    archiveRel: roots.archiveRel,
    legacyGoalsRel: roots.legacy.goalsRel,
    legacyArchiveRel: roots.legacy.archiveRel,
  })

const viewAt = (roots: StoreRoots, status = "complete"): GoalView =>
  ({
    slug: "demo",
    title: "Demo goal",
    outcome: "something observable",
    status,
    runId: "r1",
    store: { goalsRel: roots.goalsRel, archiveRel: roots.archiveRel },
    turn: 1,
    timeline: [],
    activeMs: 0,
    activeSince: null,
    usage: { tokens: 0, cost: 0 },
    budget: [],
    budgetRatio: 0,
    criteria: [],
    steps: [],
    awaitingUser: false,
    amendments: 0,
    flags: 0,
    updatedAt: 1,
  }) as unknown as GoalView

describe("the default project names the canonical store", () => {
  const roots = project()

  test("resolution is canonical and the legacy store stays readable", () => {
    expect(roots.goalsRel).toBe(CANONICAL_GOALS_REL)
    expect(roots.archiveRel).toBe(".cleo/goals-archive")
    expect(roots.legacy.goalsRel).toBe(LEGACY_GOALS_REL)
  })

  test("help's storage layout and guard name .cleo/goals, and label the legacy path", () => {
    const text = helpFor(roots)
    expect(text).toContain(".cleo/goals/<slug>/goal.yaml")
    expect(text).toContain(".cleo/goals/<slug>/run.json")
    expect(text).toContain(".cleo/goals/<slug>/evidence/<runId>/")
    expect(text).toContain(".cleo/goals-archive/<slug>/")
    expect(text).toContain("Never edit `.cleo/goals/**`")
    // the legacy path is named ONLY as the readable legacy store
    expect(text).toContain("— the readable legacy store")
  })

  test("the terminal card, card panel and banner name .cleo/goals/<slug>/", () => {
    const view = viewAt(roots)
    expect(bannerText(view)!.text).toContain(".cleo/goals/demo/")
    expect(cardCompactLines(view, 1, 80).map((l) => l.text).join("\n")).toContain(".cleo/goals/demo/")
    expect(cardExpandedLines(view, 1, 80).map((l) => l.text).join("\n")).toContain(".cleo/goals/demo/")
    expect(dialogDigest("title", Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"), 4, 40, view.store)).toContain(".cleo/goals/ evidence")
  })

  test("the handoff's not-a-contract line names the resolved store", () => {
    const doc = buildHandoff({
      slug: "next",
      title: "Next",
      fromSessionID: "ses_a",
      toSessionID: "ses_b",
      store: { goalsRel: roots.goalsRel },
      repo: { dirty: [] },
      now: 1,
    })
    expect(doc.markdown).toContain("only .cleo/goals/<slug>/goal.yaml is locked")
  })
})

describe("a project pinned to the legacy store says so verbatim", () => {
  const roots = project({ goalsDir: LEGACY_GOALS_REL })

  test("resolution honours the pin", () => {
    expect(roots.goalsRel).toBe(LEGACY_GOALS_REL)
    expect(roots.layout).toBe("legacy-opencode")
    expect(roots.explicit).toBe(true)
  })

  test("help names .opencode/goals as the store, with no duplicate legacy line", () => {
    const text = helpFor(roots)
    expect(text).toContain(".opencode/goals/<slug>/goal.yaml")
    expect(text).toContain("Never edit `.opencode/goals/**`")
    expect(text).not.toContain("readable legacy store")
  })

  test("the terminal copy and handoff use the pinned path", () => {
    const view = viewAt(roots)
    expect(bannerText(view)!.text).toContain(".opencode/goals/demo/")
    expect(buildHandoff({ slug: "next", title: "Next", fromSessionID: "a", toSessionID: "b", store: { goalsRel: roots.goalsRel }, repo: { dirty: [] }, now: 1 }).markdown)
      .toContain("only .opencode/goals/<slug>/goal.yaml is locked")
  })
})

describe("a custom configured root flows through unchanged", () => {
  const roots = project({ goalsDir: ".state/goals" })

  test("help and the TUI copy show the configured directory", () => {
    expect(roots.goalsRel).toBe(".state/goals")
    expect(roots.archiveRel).toBe(".state/goals-archive")
    const text = helpFor(roots)
    expect(text).toContain(".state/goals/<slug>/goal.yaml")
    expect(text).toContain(".state/goals-archive/<slug>/")
    expect(bannerText(viewAt(roots))!.text).toContain(".state/goals/demo/")
  })
})

describe("a view without resolved paths invents none", () => {
  const view = { ...viewAt(project()), store: undefined }

  test("the copy falls back to plain words, never a guessed .opencode path", () => {
    const text = bannerText(view)!.text
    expect(text).toContain("the goal folder")
    expect(text).not.toContain(".opencode/goals")
    expect(text).not.toContain(".cleo/goals")
    expect(goalFolder(undefined, "demo")).toBe("the goal folder")
    expect(dialogDigest("t", Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n"), 4, 40)).toContain("the goal folder evidence")
  })
})
