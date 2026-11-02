# Recon — cleo-first-class-integration

Facts only (no decisions). Captured 2026-10-16, HEAD `3796c18` = v0.4.9, `package.json` 0.4.9.

## The owner's words (seed)
> you MUST build into opencode-goal (OCG) the first class citizen functionality of CLEO to make sure IF cleo is installed, or even if not during install of OCG or health checks with OCG on install/update to check for cleo install and existence in the running project, and this issue you just experienced where this project and this system uses CLEO as the backbone for project management, if CLEO is installed or even OCG can offer to install CLEO if not or setup in the project. Making sure if cleo is active that engaged cleo tasking is directly integrated to OCG so trackign adn completign tasks in CLEO. this may need coordination with the cleocode dev via mbx to make sure that our OCG goal evidence and work we do in the criteria can be used for completed goals or even multiple tasks that may be in a single goal to allow for the AC signoff and a more integrated approach with CLEO . keep in mind some users may NEVER use CLEO with OCG but making cleo a first class aspect to OCG is very important so we are not duplicating work needs and can help really integrate and maybe even improve CLEO's systems taking the very overengineered cleo RCASD IVTR process cleo has and integrating goal better with it

## What OCG does with CLEO today (T027 baseline)
- `src/engine/cleo-link.ts` — `cleoFacts(projectRoot, run, timeoutMs=2500)`: spawns `cleo doctor project-identity` (authoritative), falls back to reading `.cleo/project-context.json`, else `undefined`. Never throws. Returns `{source: "cli"|"config", projectId?, projectTypes[], detectedAt?}`. Pure detection; no install, no health report, no task access.
- `src/server/app.ts`
  - L33-38 `defaultRunner` spawns a CLI with a hard timeout.
  - L515 passes `cleo: await cleoFacts(...)` into a status assembly.
  - L1672-1674 records a `cleo-linked` ledger event at goal start (`cleoLinkEvent`).
  - L2249 the completion decision receives `cleoPresent`.
  - L2514-2535 the `decompose` act: refuses with "install CLEO first" when absent; otherwise dispatches an agent prompt telling the next turn to `cleo add` the follow-ups. Task *creation* only, by the model, not by the engine.
- `src/summary/build.ts` L84-112 — a "Decompose long-running work with CLEO" follow-up line, and an install *suggestion* when no `.cleo` workspace.
- `src/server/messages.ts` L192-205 — completion decision rows: "Decompose with CLEO" (act) when present; "Install CLEO for tracking" (guidance text only) when absent.

So today CLEO is **detected and advertised**, never **installed, health-checked, or written to** by the engine.

## What is absent (the owner's ask)
1. No install/update/health-check surface: nothing probes for the `cleo` CLI or the project's `.cleo` at plugin load; nothing offers install/init.
2. No goal↔CLEO task linkage: a contract cannot name the CLEO tasks it serves.
3. No evidence/AC bridge: proven goal criteria are never turned into CLEO AC evidence, and no CLEO task is completed from a goal.
4. No multi-task-per-goal handling.
5. No coordination with the CLEO maintainers.

## Surfaces available to build on
- Plugin entry `src/server/index.ts` — `setup(ctx)` runs on load (can run repeatedly for a location; must dispose in `stop()`). `ctx.location.directory` is the project root.
- `/goal` subcommands are registered in `src/server/app.ts` (`registerCommand`) and documented by the pure builder `src/server/help.ts` (pinned by `test/unit/*` so help cannot drift).
- Contract schema `src/contract/types.ts` has `meta: Record<string, unknown>` and typed blocks (`workspace`, `verification`, `autonomy`); a new optional CLEO block would be a schema addition with parser + validator + render coverage.
- Test harness `test/host/harness.ts` boots an isolated `opencode serve` with a temp HOME/XDG; 85 host test files. `test/unit/cleo-link.test.ts` and `test/host/decompose-act.test.ts` already pin the current behaviour.

## CLEO state in THIS project (the referenced case)
- `cleo doctor project-identity` → exit 0, `projectId` `5f4ab735-ef8e-4c8b-8d64-1eb3021ed2ff` (trackedId == manifestId).
- `.cleo/` exists with `config.json`, `project-context.json`, `project.json`, `docs-publications.json`, `section-leases.json`.
- Epic T002 holds the project's tasks; ~4 remain `pending` (T080, T081, T082, T102) after the closure pass.

## The CLEO gate mechanics observed while closing tasks (evidence for the bridge design)
- `cleo verify <id> --gate implemented --evidence "commit:<sha>;files:<paths>;satisfies:<id>#AC<n>"`.
- `testsPassed` needs a real JSON report (`test-run:<json>`, vitest-shaped) covering **every** test file the change adds/edits; bun only emits JUnit, so a faithful convert step is required.
- `qaPassed` accepts `tool:typecheck` (cached per tree).
- Multi-AC tasks need one `satisfies:<id>#AC<n>` **per gate** (spread: AC1→implemented, AC2→testsPassed, AC3→qaPassed).
- Legacy tasks whose acceptance uses the `{req: "REQ-…"}` form have **no AC rows** and a typed gate that `satisfies:` cannot link (`satisfies:` only accepts `<task>#<ac>`); `cleo done --run-typed` caches a pass but persists no verification → `complete` reports `verification.passed=false`.
- `cleo verify --run` executes cached typed gates but persists nothing.
- Commands may not be piped through `jq`/`tail`; use `--field`/`--output`/`--quiet`.

## Release loop (project rule)
`bun install` (dev only; plugin has no runtime deps) → `bun test` (unit + host + e2e, ~30 s) → `bun run typecheck` → bump `package.json` + `CHANGELOG.md` → commit `type(T###): summary` → `git tag -a vX.Y.Z` → `git push origin main --follow-tags` → git-install test against the tag → `opencode plugin remove/add` + reload. The owner's OpenCode runs the **installed tag**, so a goal that ships a new engine must reinstall before its completing verifier round.

## Working tree
Clean except untracked `.opencode/goals/*` run folders. No live goal. No unread mailbox.
