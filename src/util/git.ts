// Worktree fingerprints: progress is measured by authoritative state change,
// not by how much the model talked.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { statSync } from "node:fs"

const GOAL_STATE = ":(exclude).opencode/goals"

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  // node:child_process so the bin also runs on plain Node (Bun implements it too).
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 })
  return { ok: result.status === 0, out: result.stdout ?? "" }
}

export const isRepo = (cwd: string) => git(cwd, ["rev-parse", "--is-inside-work-tree"]).out.trim() === "true"

/** T100: the working-tree root for `cwd` (the linked worktree's own root when
 *  cwd is inside one). Used to require a bound workspace to BE a work-tree root
 *  rather than any subdirectory of the project. */
export const topLevel = (cwd: string): string | undefined => {
  const r = git(cwd, ["rev-parse", "--show-toplevel"])
  return r.ok ? r.out.trim() : undefined
}

export const headCommit = (cwd: string): string | undefined => {
  const r = git(cwd, ["rev-parse", "HEAD"])
  return r.ok ? r.out.trim() : undefined
}

/** T116: linked worktrees live under the project but their commits are invisible
 * to the root worktree's diff, so the last goal run recorded changed:false and
 * tripped the stall auto-pause three times. `git worktree list --porcelain`
 * names every worktree's HEAD and branch; a commit in any of them changes it. */
export function worktreeSignature(cwd: string): string {
  return git(cwd, ["worktree", "list", "--porcelain"])
    .out.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

/** Hash of HEAD + staged/unstaged diff + untracked file list + linked-worktree HEADs, excluding goal state. */
export function fingerprint(cwd: string): string | undefined {
  if (!isRepo(cwd)) return undefined
  const head = git(cwd, ["rev-parse", "HEAD"]).out
  const diff = git(cwd, ["diff", "HEAD", "--no-color", "--", ".", GOAL_STATE]).out
  const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ".", GOAL_STATE]).out
  const contents = untracked
    .split("\n")
    .filter(Boolean)
    .slice(0, 500)
    .map((file) => {
      try {
        const stat = statSync(`${cwd}/${file}`)
        return `${file}:${stat.size}:${Math.trunc(stat.mtimeMs)}`
      } catch {
        return file
      }
    })
  return createHash("sha256").update(head).update(diff).update(contents.join("\n")).update(worktreeSignature(cwd)).digest("hex").slice(0, 20)
}

/** T109: a bounded, host-computed git history digest. The verifier child has only
 * read/glob/grep (no shell), so a criterion that asks about commit history was
 * unanswerable and burned the round budget. The host supplies this text; the
 * verifier judges from it and from the copy the host saves under evidence/. */
export function gitDigest(cwd: string, limit = 20): string {
  if (!isRepo(cwd)) return "(not a git repository)"
  const head = git(cwd, ["rev-parse", "HEAD"]).out.trim()
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).out.trim()
  const log = git(cwd, ["log", "-n", String(limit), "--no-color", "--pretty=format:%h %ad %s", "--date=short"]).out.trim()
  const trees = worktreeSignature(cwd)
  return [`HEAD ${head}`, `branch ${branch}`, log, trees ? `linked worktrees:\n${trees}` : ""].filter(Boolean).join("\n")
}

/** Files changed relative to `base` (committed, staged, unstaged and untracked). */
export function changedSince(cwd: string, base: string | undefined): string[] {
  if (!isRepo(cwd)) return []
  const files = new Set<string>()
  if (base) for (const f of git(cwd, ["diff", "--name-only", base, "--", ".", GOAL_STATE]).out.split("\n")) if (f) files.add(f)
  for (const f of git(cwd, ["diff", "--name-only", "HEAD", "--", ".", GOAL_STATE]).out.split("\n")) if (f) files.add(f)
  for (const f of git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ".", GOAL_STATE]).out.split("\n")) if (f) files.add(f)
  return [...files].sort()
}

/** Minimal glob → RegExp (supports **, *, ?). */
export function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*"
        i += glob[i + 2] === "/" ? 2 : 1
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`)
}

export const matchesAny = (file: string, globs: string[]) => globs.some((g) => globToRegExp(g.replace(/^\.\//, "")).test(file))
