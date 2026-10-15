import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fingerprint } from "../../src/util/git"

// T116 (from the VidaPeps repro): the fingerprint covered only the shared
// project root, so a commit in a linked `.worktrees/<slug>` worktree recorded
// changed:false and three such turns tripped the stall auto-pause. The run's
// progress fingerprint is `fingerprint(this.root)`; a commit in any linked
// worktree must flip it.

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

test("a commit in a linked .worktrees worktree changes the run fingerprint", () => {
  const root = mkdtempSync(join(tmpdir(), "ocgoal-worktree-"))
  git(root, "init", "-q", "-b", "main")
  writeFileSync(join(root, "README.md"), "# root\n")
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "root init")

  const worktree = join(root, ".worktrees", "feature")
  git(root, "worktree", "add", "-q", "-b", "feature", worktree)

  const rootHead = git(root, "rev-parse", "HEAD")
  const before = fingerprint(root)

  // Real work: a commit in the linked worktree, nothing in the root tree.
  writeFileSync(join(worktree, "work.txt"), "feature work\n")
  git(worktree, "add", "-A")
  git(worktree, "commit", "-q", "-m", "worktree work")

  const after = fingerprint(root)
  expect(before).toBeTruthy()
  expect(after).toBeTruthy()
  expect(git(root, "rev-parse", "HEAD")).toBe(rootHead) // the root tree did not move
  expect(after).not.toBe(before)
})
