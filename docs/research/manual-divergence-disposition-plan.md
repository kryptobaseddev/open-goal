---
title: 'Guarded disposition of manually divergent goal contracts: a read-only plan'
audience: maintainer
status: final
---

# Guarded disposition of manually divergent goal contracts — read-only plan

This plan edits **no** state. It records how a contract whose disk bytes diverged
from its lock is detected, the exact owner-review options, how the existing bytes
are preserved, and what is explicitly refused.

## What a divergence is

A live run's contract is **sha256-locked** when the run starts. Its authoritative
copy is the locked snapshot written at start:
`.opencode/goals/<slug>/evidence/<runId>/contract-<lock>.yaml`, and the run's
`run.json.lock` holds that hash.

A **manual divergence** is: `sha256(disk goal.yaml) !== run.json.lock` while the run
is live. The engine already detects it in `verifyClaim`
(`src/verify/pipeline.ts`: `lockOf(contractText) !== state.lock`) and in the
amendment stager; since v0.4.0 `goal_recover_divergence` is the supported resolver.

A divergent contract is **not** the same as a pending amendment: a pending proposal
is an unapplied next generation; a divergence is bytes that changed *outside* the
engine. Byte-equality between the disk and a proposal's `nextLock` proves the
desired content only — never that the engine accepted it.

## Detection (read-only)

1. Read `run.json.lock` and hash the on-disk `goal.yaml`.
2. If they differ, read the locked snapshot under `evidence/<runId>/` and diff it
   against the disk bytes (the diff the owner is shown).
3. Record last-writer provenance where available (a pending amendment whose
   `nextLock` matches the disk bytes is shown as "no commit: never accepted", never
   as consent).

None of this writes anything.

## Owner-review options (the only supported dispositions)

`goal_recover_divergence { slug, expectedLock }`, from any live session of the
project, offers exactly three:

| Option | What it does | Reversible? |
|---|---|---|
| **Adopt disk version** | The disk bytes become a new **journalled generation**; changed criteria reset; the run stays paused. | Yes — a further recovery can restore. |
| **Restore locked version** | The locked bytes are written back; the **divergent bytes are preserved under `evidence/`**. | Yes — the adopted bytes are kept. |
| **Leave unchanged** | Nothing is written; the run stays paused. | N/A. |

An **unaccepted** proposal is superseded by the owner's pick; it is never counted as
consent. A proposal whose text matches the disk bytes is **evidence, not consent**.

## Preservation of the existing bytes

- On **Restore**, the divergent bytes are kept as evidence under the run's
  `evidence/<runId>/` folder before the locked bytes are written back.
- On **Adopt**, the previous locked generation remains in the ledger and its
  snapshot stays on disk, so the prior lock is reconstructable.
- A corrupt `run.json` (not a contract divergence) is handled separately: the raw
  bytes are kept as `run.json.corrupt-<ts>.json` and the run is rebuilt from its own
  ledger `start` event and locked snapshot, or refused `run-state-unprovable`.

## Explicitly refused

- **Hand-editing a lock**, `run.json`, a receipt or the ledger to "fix" a
  divergence. Run state changes only through the supported tools.
- **Blessing a noncanonical `resolved` state** — a peer-reported or manually edited
  `resolved` marker is not engine acceptance; a pending proposal stays pending until
  the owner's actual pick.
- **Editing another project's goal folder.** Recovery is offered only from a live
  session of *that* project; a foreign session cannot adopt or restore it.
- **Manual rollback, lock moves, or retiring a pending review as accepted.** Only an
  applied, journalled generation retires conflicting unanswered proposals.
- **Treating an owner message, a peer message or a form reply as replayable
  consent.** Consent is fetched from the host's own session history and consumed once.

## Read-only guarantee

Writing this plan changed no contract, lock, receipt, ledger, evidence file or any
project's goal folder. It is a plan: the dispositions it names are the existing,
supported operations, described so an owner can review them before acting on a real
divergence.
