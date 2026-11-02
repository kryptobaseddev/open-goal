# CLEO evidence in this repository

How a task in this project proves its gates, and the exact configuration that makes
`pr:` and `ci:` atoms resolvable here. Written after the T167/T172/T173 work, where
every one of these keys was discovered by hitting the error it removes.

Authoritative reference for the mechanisms: `cleo briefing inject --section evidence`.
This note only records what is specific to **this** project.

## The configuration

`.cleo/project-context.json` carries the whole thing:

```json
{
  "release": {
    "prRequiredWorkflows": [
      {
        "name": "Typecheck, unit tests, Node bin",
        "app": "github-actions",
        "workflow": ".github/workflows/ci.yml"
      }
    ]
  },
  "evidence": {
    "ciSatisfies": true,
    "ciChecks": {
      "tests": ["Typecheck, unit tests, Node bin"],
      "qa": ["Typecheck, unit tests, Node bin"],
      "jobs": {
        "tests": ["Typecheck, unit tests, Node bin"],
        "qa": ["Typecheck, unit tests, Node bin"]
      }
    }
  }
}
```

The default branch is not branch-protected, so CLEO has no required-check source of
its own. This file supplies it. The repository has exactly one gating job, `CI`
(`.github/workflows/ci.yml`), whose check run is named **Typecheck, unit tests, Node
bin**; it runs `bun run typecheck` (which includes the generated `dist/` freshness
checks), `bun test test/unit`, the scripted-harness host test, and the packed-bin
test on plain Node. Every merge in this repo waits for it.

Each key removes a specific refusal, in this order:

| key | without it |
|---|---|
| `release.prRequiredWorkflows` (pinned objects with `name`, `app`, `workflow`) | `pr:` atoms refuse with `E_EVIDENCE_INSUFFICIENT`: "Cannot determine the required checks for this repository (no required-check source…)". A bare string name is not enough — it must be pinned, or branch protection must exist. |
| `evidence.ciSatisfies: true` | `ci:<pr>` is refused for `testsPassed`/`qaPassed`. |
| `evidence.ciChecks.tests` / `.qa` | "ci:15 cannot attest qaPassed: set evidence.ciChecks.qa…". These are **arrays of check names**, not objects. |
| `evidence.ciChecks.jobs.tests` / `.qa` | "…set evidence.ciChecks.jobs.qa to the job names that must run". The job glob is matched against the job's display name, which is the same string as the check name here. |

## QA without a lint toolchain

Historically this project had **no linter**, and CLEO's `qaPassed` insists on a
result for every check that reads the changed paths — including `lint`. A receipt
cannot be fabricated, so the honest options were a real toolchain or CI proof.

Since T166 (PR #18) the repo has a real one: `bun run lint` → Biome 2.6.4
(`biome.json`), also run in CI. `qaPassed` may therefore use `tool:lint;tool:typecheck`
or `ci:<pr>`. For commits that predate it (the D9 work, `d60c771`), the only honest
route is the tool pair — `qa-run:` receipts recorded after those files changed
cannot stand in for an old merge.

## Test evidence

`testsPassed` accepts, in preference order:

1. `ci:<pr>` once the PR is merged and the merge commit's push run is green.
2. `tool:test-affected` — not configured here (`testing.affectedCommand` is unset).
3. A scoped `test-run:<report>` of the files the change touches.
4. `tool:test` — the whole suite; only for root-config changes.

Two traps in the scoped form:

- **Bun's JUnit report is not readable by CLEO.** `bun test --reporter=junit` nests
  `<testsuite>` inside `<testsuite>` (describe blocks), and CLEO requires exactly one
  level under `<testsuites>`. Either flatten the report mechanically (one suite per
  test file, real counts preserved) or write the summary shape
  `{"total":30,"passed":30,"failed":0,"skipped":0}`.
- **A summary carries no test files.** It proves counts, not coverage: CLEO refuses it
  when it must know which test files ran ("the test-run report lists no test files").
  Use the flattened JUnit form when the change spans source files.

A `qa-run:` receipt is the same idea for typecheck/lint:

```json
{"kind":"typecheck","command":["bun","run","typecheck"],"exitCode":0,
 "diagnostics":{"errors":0},"roots":["src","test"],"startTime":1793640000000}
```

`roots` must hold every changed code file, and the receipt must be recorded **after**
the last commit it describes — a receipt older than a commit touching its scope is
refused as stale.

## Practical sequence that works here

```bash
# after the PR merges and main's push run is green
cleo verify T### --gate implemented --evidence "pr:<n>;files:<all changed paths>;satisfies:T####AC1"
cleo verify T### --gate testsPassed --evidence "ci:<n>;satisfies:T####AC4"
cleo verify T### --gate qaPassed    --evidence "ci:<n>;satisfies:T####AC1"
cleo complete T###
```

`satisfies:` is one criterion per atom (`;` separated). `satisfies:T####AC1,AC2` is
parsed as a single malformed AC id and refused.
