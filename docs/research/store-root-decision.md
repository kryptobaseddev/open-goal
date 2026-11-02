# Store root: the one decision this branch cannot make

Status: **decision memo — owner input required.** Branch `agnostic-goal-store`
(DRAFT PR #4), head `0d96462` rebased onto `origin/main` `74054a4` (v0.10.1).
Everything cited here was read on that head; the companion record is
[agnostic-goal-store-seam.md](agnostic-goal-store-seam.md).

## What the branch actually contains

The seam exists and nothing calls it with an override. `resolveStoreRoots()`
(`src/engine/store-root.ts:138`) returns `.opencode/goals` when no option is
passed (`src/engine/store-root.ts:149-150`) and a validated project-relative
root when one is (`:152-169`). `Store` takes the resolver's answer
(`src/engine/store.ts:18-22`), and both construction sites use the default:
`this.store = new Store(this.root)` (`src/server/app.ts:167`) and
`const store = new Store(root)` (`cli/ocg.ts:35`). `describeStore()`
(`src/engine/store-root.ts:204`) and `storePathKind()` (`:175`) are referenced
only by tests; the migration planner (`src/engine/store-migration.ts:103`) is
not reachable from the CLI (`cli/ocg.ts` has no `migrate` subcommand).

That is the honest state: the abstraction is installed, the policy is not.

## (a) Canonical `.cleo/goals/<slug>/` with a config override

The target is already named — `DEFAULT_TARGET_LAYOUT: "cleo"`
(`src/engine/store-root.ts:29`) and `CANONICAL_GOALS_REL = ".cleo/goals"`
(`:23`) — but it is deliberately separate from the resolved default
(`DEFAULT_RESOLVED_LAYOUT: "legacy-opencode"`, `:31`). Flipping the default is a
two-line change; the cost is not in the constant, it is in the surfaces listed
under (d), each of which still hardcodes or re-derives the legacy path.

The configured root is already validated rather than repaired: absolute paths,
`..`, the project root, `.git`, `node_modules` and the harness directories
`.cleo`/`.opencode` themselves are refused (`src/engine/store-root.ts:58-70`);
a root that is, contains or sits inside the legacy store is refused (`:75-81`);
and the nearest existing ancestor must `realpath` inside the project, so a
symlinked directory cannot move the store outside it (`:85-99`). An invalid
root throws `StoreRootError` — there is no fallback to "something close"
(`:33-35`).

What does **not** exist is a reader for the setting. `goalsDir:` appears only in
tests; no code reads `goalStoreRoot` or any store key from a config file. So
"canonical store with config override" is presently two unconnected halves: a
resolver that accepts an override, and no caller that supplies one.

## (b) Keeping `.opencode/goals` readable and resumable

Readability is real but *explicit*, not ambient. A `Store` constructed with a
canonical root returns `[]` from `slugs()` and does not adopt the legacy
folders — pinned by "a canonical store does not silently adopt legacy runs"
(`test/unit/store-layout-compat.test.ts:116`, assertion at `:119-122`). The
legacy paths stay exposed on every resolved root as `roots.legacy`
(`src/engine/store-root.ts:120-121`), so a caller *can* read both, but today
nothing does: `projectInventory(store)` (`src/engine/inventory.ts:15`),
`selectRun(store)` (`src/cli/status.ts:64`) and the registry
(`src/engine/registry.ts:92`) all take one store.

That leaves a decision T156 owns and this branch does not pre-empt: whether the
inventory, `/goal list all`, attach and resume surfaces enumerate active **and**
legacy roots, or whether a legacy run is resumed only by pointing the config
back at `.opencode/goals`. The promise "readable and resumable" is not satisfied
by the seam alone.

Migration planning is opt-in and read-only by construction:
`planStoreMigration(store, target)` (`src/engine/store-migration.ts:103`)
returns `dryRun: true, writes: 0` typed as literals (`:68-78`, `:149-159`), and
the module contains no write call (`:1-7`). It lists every live and archived
folder with `from`/`to`, file count, bytes and a sha256 over
`path\0size\0content-hash` (`:24-48`), and marks `migratable: false` for a
non-terminal run (`:134-137`), an unreadable `run.json` (`:131-133`) or a slug
already at the target (`:138-144`). Identical bytes at the target are reported
as "nothing to move", not as a conflict to overwrite.

## (c) What the agent write guard must cover during the transition

Today the guard is legacy-only and string-matched. `ownedRunPath` compares
against `` `.opencode/goals/${s.slug}` `` (`src/server/app.ts:3846`), the
receipt regex against `.opencode/goals/.owner-…`
(`src/server/app.ts:3847`), and the throw condition against
`.opencode/goals-archive/` and `.opencode/goals/`
(`src/server/app.ts:3848`). The shell-write detector is the same literal:
`/(?:\.opencode\/goals\/|\/\.opencode\/goals\/)/g`
(`src/server/app.ts:4374`). Owner consent records are also pinned to the legacy
root — launch approvals (`src/server/app.ts:510-511`) and the launch,
amendment and decision stores (`src/server/app.ts:168-170`).

Under a canonical root, that means a worker could edit `.cleo/goals/<slug>/`
and rewrite a live contract or run state, and a shell redirect into it would
not be seen — the exact protection the invariant exists for. It must cover:
the active goals root, the active archive, the legacy goals root, the legacy
archive, and the owner receipt files under the **active** root (they move with
it). `storePathKind()` already classifies all four regions
(`src/engine/store-root.ts:175-182`) and is currently called only from
`test/unit/store-path-seam.test.ts:148-162`; wiring it into the guard is T153
work, not done here.

## (d) Status, install and archive paths that must resolve the root

| Surface | Where | Today |
|---|---|---|
| Engine store | `src/server/app.ts:167` | default only |
| CLI store (`status`, `tick`, `claim`) | `cli/ocg.ts:35`, tick at `:125` | default only |
| `status --json` run selection | `src/cli/status.ts:64,85` | resolves through `Store` — correct by construction |
| Tick "is this a goal project" gate | `src/engine/tick.ts:124` | hardcoded `.opencode/goals`; a canonical-only project would print "nothing to tick" |
| Archive move | `src/engine/store.ts:54` | uses `roots.archive`; correct, but see the messages below |
| Owner receipts / approvals | `src/server/app.ts:168-170,510-511` | hardcoded legacy root |
| Machine registry rebuild | `src/engine/registry.ts:92` | hardcoded legacy root |
| Worker prompt paths | `src/contract/render.ts:64,76,128` | tells the worker `.opencode/goals/...` and "never edit `.opencode/goals/`" |
| Progress fingerprint exclude | `src/util/git.ts:7`, used at `:33-34,95-97` | `:(exclude).opencode/goals` |
| `absent` check exclude / integrity text | `src/verify/pipeline.ts:63,128` | same literal |
| Install config | `src/cli/install.ts:13` | `.opencode/opencode.json` — not the store; unaffected and the natural carrier of an override |
| Install proof script | `scripts/check-installed-goal.ts:63` | hardcoded legacy root |
| User-facing strings | `src/server/messages.ts:170`; `src/server/help.ts:18,38`; `src/tui/format.ts:85,87,89`; `src/tui/dashboard.ts:67,236`; `src/server/app.ts:3504` | all name the legacy paths |

Two of these are not cosmetic. The fingerprint exclude (`src/util/git.ts:7`)
means a canonical store's `run.json`/`ledger.jsonl`/`evidence/` would count as
working-tree changes on every turn; and `.gitignore:7-11` ignores those
artifacts only under `.opencode/goals/`, so a `.cleo/goals` store would start
appearing as trackable files. The prompt strings are the second: the system
block must stay byte-stable within a run (`AGENTS.md`), so the store path has to
be derived from the run, not re-read from config each turn.

## (e) Migration failure modes and rollback

The move itself is intentionally unimplemented (`src/engine/store-migration.ts:1-7`);
the planner refuses the cheap mistakes: same store, or overlapping source and
target (`:82-93`), a live run (`:134-137`), an unreadable `run.json`
(`:131-133`), and a different-bytes collision at the target (`:138-144`).
Symlinks are named, never followed (`:31-34`, warning at `:115`) because the
move must rename the folder.

Failure modes a confirmed move must still handle, none of which the planner
does today:

- **Consent records left behind.** The planner enumerates slug folders only
  (`src/engine/store-migration.ts:109-111`); `.owner-launches.json`,
  `.owner-amendments.json`, `.owner-decisions.json` and
  `.launch-approvals.json` (`src/server/app.ts:168-170,510-511`) sit beside
  them and would not move. A migrated project would silently lose pending forms.
- **Cross-device rename.** `rename(2)` fails `EXDEV` when the configured target
  is a mount point inside the project (allowed by `assertContained`,
  `src/engine/store-root.ts:85-99`); the copy-then-rename sequence must handle it.
- **Crash between copy and rename.** No journal or ledger entry exists yet; a
  restart must be able to tell "not started", "copied", "renamed".
- **Half-migrated state.** Config pointing at the canonical root while the
  guard (`src/server/app.ts:3846-3848`), tick gate
  (`src/engine/tick.ts:124`) and receipts still read legacy is the unsafe
  window — not a partial success.
- **Registry drift.** `Registry.rebuild` scans the legacy root only
  (`src/engine/registry.ts:92`), so "was this ever a goal here?" would answer
  from stale data after a move.

Rollback is cheap only if the source is never touched: copy, verify the digest,
rename into place, and keep the legacy folder until the owner confirms (the
shape proposed at `src/engine/store-migration.ts:1-7`). With that rule,
rollback is "point the config back at `.opencode/goals` and delete the verified
copy"; nothing in this branch deletes or rewrites legacy history.

## (f) What breaks for existing runs

With **no** override, nothing: the default resolves the exact legacy paths and
the compat suite proves run writes, status, inventory, ledger/evidence and
archive land where they always did (`test/unit/store-layout-compat.test.ts:51-114`).

After a default flip **before** T153 wires the surfaces above:

- `cleo-goal status --json` reads `store.slugs()` (`src/cli/status.ts:64`) over
  the canonical root and reports `status: "none"` for every existing run — CLEO
  stops seeing live goals.
- `ocg tick` returns immediately with "no `.opencode/goals` directory; nothing
  to tick" (`src/engine/tick.ts:124-126`), so dispatched turns stop.
- The write guard and shell detector no longer protect the active store
  (see (c)).
- Launch/amendment/decision receipts vanish from the engine's view
  (`src/server/app.ts:168-170`).
- The prompt tells the worker to read a path that does not exist and to avoid a
  path that is no longer the guard's target (`src/contract/render.ts:64,76,128`).
- Every turn's fingerprint changes, and `absent` checks can match the store's own
  bytes (`src/util/git.ts:7`; `src/verify/pipeline.ts:63`).
- Existing `.opencode/goals` runs are not adopted automatically
  (`test/unit/store-layout-compat.test.ts:116-122`); resume would need the T156
  surface decision.

## Recommendation

**Keep the resolved default at `.opencode/goals` and merge this branch as the
seam plus a read-only planner; make `.cleo/goals` the canonical target only in
the follow-up that routes every surface in (d) through `resolveStoreRoots()` /
`storePathKind()`, and read the override from one dedicated project file
(`.cleo/goal-store.json`) rather than from the OpenCode plugin config.**

Evidence: the only two `Store` construction sites already delegate to the
resolver (`src/server/app.ts:167`, `cli/ocg.ts:35`) while every other store
consumer hardcodes the legacy literal — the table in (d), plus the guard
(`src/server/app.ts:3846-3848,4374`) and the tick gate
(`src/engine/tick.ts:124`). A single dedicated file has exactly the readers the
code already has — engine, CLI and tick — whereas a plugin option would have to
be re-read from `.opencode/opencode.json` (`src/cli/install.ts:13`) by the CLI
and the tick, which never load OpenCode config. The planner is proven
non-writing by type and
by test (`dryRun: true, writes: 0`, `src/engine/store-migration.ts:68-78,149-159`;
9 planner tests in `test/unit/store-migration-plan.test.ts`), and the legacy
layout is pinned unchanged by the compat suite
(`test/unit/store-layout-compat.test.ts:51-114`). Checks on this head:
`bun run typecheck` clean (check:tui, check:cli, `tsc --noEmit`);
`bun test` over the 3 seam suites = 45 pass / 0 fail; over those plus the 5
store-consuming suites (`amendment`, `cli-contract`, `inventory`, `state`,
`status-harness`) = 71 pass / 0 fail.

## Questions only the owner can answer

1. **Where does the override live?** A dedicated project file
   `.cleo/goal-store.json` (one reader, harness-neutral — recommended), a
   plugin option `[<spec>, { goalStoreRoot: "…" }]` in
   `.opencode/opencode.json` (no new file, but the CLI and tick must learn to
   read OpenCode config), or an environment variable only (simplest, but not
   project state).
2. **When does the default flip?** In the same change as the T153 wiring (one
   release, 0.11.0), or one release later, after the override has been proven on
   this repository while the default stays legacy?
3. **Do the three existing goal folders move?** `.opencode/goals/`
   `{harness-identity, adapter-seam, agnostic-goal-store}` are owner-owned
   history. Migrate them under a dry-run-then-confirm move, or leave them
   readable and resumable at the legacy root indefinitely?
