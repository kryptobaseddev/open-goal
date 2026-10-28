# The agnostic goal store — seam prepared, default not moved

Status: **prepared on branch `agnostic-goal-store` (2026-10-28), not merged, not
enabled.** Plugin 0.9.4 · package `@cleocode/goal` · repo
`kryptobaseddev/open-goal` · plugin id `open-goal`.

This note is the design record for the store-path seam. It does not claim the
canonical store is live: the default is still `.opencode/goals` and the owner
has not opted into a migration. The contract for this goal lives at
`.opencode/goals/agnostic-goal-store/goal.yaml`; the roadmap is
[agnostic-ocg-roadmap.md](agnostic-ocg-roadmap.md).

## The decision (owner-planned, not yet in effect)

- **Canonical:** `.cleo/goals/<slug>/` — CLEO owns the goal protocol; the
  directory is no longer named after one harness.
- **Override:** an explicit project setting selects another project-relative
  root; an invalid root fails closed.
- **Legacy:** `.opencode/goals/` stays readable and resumable for existing
  runs. It is never deleted, rewritten or silently moved.
- **Migration:** opt-in, dry-run first, byte-preserving.
- **Archive:** `<store>/../goals-archive` (`.cleo/goals-archive` for the
  canonical store); the legacy archive stays readable.
- **No data loss:** a move copies/renames whole goal folders and verifies
  bytes, or it does not happen.

## Why the default has not moved

Both predecessor goals are unlanded: `harness-identity` and `adapter-seam`
have **no commits ahead of `main`** (checked 2026-10-28; `git log
main..adapter-seam` is empty). The store root has to be resolved in the CLI,
the tick and the in-process engine, and the seam is what makes those three one
implementation. Moving the default before it exists would mean three hardcoded
paths drifting apart, which is exactly the failure the seam prevents.

So this round lands the abstraction and the read-only planning; it changes no
run, guard, status or install behaviour.

## The seam

`src/engine/store-root.ts` is the one place a goal path is derived:

```ts
// src/engine/store-root.ts
export const DEFAULT_TARGET_LAYOUT: StoreLayout = "cleo"
export const DEFAULT_RESOLVED_LAYOUT: StoreLayout = "legacy-opencode"

export function resolveStoreRoots(root: string, options: StoreRootOptions = {}): StoreRoots {
  const absoluteRoot = resolve(root)
  // …
  if (options.goalsDir === undefined && options.archiveDir === undefined)
    return { ...base, layout: DEFAULT_RESOLVED_LAYOUT, goals: legacy.goals, archive: legacy.archive, … explicit: false }
  // a configured root is validated or throws StoreRootError
}
```

`Store` now takes the resolved roots (default: the resolver's answer, i.e.
today's paths) and exposes `roots`:

```ts
// src/engine/store.ts
constructor(readonly root: string, roots: StoreRoots = resolveStoreRoots(root)) {
  this.roots = roots
  this.goalsDir = roots.goals
  this.archiveDir = roots.archive
}
```

A configured root is rejected — never "repaired" — when it is absolute,
contains `..`, is the project root, lives in `.git` or `node_modules`, is or
contains the legacy store, is a file, or resolves through a symlink outside
the project. `storePathKind()` classifies a project-relative path as `active`,
`active-archive`, `legacy` or `legacy-archive`, so the guard can cover both
roots during the transition.

### Paths that must move behind the resolver (T153)

| Where | Today | What it decides |
|---|---|---|
| `src/engine/store.ts:20` | `roots.goals` | **done** — store dir/archive |
| `src/server/app.ts:166-168` | `.opencode/goals/.owner-launches.json`, `.owner-amendments.json`, `.owner-decisions.json` | consent records; a new root without them loses forms |
| `src/server/app.ts:3806-3808` | `.opencode/goals/${slug}`, `.opencode/goals-archive/` | agent write guard |
| `src/server/app.ts:4326-4350` | `.opencode/goals/` regex | shell-write detection |
| `src/server/app.ts:2136` | `includes(".opencode/goals")` | CLEO report filter |
| `src/server/app.ts:3448` | `.opencode/goals/<slug>/goal.yaml` | mtime sorting |
| `src/contract/render.ts:64,76,128` | prompt paths | worker sees the contract path and the "never edit" rule |
| `src/util/git.ts:7` | `:(exclude).opencode/goals` | progress fingerprint |
| `src/verify/pipeline.ts:63,128` | same exclude + refusal text | `absent` checks and integrity |
| `src/engine/tick.ts:105-106` | `existsSync(root/.opencode/goals)` | the tick's "is this a goal project" gate |
| `src/cli/status.ts` | via `Store` | **done by construction** |
| `src/cli/install.ts:13` | `.opencode/opencode.json` | plugin config, not the store — stays |
| `scripts/check-installed-goal.ts:50` | `.opencode/goals` | C6 install proof would fail on a canonical project |

The prompt paths are the subtle one: the system block must stay byte-stable
within a run (`AGENTS.md`). Passing the run's store path into
`renderSystemBlock` is stable as long as it is derived from the run, not from
whatever config says at the next turn.

## Protocol and version seams

- `STORE_PROTOCOL_VERSION = 1` describes the folder contract that another
  harness reads: `<goals>/<slug>/goal.yaml`, `run.json` (version 1),
  `ledger.jsonl`, `evidence/<runId>/`. A version bump means a different shape,
  not an extra file — a marker or cache is additive.
- `StoreLayout` names the two layouts (`legacy-opencode`, `cleo`), so a
  descriptor can say what it is instead of guessing from a path prefix.
- `describeStore(roots)` returns a read-only descriptor (layout, explicit,
  project-relative goals/archive, legacy paths, live/archived counts) for a
  harness or the CLI to consume. Nothing writes it.
- Legacy runs are read through an explicit legacy root, **not** an ambient
  merge: `test/unit/store-layout-compat.test.ts` pins that a canonical store
  does not silently adopt `.opencode/goals` runs. T156 decides how the engine
  presents both roots (inventory, attach, resume) — that decision is not made
  here.

## Migration (T157): planning only

`src/engine/store-migration.ts` implements `planStoreMigration(store, target)`.
It is read-only by construction — the result is typed `writes: 0` and the
module has no write call.

- lists **every** live and archived goal with `from`/`to`, file count, total
  bytes and a sha256 digest over sorted `path\0size\0content-hash`;
- `migratable: false` with a reason for a non-terminal run, an unreadable
  `run.json`, or a target that already holds the slug (conflict; identical
  bytes say "nothing to move");
- refuses overlapping geometry (same store, target inside source or vice
  versa) with `StoreMigrationError`;
- names symlinks instead of following them — the move must rename the folder.

The move itself is deliberately not implemented: it needs an owner opt-in and
a stopped run, and its acceptance is `test/host/store-migration.test.ts`,
which is not written yet. A future move is: refuse if any run is live →
copy each folder to a temp sibling → verify the digest → rename into place →
leave the legacy folder untouched until the owner confirms → record the result
in the ledger. No `rm` of legacy history.

## What is left, by task

| Task | Left |
|---|---|
| T152 | read the config override, flip the resolved default to `.cleo/goals` |
| T153 | move the table above behind the resolver; guard both roots |
| T154 | host/unit coverage of the new root, guard, status (*not* the C1–C4 check files yet) |
| T156 | decide and implement legacy read/resume surfacing |
| T157 | the confirmed move + guide |
| T158 | archive and supersession across roots |
| T160-T162 | dispatcher signal, portable skill, ADR/deprecation docs |

## Open owner decision: where the override is configured

Two candidate surfaces, deliberately not chosen here:

1. **Plugin option** in the existing project config —
   `[<spec>, { goalStoreRoot: ".cleo/goals" }]` in `.opencode/opencode.json`.
   Reuses the install path and arrives as `ctx.options`; but the CLI and tick
   do not load OpenCode config, so they would need their own read of the same
   file.
2. **A dedicated project file** (e.g. `.cleo/goal-store.json`) read by the
   engine, the CLI and the tick alike. One reader, harness-neutral; one more
   file to validate and document.

Either way the key must be project-relative, validated as above, and absent
from every existing project so the default stays unchanged.

## Checks run for this note

`bun test test/unit/store-path-seam.test.ts test/unit/store-layout-compat.test.ts
test/unit/store-migration-plan.test.ts` — 45 pass, 0 fail. `bun test test/unit`
— 346 pass, 0 fail (11 consecutive runs after one unreproduced flake in the
first post-build run). `bun run typecheck` — `check:tui`, `check:cli` and
`tsc --noEmit` clean (the CLI bundle was regenerated for the new import).
