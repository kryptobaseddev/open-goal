import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveStoreRoots } from "../../src/engine/store-root"
import { fingerprint, storeExcludePaths } from "../../src/util/git"
import { runHostCheck } from "../../src/verify/pipeline"

// T182: goal state is not progress and goal state is not evidence. Before this
// fix the fingerprint excluded only `.opencode/goals`, so a run.json or ledger
// write under the canonical `.cleo/goals` moved the turn fingerprint — a
// goal-state-only turn looked like progress and could mask a stall. The
// evidence git-grep had the same hardcoded exclusion.
//
// These repos deliberately have NO `.cleo/.gitignore`: the exclusion has to
// work on what the resolver says, not on an ignore file the store happens to
// drop. One layout pinning its own root proves the set is resolved, not a
// string literal.

const scratch = mkdtempSync(join(tmpdir(), "ocgoal-fingerprint-store-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

/** A committed project: one tracked source file, plus an optional store config. */
const repo = (name: string, config?: { goalsDir?: string; archiveDir?: string }) => {
  const root = join(scratch, name)
  mkdirSync(root, { recursive: true })
  git(root, "init", "-q", "-b", "main")
  writeFileSync(join(root, "src.ts"), "export const value = 1\n")
  if (config) {
    mkdirSync(join(root, ".cleo"), { recursive: true })
    writeFileSync(join(root, ".cleo", "goal-store.json"), `${JSON.stringify(config)}\n`)
  }
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "init")
  return root
}

/** What a turn actually writes: contract, run state, ledger and an archive. */
const writeGoalState = (root: string, goalsRel: string, archiveRel: string, turn = 1) => {
  const folder = join(root, goalsRel, "demo")
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, "goal.yaml"), `schema: goal/v1\nid: demo\ntitle: t\nturn: ${turn}\n`)
  writeFileSync(join(folder, "run.json"), `${JSON.stringify({ turn, status: "running", fingerprint: "x".repeat(20) })}\n`)
  writeFileSync(join(folder, "ledger.jsonl"), `${JSON.stringify({ type: "turn", turn })}\n`, { flag: "a" })
  const archived = join(root, archiveRel, "old")
  mkdirSync(archived, { recursive: true })
  writeFileSync(join(archived, "goal.yaml"), `schema: goal/v1\nid: old\ntitle: old\n`)
}

describe("the progress fingerprint excludes every goal-store root", () => {
  test("a goal-state-only write under the canonical .cleo/goals does not move it", () => {
    const root = repo("canonical")
    const roots = resolveStoreRoots(root)
    expect(roots.goalsRel).toBe(".cleo/goals")

    const before = fingerprint(root)
    expect(before).toBeTruthy()

    writeGoalState(root, roots.goalsRel, roots.archiveRel, 1)
    expect(fingerprint(root)).toBe(before)

    // The next turn rewrites the same goal-state files; still not progress.
    writeGoalState(root, roots.goalsRel, roots.archiveRel, 2)
    expect(fingerprint(root)).toBe(before)
  })

  test("a real source edit still moves it after goal-state writes", () => {
    const root = repo("canonical-source")
    const roots = resolveStoreRoots(root)
    writeGoalState(root, roots.goalsRel, roots.archiveRel)

    const before = fingerprint(root)
    writeFileSync(join(root, "src.ts"), "export const value = 2\n")
    const edited = fingerprint(root)
    expect(edited).not.toBe(before)

    // New untracked work counts too (the other half of treeState).
    writeFileSync(join(root, "new-file.ts"), "export const extra = 3\n")
    expect(fingerprint(root)).not.toBe(edited)
  })

  test("the same holds for the legacy .opencode/goals and its archive", () => {
    const root = repo("legacy")
    const before = fingerprint(root)
    writeGoalState(root, ".opencode/goals", ".opencode/goals-archive", 1)
    expect(fingerprint(root)).toBe(before)
    writeGoalState(root, ".opencode/goals", ".opencode/goals-archive", 2)
    expect(fingerprint(root)).toBe(before)

    writeFileSync(join(root, "src.ts"), "export const value = 9\n")
    expect(fingerprint(root)).not.toBe(before)
  })

  test("a project that pins its own root is covered by resolution, not a literal", () => {
    const root = repo("pinned", { goalsDir: "store/goals", archiveDir: "store/archive" })
    const roots = resolveStoreRoots(root)
    expect(roots.goalsRel).toBe("store/goals")
    expect(storeExcludePaths(root)).toContain("store/goals")
    expect(storeExcludePaths(root)).toContain("store/archive")

    const before = fingerprint(root)
    writeGoalState(root, "store/goals", "store/archive", 1)
    expect(fingerprint(root)).toBe(before)
    writeFileSync(join(root, "src.ts"), "export const value = 4\n")
    expect(fingerprint(root)).not.toBe(before)
  })

  test("the exclusion set is the active and legacy roots plus both archives", () => {
    const root = repo("exclusion-set")
    expect(storeExcludePaths(root)).toEqual([".cleo/goals", ".cleo/goals-archive", ".opencode/goals", ".opencode/goals-archive"])
    // A path the resolver has not seen yet still gets the built-in roots.
    expect(storeExcludePaths(join(root, "does-not-exist"))).toEqual([".cleo/goals", ".cleo/goals-archive", ".opencode/goals", ".opencode/goals-archive"])
  })
})

describe("the evidence grep excludes the same roots", () => {
  const check = (root: string) => runHostCheck({ kind: "absent", pattern: "T182_NEEDLE" }, root, undefined)

  test("a needle in a tracked contract under either store is not evidence", async () => {
    const root = repo("grep-store")
    for (const rel of [".cleo/goals", ".opencode/goals"]) {
      mkdirSync(join(root, rel, "demo"), { recursive: true })
      writeFileSync(join(root, rel, "demo", "goal.yaml"), "statement: T182_NEEDLE\n")
    }
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "tracked goal state")

    const result = await check(root)
    expect(result.pass).toBe(true)
    expect(result.detail).toBe("no matches")
  })

  test("a needle in source is still found", async () => {
    const root = repo("grep-source")
    writeFileSync(join(root, "src.ts"), "export const leaked = 'T182_NEEDLE'\n")
    const result = await check(root)
    expect(result.pass).toBe(false)
    expect(result.detail).toContain("src.ts")
  })
})
