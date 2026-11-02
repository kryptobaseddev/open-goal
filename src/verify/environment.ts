// A criterion's `pass` is stamped at a turn. The environment around it can move
// between turns — a package.json version bump, a new HEAD, a release tag that
// no longer points where the check expected — and the next verdict used to say
// nothing about it. This snapshot makes the drift visible by name.
//
// Pure compare + one capture; no writes.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

export type EnvironmentSnapshot = {
  at: number
  /** Project package.json version, if readable. */
  packageVersion?: string
  /** HEAD commit at capture. */
  head?: string
  /** Commit the v<packageVersion> tag resolves to, if that tag exists. */
  tagCommit?: string
  /** Whether that tag commit is an ancestor of HEAD (a merged release). */
  tagOnHead?: boolean
}

export type EnvironmentDiff = { changed: boolean; lines: string[] }

type Git = (args: string[]) => { status: number | null; stdout: string }

const defaultGit: Git = (args) => {
  const r = spawnSync("git", args, { encoding: "utf8" })
  return { status: r.status, stdout: r.stdout ?? "" }
}

export function captureEnvironment(root: string, now: number, git: Git = defaultGit): EnvironmentSnapshot {
  const snapshot: EnvironmentSnapshot = { at: now }
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }
    if (pkg.version) snapshot.packageVersion = String(pkg.version)
  } catch {
    /* a project without package.json simply has no version input */
  }
  const head = git(["rev-parse", "--verify", "HEAD"])
  if (head.status === 0 && head.stdout.trim()) snapshot.head = head.stdout.trim()
  if (snapshot.packageVersion) {
    const tag = `v${snapshot.packageVersion}`
    const resolved = git(["rev-parse", "--verify", `${tag}^{commit}`])
    if (resolved.status === 0 && resolved.stdout.trim()) {
      snapshot.tagCommit = resolved.stdout.trim()
      if (snapshot.head) snapshot.tagOnHead = git(["merge-base", "--is-ancestor", snapshot.tagCommit, snapshot.head]).status === 0
    }
  }
  return snapshot
}

/** Lines naming what moved since `previous`. Empty when nothing did. */
export function compareEnvironment(previous: EnvironmentSnapshot | undefined, next: EnvironmentSnapshot): EnvironmentDiff {
  if (!previous) return { changed: false, lines: [] }
  const lines: string[] = []
  if (previous.packageVersion !== next.packageVersion)
    lines.push(`package.json ${previous.packageVersion ?? "absent"} → ${next.packageVersion ?? "absent"}`)
  if (previous.head !== next.head && previous.head && next.head)
    lines.push(`HEAD ${previous.head.slice(0, 7)} → ${next.head.slice(0, 7)}`)
  if (previous.tagCommit !== next.tagCommit)
    lines.push(
      next.tagCommit
        ? `release tag v${next.packageVersion} ${previous.tagCommit ? `moved ${previous.tagCommit.slice(0, 7)} → ` : "appeared as "}${next.tagCommit.slice(0, 7)}`
        : `release tag v${next.packageVersion} is no longer present`,
    )
  if (previous.tagOnHead !== next.tagOnHead && next.tagCommit)
    lines.push(next.tagOnHead ? `release tag v${next.packageVersion} is now on HEAD` : `release tag v${next.packageVersion} is not on HEAD`)
  return { changed: lines.length > 0, lines }
}

export function environmentLine(diff: EnvironmentDiff): string[] {
  return diff.changed ? [`ENVIRONMENT changed since the last verdict: ${diff.lines.join("; ")}`] : []
}

/** Read-only helper used by the CLI status view; never writes. */
export function readPackageVersion(root: string): string | undefined {
  const path = join(root, "package.json")
  if (!existsSync(path)) return undefined
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: string }
    return pkg.version ? String(pkg.version) : undefined
  } catch {
    return undefined
  }
}
