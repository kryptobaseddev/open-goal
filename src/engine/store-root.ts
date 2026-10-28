// The goal store is a PROJECT setting, not an accident of which harness started
// the run. This module is the ONE place a goal path is derived, so the engine,
// the CLI, the tick and the write guard can agree on a single root.
//
// This build still resolves `.opencode/goals` when nothing is configured: the
// abstraction is introduced without moving a single byte, because the canonical
// store (`.cleo/goals` by default) ships after the adapter seam. See
// docs/research/agnostic-goal-store-seam.md for the order and what is left.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path"

/** Bumped only when the on-disk shape changes: `<goals>/<slug>/goal.yaml` +
 *  `run.json` (version 1) + `ledger.jsonl` + `evidence/<runId>/`. A second
 *  harness reads that shape by this number, so an additive file (a marker, a
 *  cache) does NOT bump it — a different folder contract does. */
export const STORE_PROTOCOL_VERSION = 1

export const STORE_LAYOUTS = ["legacy-opencode", "cleo"] as const
export type StoreLayout = (typeof STORE_LAYOUTS)[number]

export const LEGACY_GOALS_REL = ".opencode/goals"
export const LEGACY_ARCHIVE_REL = ".opencode/goals-archive"
export const CANONICAL_GOALS_REL = ".cleo/goals"
export const CANONICAL_ARCHIVE_REL = ".cleo/goals-archive"

/** The layout NEW runs use once the canonical store is enabled (gated on the
 *  adapter seam). Kept separate from the resolved default on purpose: a test
 *  can state the target without pretending it is already in effect. */
export const DEFAULT_TARGET_LAYOUT: StoreLayout = "cleo"
/** The layout this build resolves when no override is configured. */
export const DEFAULT_RESOLVED_LAYOUT: StoreLayout = "legacy-opencode"

/** A configured root that cannot be trusted. The caller must fail closed: an
 *  invalid store root never falls back to a path that happens to exist. */
export class StoreRootError extends Error {}

const REL_SEPARATORS = /[\\/]+/

const posix = (path: string) => path.split(sep).join("/")

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child)
  return rel === "" || (!(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)))
}

/** True when a project-relative POSIX path is the directory itself or inside it. */
export const insideRel = (rel: string, dirRel: string) => rel === dirRel || rel.startsWith(`${dirRel}/`)

/** Normalize a configured, project-relative store directory. Rejects every
 *  shape that could escape the project, collide with source, or write inside
 *  the legacy store — an invalid root fails closed rather than resolving to
 *  something close (T152/T153). */
function configuredRel(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new StoreRootError("the configured goal-store root is empty")
  const raw = value.trim()
  if (isAbsolute(raw)) throw new StoreRootError(`the configured goal-store root must be project-relative, got the absolute path ${raw}`)
  if (raw.split(REL_SEPARATORS).includes("..")) throw new StoreRootError(`the configured goal-store root may not contain "..": ${raw}`)
  const normalized = posix(normalize(raw)).replace(/\/+$/, "")
  if (!normalized || normalized === ".") throw new StoreRootError("the configured goal-store root may not be the project root itself")
  const segments = normalized.split("/")
  if (segments.includes(".git")) throw new StoreRootError(`the configured goal-store root may not live inside .git: ${raw}`)
  if (segments.includes("node_modules")) throw new StoreRootError(`the configured goal-store root may not live inside node_modules: ${raw}`)
  return normalized
}

/** The directory may not be, contain, or sit inside the legacy store: those
 *  bytes belong to existing runs and are never rewritten by resolution. The
 *  legacy path itself is the default, so it is not an override either. */
function assertClearOfLegacy(rel: string) {
  for (const legacy of [LEGACY_GOALS_REL, LEGACY_ARCHIVE_REL]) {
    if (rel === legacy) throw new StoreRootError(`${rel} is the legacy store; it is already the default and cannot be selected as an override`)
    if (insideRel(rel, legacy)) throw new StoreRootError(`the configured goal-store root ${rel} is inside the legacy store ${legacy}`)
    if (insideRel(legacy, rel)) throw new StoreRootError(`the configured goal-store root ${rel} would contain the legacy store ${legacy}`)
  }
}

/** The nearest existing ancestor must resolve inside the project, so a
 *  symlinked directory cannot move the store outside it. */
function assertContained(rootReal: string, absolute: string) {
  let probe = absolute
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  let real: string
  try {
    real = realpathSync(probe)
  } catch {
    throw new StoreRootError(`the configured goal-store root ${absolute} cannot be resolved`)
  }
  if (!inside(real, rootReal)) throw new StoreRootError(`the configured goal-store root ${absolute} resolves outside the project (${real})`)
  if (existsSync(absolute) && !statSync(absolute).isDirectory()) throw new StoreRootError(`the configured goal-store root ${absolute} is not a directory`)
}

const archiveBeside = (goalsRel: string) => {
  const parent = dirname(goalsRel)
  return parent === "." ? "goals-archive" : posix(join(parent, "goals-archive"))
}

export type StoreRoots = {
  readonly protocolVersion: typeof STORE_PROTOCOL_VERSION
  readonly layout: StoreLayout
  readonly root: string
  /** Absolute goals directory (the active store). */
  readonly goals: string
  /** Absolute archive directory that sits beside the active store. */
  readonly archive: string
  /** Project-relative POSIX forms — what the guard, messages and git excludes use. */
  readonly goalsRel: string
  readonly archiveRel: string
  /** True when a project setting selected this root (not the build default). */
  readonly explicit: boolean
  /** The legacy store stays readable for the whole transition. */
  readonly legacy: { readonly goals: string; readonly archive: string; readonly goalsRel: string; readonly archiveRel: string }
}

export type StoreRootOptions = {
  /** Explicit project-relative goals directory. Absent = today's `.opencode/goals`. */
  goalsDir?: string
  /** Explicit archive directory; defaults to a sibling `goals-archive`. */
  archiveDir?: string
}

/**
 * Resolve the one store root for a project.
 *
 * No override → `.opencode/goals` + `.opencode/goals-archive` (unchanged, so an
 * existing run, guard and CLI keep working). An override → validated and
 * resolved, or `StoreRootError`; there is no partial trust and no fallback.
 */
export function resolveStoreRoots(root: string, options: StoreRootOptions = {}): StoreRoots {
  const absoluteRoot = resolve(root)
  const rootReal = existsSync(absoluteRoot) ? realpathSync(absoluteRoot) : absoluteRoot
  const legacy = {
    goals: join(absoluteRoot, LEGACY_GOALS_REL),
    archive: join(absoluteRoot, LEGACY_ARCHIVE_REL),
    goalsRel: LEGACY_GOALS_REL,
    archiveRel: LEGACY_ARCHIVE_REL,
  }
  const base = { protocolVersion: STORE_PROTOCOL_VERSION, root: absoluteRoot, legacy } as const

  if (options.goalsDir === undefined && options.archiveDir === undefined)
    return { ...base, layout: DEFAULT_RESOLVED_LAYOUT, goals: legacy.goals, archive: legacy.archive, goalsRel: legacy.goalsRel, archiveRel: legacy.archiveRel, explicit: false }

  const goalsRel = configuredRel(options.goalsDir ?? CANONICAL_GOALS_REL)
  assertClearOfLegacy(goalsRel)
  const archiveRel = options.archiveDir === undefined ? archiveBeside(goalsRel) : configuredRel(options.archiveDir)
  assertClearOfLegacy(archiveRel)
  if (insideRel(archiveRel, goalsRel) || insideRel(goalsRel, archiveRel))
    throw new StoreRootError(`the goal store ${goalsRel} and its archive ${archiveRel} may not contain one another`)

  for (const rel of [goalsRel, archiveRel]) assertContained(rootReal, join(absoluteRoot, rel))

  return {
    ...base,
    layout: goalsRel === LEGACY_GOALS_REL ? "legacy-opencode" : "cleo",
    goals: join(absoluteRoot, goalsRel),
    archive: join(absoluteRoot, archiveRel),
    goalsRel,
    archiveRel,
    explicit: true,
  }
}

/** Which owner/host-owned directory a project-relative path belongs to. During
 *  the transition the guard covers the ACTIVE store AND the legacy one, so a
 *  half-migrated project cannot be edited through either path. */
export function storePathKind(roots: StoreRoots, rel: string): "active" | "active-archive" | "legacy" | "legacy-archive" | undefined {
  const path = posix(rel).replace(/^\.\//, "")
  if (insideRel(path, roots.goalsRel)) return "active"
  if (insideRel(path, roots.archiveRel)) return "active-archive"
  if (insideRel(path, roots.legacy.goalsRel)) return "legacy"
  if (insideRel(path, roots.legacy.archiveRel)) return "legacy-archive"
  return undefined
}

const goalFolders = (dir: string): string[] => {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "goal.yaml")))
    .map((d) => d.name)
}

/** A read-only description another harness (or the CLI) can print: which root
 *  this project resolved, under which layout, and what currently lives there. */
export type StoreDescriptor = {
  protocolVersion: typeof STORE_PROTOCOL_VERSION
  layout: StoreLayout
  explicit: boolean
  goals: string
  archive: string
  legacy: { goals: string; archive: string }
  live: number
  archived: number
}

export function describeStore(roots: StoreRoots): StoreDescriptor {
  return {
    protocolVersion: roots.protocolVersion,
    layout: roots.layout,
    explicit: roots.explicit,
    goals: roots.goalsRel,
    archive: roots.archiveRel,
    legacy: { goals: roots.legacy.goalsRel, archive: roots.legacy.archiveRel },
    live: goalFolders(roots.goals).length,
    archived: goalFolders(roots.archive).length,
  }
}
