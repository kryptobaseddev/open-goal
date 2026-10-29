// Opt-in store migration — PLANNING ONLY.
//
// The plan lists every goal folder the move would carry, proves where it would
// land, and writes NOTHING. `writes: 0` is a type literal, not a promise: this
// module only reads. The moving half (`goal store migrate --confirm`) is part
// of T157 and is deliberately not enabled here, because no owner has opted in
// and a live run must never be relocated underneath its session.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { isTerminal } from "./state"
import type { Store } from "./store"
import { insideRel, type StoreLayout, type StoreRoots } from "./store-root"

export class StoreMigrationError extends Error {}

type Walk = { files: number; bytes: number; digest: string; symlinks: string[] }

const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex")

/** A deterministic digest of a goal folder's bytes: relative path, size and
 *  content hash of every regular file, sorted. Symlinks are named, never
 *  followed — a move must rename the folder, not copy through a link. */
function walkGoalDir(dir: string): Walk {
  const entries: Array<{ rel: string; bytes: number; sha256: string }> = []
  const symlinks: string[] = []
  const visit = (abs: string, rel: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = join(abs, entry.name)
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        symlinks.push(childRel)
        continue
      }
      if (entry.isDirectory()) {
        visit(childAbs, childRel)
        continue
      }
      if (!entry.isFile()) continue
      const bytes = statSync(childAbs).size
      entries.push({ rel: childRel, bytes, sha256: sha256(readFileSync(childAbs)) })
    }
  }
  visit(dir, "")
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  const digest = sha256(entries.map((e) => `${e.rel}\0${e.bytes}\0${e.sha256}\n`).join(""))
  return { files: entries.length, bytes: entries.reduce((sum, e) => sum + e.bytes, 0), digest, symlinks }
}

export type MigrationGoal = {
  slug: string
  archived: boolean
  /** The run's status, or "draft" (contract only) / "unknown" (unreadable run). */
  status: string
  runId?: string
  lock?: string
  files: number
  bytes: number
  digest: string
  from: string
  to: string
  migratable: boolean
  reason?: string
}

export type MigrationConflict = { slug: string; archived: boolean; reason: string }

export type StoreMigrationPlan = {
  schemaVersion: 1
  dryRun: true
  writes: 0
  source: { layout: StoreLayout; goals: string; archive: string }
  target: { layout: StoreLayout; goals: string; archive: string }
  goals: MigrationGoal[]
  conflicts: MigrationConflict[]
  warnings: string[]
  totals: { goals: number; bytes: number; migratable: number }
}

const overlaps = (a: string, b: string) => insideRel(a, b) || insideRel(b, a)

function assertDisjoint(source: StoreRoots, target: StoreRoots) {
  if (source.goalsRel === target.goalsRel && source.archiveRel === target.archiveRel)
    throw new StoreMigrationError(`the source and target store are the same (${source.goalsRel}); nothing to migrate`)
  const pairs: Array<[string, string]> = [
    [source.goalsRel, target.goalsRel],
    [source.goalsRel, target.archiveRel],
    [source.archiveRel, target.goalsRel],
    [source.archiveRel, target.archiveRel],
  ]
  for (const [a, b] of pairs)
    if (overlaps(a, b)) throw new StoreMigrationError(`${a} and ${b} overlap; a migration must move between disjoint stores`)
}

/**
 * What a move from `store` to `target` would do. Pure: every path is read,
 * none is written, created or renamed.
 *
 * A goal is `migratable: false` when its run is not terminal (moving a live
 * run would break its session), when the run cannot be read, or when the
 * target already holds that slug. Those are reported, never silently skipped.
 */
export function planStoreMigration(store: Store, target: StoreRoots): StoreMigrationPlan {
  assertDisjoint(store.roots, target)
  const goals: MigrationGoal[] = []
  const conflicts: MigrationConflict[] = []
  const warnings: string[] = []

  for (const archived of [false, true]) {
    const slugs = archived ? store.archivedSlugs() : store.slugs()
    for (const slug of slugs) {
      const from = archived ? store.archivedPath(slug) : store.dir(slug)
      const to = archived ? join(target.archive, slug) : join(target.goals, slug)
      const walk = walkGoalDir(from)
      if (walk.symlinks.length) warnings.push(`${archived ? "archive" : "live"}:${slug} contains ${walk.symlinks.length} symlink(s) (${walk.symlinks.slice(0, 3).join(", ")}); the move must rename the folder rather than copy through them`)
      const run = archived ? store.readRun(slug, { archived: true }) : store.readRun(slug)
      const hasRunFile = existsSync(join(from, "run.json"))
      const status = run?.status ?? (hasRunFile ? "unknown" : "draft")
      const entry: MigrationGoal = {
        slug,
        archived,
        status,
        ...(run ? { runId: run.runId, lock: run.lock } : {}),
        files: walk.files,
        bytes: walk.bytes,
        digest: walk.digest,
        from,
        to,
        migratable: true,
      }
      if (hasRunFile && !run) {
        entry.migratable = false
        entry.reason = "run.json is unreadable; preserve it and inspect before moving"
      } else if (run && !isTerminal(run.status)) {
        entry.migratable = false
        entry.reason = `run is ${run.status}; finish, stop or abort it before moving its history`
      }
      if (existsSync(to)) {
        const existing = walkGoalDir(to)
        entry.migratable = false
        const reason = existing.digest === walk.digest ? "already present at the target with identical bytes; nothing to move" : "the target already holds this slug with different bytes"
        entry.reason = reason
        conflicts.push({ slug, archived, reason })
      }
      goals.push(entry)
    }
  }

  return {
    schemaVersion: 1,
    dryRun: true,
    writes: 0,
    source: { layout: store.roots.layout, goals: store.roots.goalsRel, archive: store.roots.archiveRel },
    target: { layout: target.layout, goals: target.goalsRel, archive: target.archiveRel },
    goals,
    conflicts,
    warnings,
    totals: { goals: goals.length, bytes: goals.reduce((sum, g) => sum + g.bytes, 0), migratable: goals.filter((g) => g.migratable).length },
  }
}
