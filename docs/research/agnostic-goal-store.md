# The goal store: canonical `.cleo/goals`, legacy `.opencode/goals`

Status: **the default flipped in 0.12.0.** The seam, the `.cleo/goal-store.json`
override and the read-only migration planner shipped in 0.11.0 (PR #4, ADR-001);
this release makes the canonical store the default for new runs, keeps every
legacy run readable, and enables the opt-in, byte-preserving move.

Code: [`src/engine/store-root.ts`](../../src/engine/store-root.ts) (the one
resolver), [`src/engine/store.ts`](../../src/engine/store.ts) (read both, write
where the run lives), [`src/engine/store-migration.ts`](../../src/engine/store-migration.ts)
(plan + move), [`cli/ocg.ts`](../../cli/ocg.ts) (`ocg migrate`). Decision:
ADR-001 (`cleo docs fetch adr-001-goal-store-root-surface`).

## The default

With nothing configured, a project resolves `.cleo/goals` (archive
`.cleo/goals-archive`). The store is a project setting, not an accident of which
harness started the run, so the engine, the CLI, the tick, the write guard, the
registry and the rendered prompts all call one resolver:

```ts
// src/engine/store-root.ts
if (goalsOption === undefined && archiveOption === undefined)
  return {
    ...base,
    layout: DEFAULT_RESOLVED_LAYOUT,          // "cleo"
    goals: join(absoluteRoot, CANONICAL_GOALS_REL),
    archive: join(absoluteRoot, CANONICAL_ARCHIVE_REL),
    goalsRel: CANONICAL_GOALS_REL,
    archiveRel: CANONICAL_ARCHIVE_REL,
    explicit: false,
  }
```

## The override — `.cleo/goal-store.json`

One project file, read by the same resolver:

```json
{ "goalsDir": ".state/goals", "archiveDir": ".state/goals-archive" }
```

- Both keys are optional and project-relative; the archive defaults to a sibling
  `goals-archive`.
- Only those two keys are accepted. A malformed file, an unknown key, a
  non-string value, an absolute path, `..`, the project root, `.git`,
  `node_modules`, a reserved harness directory (`.cleo`/`.opencode` themselves),
  a path inside the legacy store, a file where a directory is expected, or a
  symlink that resolves outside the project all throw `StoreRootError` — there is
  no fallback to "something close". A project may also pin the legacy path
  itself (`"goalsDir": ".opencode/goals"`), which is how an existing project
  stays exactly where it is.

## The legacy read path

`.opencode/goals` is never rewritten by resolution. During the transition
`Store` reads both roots and writes where the run's bytes already live:

- `slugs()` / `archivedSlugs()` list the union of the active store and the
  legacy one (the active copy wins on a slug conflict).
- `locate(slug)` returns the active folder when it exists, else the readable
  legacy folder; reads and run-state writes follow it, so resuming a legacy run
  never copies it into the new store behind the session's back.
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

```ts
// src/engine/store-migration.ts
if (options.confirm !== true) throw new StoreMigrationError("a move requires explicit confirmation …")
const plan = planStoreMigration(store, target)
…
cpSync(goal.from, goal.to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
const copied = walkGoalDir(goal.to)
if (copied.digest !== goal.digest || copied.files !== goal.files) { … throw … }
```

## The no-data-loss rule

1. Resolution never moves or deletes a byte; the dry run is read-only.
2. A move is opt-in, terminal-only, and hash-verified per folder.
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
  leaves a legacy run byte-identical and readable.
- `test/host/store-migration.test.ts` — confirmation is required; the confirmed
  move preserves every byte, keeps the legacy copy, and skips a live run.
- `test/host/migrate-bin.test.ts` — the real `ocg migrate` process: the dry run
  prints the plan and leaves the tree byte-identical, `--confirm` copies
  migratable goals and keeps the legacy tree identical, the moved project still
  reports its live legacy run, and a broken `goal-store.json` exits 1 writing
  nothing.
