# Interview: frontier rounds

## Modes (T168)

Call `goal_interview` before anything else. It returns one engine's answer for all three modes:

- **`new`** — nothing existing covers this work. Ask every open topic, then draft and `goal_prepare_launch`.
- **`continue`** — an existing goal (live, stopped, or draft) already covers this work. The contract is the draft: ask only the topics it does not answer, then resume/repair it. Never write a second contract.
- **`optimize`** — the owner wants to change an existing goal. Ask only the topics the change reopens, then stage `goal_propose_amendment({slug, expectedLock, yaml, rationale})`. Never write a second goal, never call `goal_prepare_launch`, never hand-edit `goal.yaml`; the bytes change only when the owner accepts.

The mode comes from the T167 triage (continue/repair → `continue`, consolidate → `optimize`, new → `new`) and/or an explicit owner choice. The tool refuses `optimize`/`continue` with no target, and refuses a requested `new` goal for work an existing goal covers. `duplicateRefused: true` means the owner must continue/optimize the named goal or choose genuinely different work.

## Protocol
1. After recon, call `goal_interview` and write every OPEN decision it returns as a node; note which decisions depend on which. Never turn a `resolved` decision into a question; if the owner's words contradict one, call the tool again with `contradicts`/`change.topics` so exactly that decision reopens.
2. A round asks the **frontier**: the decisions whose prerequisites are settled. One ask call, ≤4 questions, 2-4 options each, recommended option first with "(Recommended)", every option describing what happens and its trade-off.
3. After the answers, update the draft contract and `decisions.jsonl`, then compute the next frontier.
4. Stop when the frontier is empty: an implementer agent could run the contract without asking a single question.
5. Anything not worth the owner's time becomes an assumption: `{id, text, rationale, reversible}`.

`decisions.jsonl` line: `{"t":"2026-10-02T23:00:00Z","q":"What proves it is done?","options":["npm test exits 0","…"],"a":"npm test exits 0","by":"owner"}`

## Question skip table

An existing goal is asked a topic ONLY when its contract does not answer it (or the owner's change/contradiction reopens it). `goal_interview` computes this table; these are the exact fields it reads.

| Topic | Contract answer that skips the question |
|---|---|
| outcome | `outcome` |
| done-when | `criteria` (at least one) |
| evidence | an explicit `verification: {mode: …}` block |
| oracles | a non-empty `protect` list |
| invariants | `invariants` (at least one) |
| scope | a non-empty `non_goals` list |
| escalation | a non-empty `stop.escalate_when` list |
| budget | an explicit `budget:` block (opt-in; absent is not "missing") |
| autonomy | an explicit `autonomy:` block (opt-in; absent is not "missing") |
| priority | only asked while another goal is live; skipped by a `priority:` field |

A **fully specified** goal therefore asks nothing in `continue`; a goal with only outcome, criteria and non-goals asks evidence, oracles, invariants and escalation (and offers budget/autonomy). In `optimize`, the change reopens exactly the topics named in `change.topics` (e.g. `["done-when"]` when the change adds a criterion); everything else stays resolved. Contract errors mapped to a known key (criteria, protect, non_goals, stop, …) reopen that topic; errors no question can fix (id, title) are reported in `contractIssues`.

## Question bank (recommendation heuristics in brackets)

**Outcome** — "Which end state should be true when this goal finishes?" [the narrowest state that satisfies the owner's words; offer one broader and one narrower alternative]

**Done when** — "What proves it?" [existing commands from recon first: the failing test, the suite, the build, a bench; a new check only if none exists]

**Evidence standard** — "How strict is completion?" [host checks + independent verifier (Recommended) · host checks only (cheapest; semantic criteria need owner sign-off) · strict (verifier re-confirms host checks)]

**Oracles** — "Which files must the worker never change?" [the tests and benchmarks named in Done-when]

**Invariants** — "What must keep working the whole time?" [the full test suite, the build, typecheck]

**Scope / non-goals** — "Where may the work reach, and what is explicitly out?" [the module recon found; non-goal = the most tempting adjacent change]

**Escalation** — "When should it stop and ask instead of pushing on?" [irreversible data changes, public API changes, new dependencies, credentials]

**Budget** (only for open-ended goals) — "Cap the spend?" [no cap (Recommended for well-proven goals) · a token cap sized to the work · a wall-clock cap]

**Autonomy** — "If you type while it runs?" [steer: your message guides the next turn (Recommended) · pause]

**Priority** (ask only when the project already has a live goal — check the registry or `.opencode/goals/*/run.json` for a non-terminal run; a first goal needs no ordering) — "Where does this goal rank against the live one if you must choose where work goes first?" [medium (Recommended: the default lane) · high (first in /goal list, the palette and the start picker; taken ahead of the live goal) · low (lists last; the live goal keeps the attention) · skip (no field — sorts last by recency)]

## Launch question

Options, in this order: `Start goal now` (Recommended; the label must start with the exact text `goal_start` checks) · Start in a fresh session · Start clean (the engine opens a new session owned by the goal) · Save for later.
