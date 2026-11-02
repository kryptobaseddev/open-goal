# goal/v1 field reference

The plugin's parser (`src/contract/parse.ts` in opencode-goal) is the source of truth; this mirrors it.

## Top level

| Field | Required | Notes |
|---|---|---|
| `schema` | yes | exactly `goal/v1` |
| `id` | yes | kebab-case slug, ≤64 chars, equals the directory name |
| `title` | yes | ≤80 chars recommended (sidebar) |
| `intent.verbatim` | yes | the owner's words, never rewritten |
| `outcome` | yes | one end state; warned if it reads as an activity or uses vague words without a number |
| `why` | no | |
| `scope.in` / `scope.out` | no | globs or plain descriptions |
| `non_goals` | yes (≥1) | |
| `constraints` | no | |
| `criteria` | yes (≥1 essential) | ids `C1…` |
| `cleo` | no | `tasks: [{id, acs?}]` — the CLEO tasks this goal serves; `acs` is legacy (declare `proves: ["T123#AC2"]` on a criterion instead) |
| `workstreams` | no | `{id, title, task, worker, done_when, gates?}` — see [Workstreams](#workstreams-t169); `task` must also be in `cleo.tasks`, `worker` is an explicit `agent@host` (wildcards are rejected) |
| `invariants` | no | ids `I1…`, host-checkable kinds only, always essential |
| `protect` | no | globs the worker may not edit; enforced before edits and re-checked at verification |
| `assumptions` | no | ids `A1…`; `status` assumed (default) / confirmed / vetoed |
| `plan` | no | ids `S1…`; `proves` must reference criteria; `depends_on` must reference steps; no cycles |
| `budget` | no | `turns` (int), `wall` ("90m", "3h", "1h30m"), `tokens` (400k, "3M"; spend across the run), `cost_usd`. Exactly these keys: any other key is an error, never a silent drop. With no `turns`, the run is capped by a 200-turn backstop that reports `backstop_limited`. |
| `stop.when`, `stop.escalate_when` | no | shown to the worker; escalation means `goal_block` |
| `autonomy` | no | `questions` defer (default) / allow · `on_user_message` steer (default) / pause · `on_interrupt` pause (default) / resume-on-message · `amend`: owner-set policy, a list of change classes the agent may apply to its own contract without asking — `timeout` (a check's timeout only), `budget`, `plan` (plan steps and assumptions), `recover` (adopt an in-policy out-of-band disk edit). Default `[]` = owner reviews every change. Criteria statements/checks, protect, scope, verification, stop rules and the policy itself are never agent-applicable. |
| `verification` | no | `mode` host / host+verifier (default) / strict · `max_rejections` 1-10 (default 3) · `read`: extra folders or files outside the project the verifier may READ (plain paths, relative to the project root; never writable; everything else outside the project stays denied) |
| `execution.agent` | no | informational in v0.1 |
| `meta` | no | free-form |

## Criterion

```yaml
- id: C1
  statement: WHEN … THE … SHALL …        # binary, specific
  essential: true                         # default true; optional criteria never block completion
  check: { kind: …, … }
```

| `check.kind` | Fields | Passes when |
|---|---|---|
| `command` | `run` (required), `expect.exit` (default 0), `expect.stdout_contains`, `expect.stdout_regex`, `timeout` seconds (default 300), `runs` (1-10, all must pass), `live` (re-run by the host after turns that changed files) | every run meets every expectation; runs in the owner's login shell at the project root |
| `file` | `path`, `exists` (default true) | the path exists (or not) |
| `contains` | `path`, `text` or `regex` | the file contains it |
| `absent` | `pattern` (extended regex), `paths` | `git grep` finds no match (goal state excluded) |
| `diff` | `paths` (globs) | none changed since the run started |
| `verifier` | `ask` | the read-only verifier answers proven with quotes the host finds verbatim in the files |
| `human` | `ask` | the owner approves it (`/goal approve C3`) |

## Workstreams (T169)

A goal can split its work across named workers. Each workstream maps to one CLEO
task under the goal's saga; the host sends a bounded brief over AgentMBX and
believes a return only when it carries the evidence atoms the task declared.

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
    gates: [implemented, testsPassed]   # optional; defaults to the task link's gates
```

Rules: `id` is unique kebab-case; `task` is already declared in `cleo.tasks`;
`worker` is an explicit `agent@host` (a wildcard is rejected, because the named
address is the owner's consent to send outward); `done_when` says what the
worker must return. A return is accepted only with the atoms its gates need
(`commit:` + `files:` for `implemented`, `test-run:` for `testsPassed`, `tool:`
for `qaPassed`) and `satisfies:<task>#<ac>` for every AC the task declares;
prose-only is rejected by name and recorded. One `goal_status` shows each
workstream and the aggregate, and a workstream never creates a second goal.

## Validator messages

Errors: wrong schema · bad or mismatched id · missing title / intent.verbatim / outcome · no non-goals · no criteria · no essential criterion · criterion id not `C<n>` · missing statement · missing or unknown check kind · missing kind fields (run, path, pattern, paths, ask, text|regex) · invalid regex · non-positive timeout · invariant with a non-host kind · duplicate ids · plan id not `S<n>` · unknown `proves`/`depends_on` · dependency cycle · bad budget values or unknown budget keys · bad autonomy / verification values · invalid YAML (with a hint for unquoted `: `).

Warnings: title over 80 chars · outcome reads as an activity · vague words without a number (outcome and statements) · no host-checkable essential criterion.
