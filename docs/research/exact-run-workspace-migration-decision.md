---
title: 'Exact-run workspace and protected-oracle migration: reviewed disposition'
audience: maintainer
status: final
---

# Exact-run workspace and protected-oracle migration — reviewed disposition

## The problem

A goal run's host checks, protected-oracle guard and progress fingerprint all
resolve against **one** root: `GoalApp` binds `this.root = ctx.location.directory`
(`src/server/app.ts:142`), `verifyClaim` runs every host check against that root
(`src/verify/pipeline.ts:149`), the protect guard compares
`changedSince(root, state.base.commit)` filtered by `matchesAny(f, contract.protect)`
(`pipeline.ts:131`), and progress is `fingerprint(this.root)`.

When a run's *code* lives in a **linked git worktree** (`.worktrees/<slug>`) while
`ctx.location.directory` is the shared checkout, that single binding is wrong in
two ways:

1. **Every check must be manually re-based.** A `command` check that should run in
   the worktree has to embed `cd .worktrees/<slug> && …`; the engine does not know
   the check's real execution directory.
2. **Protected oracles are not actually guarded.** A `protect` entry that names a
   worktree-relative path is compared against the **root** tree's changes, so an
   edit to the protected file *inside the worktree* is invisible to the guard —
   the oracle appears untouched while it was changed.

## The scoped evidence

The disposition is based on one real, read-only case (no project state was
touched by this study):

**`/Users/keatonhoskins/projects/VidaPeps/.opencode/goals/demand-driven-replenishment-receiving/`**
(run base commit `89e0d4943ddbe1b4dd428266aee576a5a23d2e14`, status running).

- Its `constraints[1]` states the workaround verbatim: *"Every check runs inside
  that worktree with an explicit cd prefix, because the goal engine fingerprints
  the shared project root and the shared checkout carries other sessions dirty
  files."*
- Its **7 `command` checks each carry** `cd .worktrees/demand-replenishment-receiving`.
- Its `protect` list names **6 worktree-relative paths**
  (`apps/api-server/src/lib/procurement-math.test.ts`,
  `apps/api-server/src/lib/batch-allocation.ts`, `coa-eligibility.ts`, …).

The engine's own code (above) confirms both mechanisms are root-relative, so the
VidaPeps protect list currently guards files the guard cannot see in the worktree.

## Candidate dispositions

| # | Disposition | Trade-off |
|---|---|---|
| A | **Status quo + document.** Keep the root binding; contracts embed `cd` and accept that worktree protect paths are not guarded. | No engine change, but it is exactly the hole the VidaPeps contract documents; the guard silently under-covers. |
| B | **Explicit contract field `workspace`.** An optional, root-relative path that names the run's execution workspace; the host resolves the host-check root, the protect/diff base and the fingerprint against it. Default `"."` = today's behaviour. | Small, explicit, backward-compatible; the contract author states intent instead of hiding it in every command. |
| C | **Auto-detect** a linked worktree containing the run and bind to it implicitly. | Convenient, but magic: it changes guard semantics without a contract statement, and "which worktree" is ambiguous when several exist. |
| D | **Refuse** any contract whose `protect`/`command` paths fall outside the bound root. | Safest, but rejects the legitimate worktree layout entirely and forces every such goal to be rewritten. |

## The chosen disposition — B (explicit `workspace`, default root)

The contract gains an optional `workspace` (a plain, root-relative directory).
When set, the host resolves **one** execution root = `resolve(projectRoot, workspace)`
and uses it for host checks, the protect/diff base and the fingerprint. When it is
unset the execution root is the project root, i.e. **exactly today's behaviour**.

Validation at parse/start, so a bad binding fails loudly rather than silently
under-guarding:

- the workspace must be inside the project root (no `..`, no absolute path);
- it must be a git work tree (`isRepo`), because checks, protect and the
  fingerprint all depend on git;
- an invalid workspace is a **contract error**, never a silent fallback.

`.opencode/goals/**` resolution stays at the **project root** — only the
execution root moves — so a run's contract, ledger and evidence keep living in the
project's goal folder.

The **migration** of an already-running goal is deliberately **not performed** here:
an existing run keeps its locked contract, its lock and its base commit. Adopting a
workspace is an owner action on a *new* run (or an owner-approved amendment), not a
retro-fit of a live ledger.

## Reversibility

- `workspace` is optional; omitting it restores the current root binding byte-for-byte.
- The field is additive to the contract schema; no existing contract changes meaning.
- Rolling back the shipped binding means deleting the field from a contract — no
  run state, ledger or lock is rewritten.

## Residual risk (what this does not fix)

1. **Existing runs keep the root binding.** v0.4.9 cannot retro-fit a live run; its
   protect list stays under-covered until the owner starts a new run or amends.
2. **A linked worktree shares the object store.** `changedSince` inside the
   workspace sees that worktree's `HEAD` and working diff, which is the right tree,
   but a commit made in *another* worktree or the root is still invisible to the
   workspace's diff — the fingerprint still includes all worktree HEADs (v0.4.6),
   so progress is seen even if `protect` is scoped to one workspace.
3. **Non-git workspaces are refused**, so a plain (non-worktree) subdirectory cannot
   be bound even if a check would want it.
4. **A `command` check may still `cd` elsewhere**; the binding cannot police what a
   command does inside its own shell. The binding fixes *where the check starts and
   what protect/fingerprint see*, not the command's internal `cd`.

## No project state was edited

This decision is written from **read-only** inspection. No file under any other
project's goal folder was created, modified or deleted, no goal state or lock was
touched, and no workspace or oracle migration was performed. The VidaPeps case is
cited as evidence only.
