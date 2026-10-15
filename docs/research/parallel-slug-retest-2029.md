---
title: 'Parallel launch slugs re-tested on OpenCode 2.0.29'
audience: maintainer
status: draft
---
# Parallel launch slugs re-tested on OpenCode 2.0.29

## Result

The historical parallel-launch slug mix-up **did not reproduce** on the currently installed OpenCode. It is **not fixed**, because it has never been reproduced. It remains open as unconfirmed historical behaviour.

## What was tested

- OpenCode binary: `~/.opencode/bin/opencode --version` → `opencode v2.0.29` (`.tmp/verification/slug-2029/opencode-version.txt`). The host's own provenance in the raw evidence also reports `openCodeVersion: "2.0.29"`, server PID 39811 (an isolated test server, not the owner's).
- Oracle: the protected `test/host/lab-lifecycle-triage.test.ts`, unchanged since its baseline commit fdd365e, run with `OCGOAL_REPORTING_ORACLE=1`.
- Plugin under test: this working tree (`packageRoot` = the repository, `packageVersion` 0.3.15 plus the uncommitted-at-release T101 work). Slug correlation does not depend on the new recovery code.

| Test | Result |
|---|---|
| three already-live parallel refusals each name their own slug, matching sequential refusals | pass |
| parallel launch slugs survive model calls, host hooks and plugin entry independently | pass |
| form-applied amendment is never replayed by a subsequent resolve pass | pass |
| omitted identity is refused; a genuine resume resolves once and later review cannot replay it | pass |

4 pass, 0 fail. JUnit: `.tmp/verification/slug-2029/tests.xml` (SHA256 d555915c7d997041ec5d5085c0aeddaef1e4d1827e8855de89eda16016a8c9df).

Per-call boundary records (model request, `execute.before`/`after` hook, plugin entry, visible tool result) are in `.tmp/verification/slug-2029/raw/`:

- `parallel-launch.json` 843a8d9f96b9c46dccdb05ab67ebb19fb1ef7acecf519710775e8a7e89c6715c
- `parallel-all-live.json` 769129867056122547b39ee5675bc0468f58978111d32a1fa66c8920377c3a4b
- `applied-amendment.json` fa6158f24d06f77f9b19ad68375d168672791fd462bbe4d769671888e271ea92
- `identity-and-review.json` 5feed7a3cac11a2b8a17a5bc834875aeb972b67bd88d898f8ce1e65a228e195f

Every call kept its own input slug at every boundary, and each output named the same slug.

## Versions now covered and still missing

| OpenCode | Result | Source |
|---|---|---|
| 2.0.27 | mix-up reported by axiom-lab-dev with `explabs/glm-5.3-flash-abliterated` | peer report only; per-call IDs and boundary records missing |
| 2.0.28 | no mix-up (immutable v0.3.12 and v0.3.15) | `docs/research/lab-lifecycle-triage-t103.md` |
| 2.0.29 | no mix-up (this run) | this document |

The fixture provider is a scripted OpenAI-compatible model, not the GLM provider from the original report. A provider-specific tool-call ID collision on 2.0.27 can neither be ruled in nor out from these runs. No engine change was made for this item, and no runtime guard was added without a reproduction.