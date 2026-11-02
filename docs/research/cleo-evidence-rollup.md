# CLEO evidence rollup: criteria → tasks → saga (T171)

Status: **implemented 2026-11-02** (branch `feat/T171-evidence-rollup`). This note records
what the contract can express, what the bridge writes, what the rollup reads, and the rules that keep
all three honest. It complements [cleo-goal-integration-proposal.md](cleo-goal-integration-proposal.md)
(the v0.5.0 per-gate evidence bridge).

## 1. The criterion → task map

A goal names the CLEO hierarchy it serves in one optional block (all fields optional except that the
block itself must be a mapping):

```yaml
cleo:
  saga: T001            # the saga the work rolls up into
  epics: [T166]         # the epics whose tasks this goal proves
  tasks:                # tasks whose acceptance criteria this goal can prove
    - id: T171
```

The precise binding lives on the criterion, never by position:

```yaml
criteria:
  - id: C1
    statement: src/engine/cleo-rollup.ts exists
    check: {kind: file, path: src/engine/cleo-rollup.ts}
    proves: ["T171#AC1"]        # this check's evidence proves T171 AC1
  - id: C2
    statement: the rollup tests pass
    check: {kind: command, run: "bun test test/unit/cleo-rollup.test.ts"}
    proves: ["T171#AC2"]
```

`proves` accepts the three `satisfies:` forms CLEO accepts (`T123#AC2`, `T123#<uuid>`,
`T123#AC2@<14-digit pin>`). Validation added for T171:

- **error** when a `proves` ref names a task `cleo.tasks` does not declare — the bridge only visits
  declared tasks, so such a binding could never be written. The rule applies only when the contract
  has a `cleo:` block, so a contract without one parses exactly as before.
- **warning** when a `proves` ref sits on a `diff`, `verifier` or `human` check: no gate's evidence
  can demonstrate it (`diff` passes when paths are UNCHANGED; a verdict is not implemented/testsPassed
  evidence), so the AC stays open and is reported.
- **warning** when the goal declares CLEO tasks and a gate-provable criterion declares no `proves` —
  its evidence would not be recorded anywhere.

The gate a criterion's evidence can prove is decided by the criterion's own check, in
`gateForCheck` (`src/contract/types.ts`): command with `typecheck`/`lint` → `qaPassed`, other command →
`testsPassed`, file/contains/absent → `implemented`.

The system block the worker reads renders the map in both directions: each criterion line carries
`proves CLEO: T171#AC1`, and the CLEO line reads `CLEO saga T001 · epics T166 — tasks this goal serves
(…): T171 (C1→AC1, C2→AC2)`.

## 2. One evidence write per (task, gate)

`runBridge` already recorded per-gate evidence and completed tasks through the `cleo` CLI only. T171
adds idempotency and a hard floor:

- It reads `cleo done --plan` (read-only) for the task's gates and AC map. A gate CLEO already reports
  passed whose every planned AC is already mapped is **reused**, not rewritten. A second
  `/goal cleo sync` therefore issues no duplicate `verify`; the bridge report says `reused: …`.
  A gate that is passed but still has an unmapped AC IS written again — dropping the `satisfies:`
  atom would lose the criterion link.
- `acsByGateFromProves` de-duplicates an AC cited by several criteria or plan steps.
- A plan with no gate write, no typed-gate run and no reused gate is **refused** (`no evidence atom to
  record … refusing to close a task without proof`); `cleo complete` is never called. The existing
  open-AC refusal stays: an AC no evidence proves is named and the task is not completed.
- Evidence still lives in exactly one place: CLEO's task record. The goal keeps its own host-check
  results (run state / evidence files) because those are a different claim, and no copy of CLEO's
  atoms is written into the goal.

The bridge runs automatically when verification passes at goal completion, and on demand via
`/goal cleo sync`. It never runs on a failed verification (nothing is proven) and never closes a task
on a red test report.

## 3. The read-only rollup

`src/engine/cleo-rollup.ts` answers "what is proven?" from CLEO's own records:

| node | reads |
|---|---|
| saga | `cleo saga members <saga>`, `cleo saga rollup <saga>`, `cleo show <saga>` |
| each epic (declared, else the saga's members) | `cleo show <epic>`, `cleo list --parent <epic> --full --limit 0` |
| declared tasks outside those epics | one `cleo show <ids> --full` |

Per task it copies the status **verbatim** and derives proof:

- `gates.{implemented,testsPassed,qaPassed}` from `verification.gates`; `proven` = all three hold
  evidence; `unprovenGates` names the rest.
- `acs.proven` counts the distinct `satisfies` evidence atoms; `acs.total` is the acceptance-row count
  (plus any alias cited by evidence); `acs.open` lists the unproven aliases.
- A `done` task with no `satisfies` atom is reported closed but with open ACs — no closure is
  reinterpreted as proof. (On the real board this is visible as `◐ T174 … (done) · gates 1/3`.)

Every failed read is listed verbatim in `unread`; the node is absent rather than zero. Nothing is
written: the only verbs are `show`, `list`, `saga members`, `saga rollup`.

Surfaces:

- `cleo-goal status --json` gains an optional additive `cleo` field (schemaVersion stays 1, like
  `harness`); the field is absent when the contract has no `cleo:` block, and no CLI is spawned then.
- `cleo-goal rollup [--json]` prints the full report for humans/machines.
- `/goal status` appends a compact summary when the live goal's contract names a CLEO scope.
- `/goal cleo rollup [<slug>]` prints the full report.

Sample (the real board at the time of writing, saga `T001`, declared epic `T166`):

```
saga T001 opencode-goal: goal mode for OpenCode 2 (pending) · CLEO 4/5 epics done (80%) · 3/8 tasks proven · 4 closed · AC 13/30
  epic T166 Autonomy, triage and orchestrated goal execution (pending) · 3/8 tasks proven · 4 closed · AC 13/30
    ✓ T167 Triage existing goals at kickoff (done) · gates 3/3 · AC 4/4
    · T168 Unified grill-me for new, continue and optimize (pending) · gates 0/3 · AC 0/4 · open AC1, AC2, AC3, AC4
    ◐ T174 Document the repo's CLEO evidence configuration so no agent rediscovers it (done) · gates 1/3 · AC 1/1
```

Reading a saga with no declared epics expands every member epic: 112 tasks in ~7 s on this repo, one
`show` + one `list` per epic. Declaring `cleo.epics` bounds that cost.

## 4. What is deliberately not claimed

- The rollup does not know a task's per-gate "required" flags (`cleo list --full` does not expose
  them), so `proven` means "all three standard gates hold evidence", and the gate list is shown.
- It never edits CLEO, never adds notes, and never maps ACs by position.
- Parent epics/sagas are not closed by this code: a saga is a rollup of its children, and CLEO owns
  that lifecycle.
