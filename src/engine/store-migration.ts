// Opt-in store migration — the dry run plans, the confirmed move copies.
//
// The plan lists every goal folder the move would carry, proves where it would
// land, and writes NOTHING (`writes: 0` is a type literal). The move runs only
// with an explicit `{ confirm: true }`, copies (never renames) each migratable
// goal, re-hashes the target, and keeps the legacy folder as the archive: a
// live run is never relocated underneath its session, and no byte is lost.
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
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

/**
 * A deterministic digest of the exact reviewed plan. A native owner review is
 * bound to this value: if either store changed between the review and the
 * confirmation (a goal finished, a folder appeared at the target), the digest
 * differs and the move is refused instead of executing bytes nobody reviewed.
 */
export function migrationPlanDigest(plan: StoreMigrationPlan): string {
  const lines = [
    `source\0${plan.source.layout}\0${plan.source.goals}\0${plan.source.archive}`,
    `target\0${plan.target.layout}\0${plan.target.goals}\0${plan.target.archive}`,
    // Bind exactly what the move executes. A skipped goal is reviewed as
    // skipped; its own bytes may keep changing (a live run writes its ledger)
    // without invalidating the review. If it becomes movable, `move`/`skip`
    // flips and the digest changes — so the owner can never confirm a larger
    // set than the one they saw.
    ...plan.goals.map((goal) =>
      `${goal.archived ? "archive" : "live"}\0${goal.slug}\0${goal.migratable ? `move\0${goal.from}\0${goal.to}\0${goal.digest}` : "skip"}`),
  ]
  return sha256(lines.join("\n"))
}

export type StoreMoveResult = {  schemaVersion: 1
  dryRun: false
  /** Goal folders actually copied (the legacy copies stay in place). */
  writes: number
  source: { layout: StoreLayout; goals: string; archive: string }
  target: { layout: StoreLayout; goals: string; archive: string }
  moved: Array<{ slug: string; archived: boolean; from: string; to: string; files: number; bytes: number; digest: string }>
  skipped: Array<{ slug: string; archived: boolean; reason: string }>
  /** The source is an archive, not a trash can: nothing here deletes it. */
  legacyRetained: true
}

/**
 * Copy every migratable goal into `target`, byte for byte, and leave the source
 * untouched. Refused without an explicit confirmation. Each copy is re-hashed
 * against the plan; a mismatch removes the partial target copy and throws, so a
 * failed move never leaves a half-migrated store.
 */
export function executeStoreMigration(store: Store, target: StoreRoots, options: { confirm?: boolean } = {}): StoreMoveResult {
  if (options.confirm !== true) throw new StoreMigrationError("a move requires explicit confirmation ({ confirm: true }); run the dry run first")
  const plan = planStoreMigration(store, target)
  const moved: StoreMoveResult["moved"] = []
  const skipped: StoreMoveResult["skipped"] = plan.goals
    .filter((goal) => !goal.migratable)
    .map((goal) => ({ slug: goal.slug, archived: goal.archived, reason: goal.reason ?? "not migratable" }))
  for (const goal of plan.goals.filter((entry) => entry.migratable)) {
    mkdirSync(dirname(goal.to), { recursive: true })
    cpSync(goal.from, goal.to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
    const copied = walkGoalDir(goal.to)
    if (copied.digest !== goal.digest || copied.files !== goal.files) {
      rmSync(goal.to, { recursive: true, force: true })
      throw new StoreMigrationError(`the move of ${goal.slug} did not preserve bytes (${copied.digest} vs ${goal.digest}); the target copy was removed and the source is untouched`)
    }
    moved.push({ slug: goal.slug, archived: goal.archived, from: goal.from, to: goal.to, files: copied.files, bytes: copied.bytes, digest: copied.digest })
  }
  return {
    schemaVersion: 1,
    dryRun: false,
    writes: moved.length,
    source: plan.source,
    target: plan.target,
    moved,
    skipped,
    legacyRetained: true,
  }
}
