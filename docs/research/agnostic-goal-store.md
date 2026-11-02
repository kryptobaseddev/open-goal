# The goal store: canonical `.cleo/goals`, legacy `.opencode/goals`

Status: **the default flipped and shipped in 0.12.1.** The seam, the
`.cleo/goal-store.json` override and the read-only migration planner shipped in
0.11.0 (PR #4, ADR-001); 0.12.0 made the canonical store the default for new
runs (PR #26) and 0.12.1 is that behaviour published from `main`, keeping every
legacy run readable and enabling the opt-in, byte-preserving move.

This note records the canonical store, the `.cleo/goal-store.json` override, the
legacy `.opencode/goals` read path, the opt-in dry-run-then-move migration and
the no-data-loss rule, and quotes the code that resolves the root.

Code: [`src/engine/store-root.ts`](../../src/engine/store-root.ts) (the one
resolver), [`src/engine/store.ts`](../../src/engine/store.ts) (read both, write
where the run lives), [`src/engine/store-migration.ts`](../../src/engine/store-migration.ts)
(plan + move), [`cli/ocg.ts`](../../cli/ocg.ts) (`ocg migrate`). Decision:
ADR-001 (`cleo docs fetch adr-001-goal-store-root-surface`).

## The canonical store is the default

With nothing configured, a project resolves `.cleo/goals` (archive
`.cleo/goals-archive`). The layout is a named constant, so the default is a
decision the code states rather than a literal scattered through the engine:

```ts
export const DEFAULT_TARGET_LAYOUT: StoreLayout = "cleo"
/** The layout this build resolves when no override is configured. T150: the
 *  0.11.0 release shipped the override with the legacy default; this release
 *  flips the default to the canonical store (ADR-001). */
export const DEFAULT_RESOLVED_LAYOUT: StoreLayout = "cleo"

/** The project setting that selects a non-default store root (ADR-001). One
 *  JSON file, read by the engine, the CLI and the tick through this resolver. */
export const STORE_CONFIG_REL = ".cleo/goal-store.json"
```

The resolver's own no-configuration branch, quoted from
`src/engine/store-root.ts` exactly as it ships:

```ts
  if (goalsOption === undefined && archiveOption === undefined)
    return {
      ...base,
      layout: DEFAULT_RESOLVED_LAYOUT,
      goals: join(absoluteRoot, CANONICAL_GOALS_REL),
      archive: join(absoluteRoot, CANONICAL_ARCHIVE_REL),
      goalsRel: CANONICAL_GOALS_REL,
      archiveRel: CANONICAL_ARCHIVE_REL,
      explicit: false,
    }
```

The store is a project setting, not an accident of which harness started the
run, so the engine, the CLI, the tick, the write guard, the registry and the
rendered prompts all call this one resolver.

## The override — `.cleo/goal-store.json`

One project file, read by the same resolver:

```json
{ "goalsDir": ".state/goals", "archiveDir": ".state/goals-archive" }
```

Both keys are optional and project-relative; the archive defaults to a sibling
`goals-archive`. Only those two keys are accepted, and anything else fails
closed — the reader never guesses a root from a half-valid file. Quoted from
`src/engine/store-root.ts`:

```ts
export function readStoreConfig(root: string): StoreConfig | undefined {
  const path = join(root, STORE_CONFIG_REL)
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw new StoreRootError(`${STORE_CONFIG_REL} is not valid JSON`)
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new StoreRootError(`${STORE_CONFIG_REL} must be a JSON object`)
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== "goalsDir" && key !== "archiveDir") throw new StoreRootError(`${STORE_CONFIG_REL} has an unknown key "${key}"; allowed: goalsDir, archiveDir`)
    if (typeof record[key] !== "string") throw new StoreRootError(`${STORE_CONFIG_REL}.${key} must be a string`)
  }
  const goalsDir = record.goalsDir as string | undefined
  const archiveDir = record.archiveDir as string | undefined
  return { ...(goalsDir !== undefined ? { goalsDir } : {}), ...(archiveDir !== undefined ? { archiveDir } : {}) }
}
```

Beyond the JSON shape, a resolved root is refused with `StoreRootError` when it
is absolute, contains `..`, names the project root, `.git`, `node_modules` or a
reserved harness directory (`.cleo`/`.opencode` themselves), sits inside the
legacy store, contains the legacy store, points at a file where a directory is
expected, or resolves through a symlink that escapes the project. A project may
also pin the legacy path itself (`"goalsDir": ".opencode/goals"`), which is how
an existing project stays exactly where it is.

## The legacy read path

`.opencode/goals` is never rewritten by resolution. During the transition
`Store` reads both roots and writes where the run's bytes already live. The
folder decision is one method, quoted from `src/engine/store.ts`:

```ts
  locate(slug: string, options: { archived?: boolean } = {}): string {
    const base = options.archived ? this.archiveDir : this.goalsDir
    const legacyBase = options.archived ? this.roots.legacy.archive : this.roots.legacy.goals
    const active = join(base, slug)
    if (base === legacyBase) return active
    if (existsSync(join(active, "goal.yaml")) || existsSync(join(active, "run.json"))) return active
    const legacy = join(legacyBase, slug)
    if (existsSync(join(legacy, "goal.yaml")) || existsSync(join(legacy, "run.json"))) return legacy
    return active
  }
```

Around that method:

- `slugs()` / `archivedSlugs()` list the union of the active store and the
  legacy one (the active copy wins on a slug conflict).
- Reads and run-state writes follow `locate`, so resuming a legacy run never
  copies it into the new store behind the session's back.
- A brand-new slug resolves to the active store, which is how a new run lands in
  `.cleo/goals` with no configuration.
- `archive()` demotes a goal beside the store it came from, so a legacy run's
  history never splits across two archives.
- The write guard classifies a path against **both** roots
  (`storePathKind` → active / active-archive / legacy / legacy-archive), so a
  half-migrated project cannot be edited through either path.
- The tick runs when either store exists; the registry rebuild scans the legacy
  store and then the active one; the rendered contract block names the resolved
  `goalsRel`, not a literal.

## The opt-in move

`ocg migrate` prints the plan and writes nothing (`writes: 0`). `ocg migrate
--confirm` copies every **migratable** goal into the active store:

- only runs with a terminal status (or a contract-only draft) move; a live,
  waiting or unreadable run is listed in `skipped` with the reason and is never
  relocated under its session;
- each folder is copied, then re-hashed and compared with the plan's digest; a
  mismatch removes the partial target copy and throws, so a failed move never
  leaves a half-migrated store;
- the legacy copy is **retained**: the move copies, it never renames or deletes.
  `legacyRetained: true` is part of the result.

The move itself, quoted from `src/engine/store-migration.ts`:

```ts
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
```

## The no-data-loss rule

1. Resolution never moves or deletes a byte; the dry run is read-only and its
   `writes: 0` is a type literal, not a promise.
2. A move is opt-in (an explicit confirmation is required), terminal-only, and
   hash-verified per folder.
3. The legacy folder survives every move; running `cleo init` beside an existing
   `.cleo/goal-store.json` leaves it intact (verified in ADR-001).
4. A live run is never migrated, so a session never loses its own store.

## What still points at the legacy store in this release

Named honestly rather than left to be discovered:

- The plugin's own owner-state files (`.owner-launches.json`,
  `.owner-decisions.json`, `.owner-amendments.json`, `.launch-approvals.json`)
  still resolve to the legacy location; a pending decision from before the flip
  is therefore still found.
- An auto-started successor (`continueWork`) writes its contract to the legacy
  store, keeping the successor in the same store as the run it continues; the
  protected continuation oracle pins that behaviour.
- Help/TUI copy still prints `.opencode/goals/…` in places. Those are labels,
  not paths the engine reads or writes.

## Proof

- `test/unit/store-path-seam.test.ts` — the canonical default, the override file
  (including fail-closed shapes), the classifier and the descriptor.
- `test/unit/store-layout-compat.test.ts` — a pinned legacy project keeps its
  paths, status, archive and bytes; the default store reads a legacy run and
  writes a new slug canonically.
- `test/unit/store-migration-plan.test.ts` — the dry run lists every goal, writes
  nothing and keeps the source bytes.
- `test/host/goal-store-default.test.ts` — a real engine start writes the run and
  ledger under `.cleo/goals`, creates nothing for it under `.opencode/goals`, and
  leaves a legacy run byte-identical and readable; a `.cleo/goal-store.json`
  override routes the run to `.state/goals`.
- `test/host/store-layout-compat.test.ts` — a legacy draft is driven in place and
  a status read leaves its bytes untouched.
- `test/host/store-migration.test.ts` — confirmation is required; the confirmed
  move preserves every byte, keeps the legacy copy, and skips a live run.
- `test/host/migrate-bin.test.ts` — the real `ocg migrate` process: the dry run
  prints the plan and leaves the tree byte-identical, `--confirm` copies
  migratable goals and keeps the legacy tree identical, the moved project still
  reports its live legacy run, and a broken `goal-store.json` exits 1 writing
  nothing.
- `test/unit/render-store-path.test.ts` — the rendered contract block and the
  compaction reminder name the resolved store, and omitting the argument keeps
  the pre-flip bytes.
