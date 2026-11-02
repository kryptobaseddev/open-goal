# Declared workstreams (T169)

One goal, several CLEO tasks, named workers. A contract may declare
`workstreams`; the host sends each one a bounded brief over AgentMBX and believes
a return only when it carries the evidence atoms the task declared. Code:
[`src/engine/workstreams.ts`](../../src/engine/workstreams.ts) (pure),
[`src/contract/parse.ts`](../../src/contract/parse.ts) (validation),
[`src/server/app.ts`](../../src/server/app.ts) (dispatch, returns, status).

## The declaration

```yaml
cleo:
  tasks:
    - id: T169
      acs: {implemented: [AC1], testsPassed: [AC2]}
workstreams:
  - id: engine
    title: the engine work
    task: T169
    worker: builder@macbook
    done_when: T169 evidence is returned with atoms
    gates: [implemented, testsPassed]
```

- `id` — unique kebab-case handle inside the goal.
- `task` — a CLEO task id that is already declared in `cleo.tasks`, so the
  saga mapping lives in one place.
- `worker` — an explicit `agent@host` address. Wildcards are rejected on
  purpose: the address written in the contract is the owner's consent to send
  outward, and a goal can never broadcast work nobody agreed to receive.
- `done_when` — what the worker must return, in words the owner can check.
- `gates` — optional; defaults to the gates the task link declares through
  `acs`. Effective gates determine which atoms a return needs.

The block is optional and additive. A contract without `workstreams` behaves
exactly as before: no dispatch, no polling, no status rows.

## Dispatch

On kickoff (and on resume) the host sends every workstream still `pending` one
bounded brief (~1 KB) to its named worker, with the goal, outcome, task,
`done_when`, gates and the exact `satisfies:` refs. The send is journalled as
`workstream-dispatch` with the message id; a failure is `workstream-dispatch-failed`
and leaves the workstream pending with the reason. Only one dispatch per
workstream is in flight, even when several admissions race.

## Acceptance

A worker's reply is matched to its workstream by sender and task id (or by the
dispatch message id), then judged by the pure `validateReturn`:

- **prose-only is rejected by name** — no `commit:`/`files:`/`test-run:`/`tool:`
  atom means no proof, and the ledger records the reason;
- every AC the task declares must appear as `satisfies:<task>#<ac>`;
- every gate the workstream owns must carry its atom (`implemented` needs
  `commit:` + `files:`, `testsPassed` needs `test-run:`, `qaPassed` needs
  `tool:`).

A rejected workstream may be re-judged by a *newer* return (a corrected one), but
an older message can never overwrite a verdict. Consumed returns are not turned
into next-work candidates; they belong to this goal.

## Status

`goal_status` (and `cleo-goal status --json`, additively, schemaVersion 1) shows
one row per workstream — id, title, task, worker, `done_when`, status and the
rejection reason — plus an aggregate `{total, accepted, rejected, pending,
proven}`. The goal count does not change: a workstream updates the run it belongs
to and never creates a second goal.

## What it does not do

- No automatic re-dispatch after a rejection; the owner sees the reason and can
  amend the contract or ask the worker again.
- No wildcard or broadcast: an address is required per workstream.
- No model call in the pure layer, and no network in the tests: the host test
  uses a scripted `agentmbx` on PATH.
- Watching is bounded (120 polls at the configured interval) so an unanswered
  workstream cannot keep the process polling forever.

## Proof

- `bun test test/unit/workstreams.test.ts` — parse/validation, plan, brief,
  prose-only rejection, missing AC/gate rejection, a complete return accepted,
  and the aggregate.
- `bun test test/host/workstreams.test.ts` — a declared workstream is dispatched
  once to its named worker, a prose-only return is rejected by name, a return
  with the declared atoms is accepted, the run carries the verdict, and the
  project still holds exactly one goal.
