# T170 — owner-set autonomy levels

Status: shipped with the `autonomy.level` contract field (default unchanged).

## The problem

open-goal already removed most routine pauses, but it removed them **by
accident of defaults**: `questions: defer`, `on_stall: pause`, `amend: []`,
`on_interrupt: pause` were independent booleans, and an owner who wanted "no
routine pauses" had to know which combination to write. There was no single,
nameable, bounded answer to "how much needs asking?".

## The field

```yaml
autonomy:
  level: standard          # conservative | standard | full
```

`level` is a **ceiling**, never a grant:

- Absent ⇒ today's behaviour exactly (`on_stall: pause`, `amend: []`, …). No
  existing contract changes, and no locked generation re-locks because of this
  work.
- An explicit flag may **narrow** the level (`level: standard` +
  `on_stall: pause` pauses a stall).
- An explicit flag can **never widen** it (`level: conservative` +
  `amend: [timeout]` grants nothing; the drop is reported as a warning).
- Changing `level` (or any other autonomy field) is classified as a policy
  change and is **always owner-only** — `classifyChange` blocks it and
  `policyAllows` refuses it even with every change class granted.

| level | `on_stall` | agent-applicable classes (`amend`) | meaning |
|---|---|---|---|
| `conservative` | `pause` | `[]` | today's defaults, named |
| `standard` | `continue` | `timeout`, `recover` | no routine pauses; only reversible routine changes are applied by the agent |
| `full` | `continue` | `timeout`, `budget`, `plan`, `recover` | standard plus budget/plan additions the contract itself permits |

Criteria, criteria checks, invariants, `protect`, `scope`, `verification` and
the policy itself are **not change classes** at any level. They are not
representable in `amend`, so no level can delegate them.

## What each level does *not* touch (T170 AC3)

The safety stops live in `src/engine/loop-stop.ts` and in code guards, not in
policy flags. A level cannot reach them:

| Stop | Where it is enforced | Test |
|---|---|---|
| a human criterion | `verify()` → `needs_review` + native sign-off form | `test/host/autonomy-level.test.ts` ("human criterion"), `test/host/criterion-approval.test.ts` |
| a real blocker | `goal_block` × `blockerRepeats` → `blocked` + decision | `test/host/autonomy-level.test.ts` ("real blocker") |
| a contract change outside the policy | `classifyChange`/`policyAllows` → owner review | `test/host/autonomy-level.test.ts` ("out-of-policy contract change"), `test/host/autonomy-policy.test.ts` |
| a protected oracle / contract edit | tool hook refuses `protect` globs and `.opencode/goals/**` | `test/host/conversational-amend.test.ts`, `test/host/autonomy-policy.test.ts` |
| an outward/destructive act | `loopStop()` → `outward`; the harness's own permission prompts are never overridden by the plugin | `test/unit/autonomy-level.test.ts` (every level), `test/unit/loop-stop-rules.test.ts` |
| an exhausted budget / first visit to a new project | `loopStop()`; waived only by their own explicit flags (`continue_past_budget`, `visit_new_projects`), never inferred from a level | `test/unit/loop-stop-rules.test.ts` |

The outward row is deliberately engine-level: a goal run does not classify
shell commands, so an outward act is stopped by (a) the contract's
`stop.escalate_when` / `goal_block`, and (b) OpenCode's permission prompts,
which the plugin leaves intact for the worker. `autonomy.level` grants no
permission: the plugin's only permission transforms are the verifier child's
deny-all rules.

## What each level removes (T170 AC2)

| No-pause case | Mechanism | Test |
|---|---|---|
| clean restart | `restartDecision` resumes an intact run with an unchanged lock; no owner decision | `test/host/restart-continuity.test.ts` (legacy), `test/host/autonomy-level.test.ts` (`level: standard`) |
| accepted amendment | the acceptance act applies the new generation and resumes the same run | `test/host/amendment-continuity.test.ts` (already shipped; not duplicated) |
| verifier retry | an empty verifier round is retried once and the verdict lands on round 2; a rejected claim re-admits with the verdict | `test/host/verifier-empty-response.test.ts`, `test/host/verifier-reliability.test.ts` |
| stalled-but-active run | `decide()` continues when `onStall === "continue"` and journals a `stall-report` | `test/unit/loop-decision.test.ts`, `test/host/stall-activity-and-policy.test.ts`, `test/host/autonomy-level.test.ts` |

`on_stall` keeps its `pause` default for contracts without a level, so nothing
changes for an existing run. The pause notice already names the setting and
the choices (`test/host/stall-notice-policy.test.ts`).

## Where it lives

- `src/contract/types.ts` — `AutonomyLevel`, `AUTONOMY_LEVELS`,
  `AUTONOMY_LEVEL_POLICY`, `Autonomy.level`.
- `src/contract/parse.ts` — expands the level into `on_stall`/`amend` with the
  narrow-only rule and names any narrowing as a warning.
- `src/contract/render.ts` — a single byte-stable line in the contract block
  when a level is set (absent for legacy contracts).
- `src/engine/continue-work.ts` — a continuation contract carries the owner's
  level, so the next goal inherits the same ceiling.
- `src/engine/policy.ts` — unchanged: the whole `autonomy` object is already
  policy-owned, so `level` is owner-only by construction.
- `src/engine/loop-stop.ts` — unchanged: the safety stops are independent of
  policy.

## Known limits

- Level selection is contract-only in this change. The `write-goal` interview
  and the bundled skill are outside T170's file scope, so the level is
  documented in the contract schema here and in the rendered contract block,
  but the interview does not yet ask for it.
- `level: full` still does **not** waive the budget or new-project stops; those
  keep their own explicit flags. A level is a behavioural bundle, not a blanket
  waiver, and inferring a waiver would violate the existing rule that those two
  stops are waived explicitly.
