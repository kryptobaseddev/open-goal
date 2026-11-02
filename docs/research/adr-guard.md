# Owner-approved contract memory (T180)

A goal must not silently contradict a decision the owner has already accepted. T175's second
failure mode is not a bad check or a broken host — it is a contract that validates cleanly and
quietly reintroduces something an ADR already settled (the store root, a default, a compatibility
rule). The owner then finds a live goal working against their own decision.

This is the guard that makes that visible at validation time without becoming a second oracle.

**What ships:** a warning from `parseContract` when the contract's `outcome` or a `stop` rule
contradicts an accepted ADR that names the same subject. It names the ADR slug and both statements,
never rewrites the contract, and is a warning — a contract that parses today keeps parsing.

This repository activates the guard for its one live accepted ADR:
`docs/adr/adr-001-goal-store-root-surface.md` compiles to `docs/adr/decisions.json`, so a goal whose
outcome or stop rule resurrects the legacy default is flagged at validation. The CLEO record stays
canonical; the markdown file is only the part of it validation can compare.

## The plugin stays CLEO-optional

ADRs live in CLEO (`cleo docs list --type adr`). The parser may not read `.cleo/cleo.db` or shell
out to the `cleo` CLI: that would make a goal engine a CLEO client, and a non-CLEO owner would lose
the guard entirely. So the parser reads one plain file the owner can inspect, diff and hand-write:

```
docs/adr/decisions.json      # project-relative, optional
```

`src/contract/adr-guard.ts` is the whole runtime surface (`loadAdrDecisions`, `adrContradiction`,
`adrIssues`). `src/contract/parse.ts` calls it once, after the contract has parsed far enough to
have an outcome and stop rules.

| Situation | Behaviour |
|---|---|
| No `docs/adr/decisions.json` | Exactly today's parse. One `stat`, no read, no warning (`loadAdrDecisions` returns `[]`). |
| Projection present but malformed | Ignored. JSON errors, bad slugs, unknown fields and invalid regexes are dropped — a hint file must never fail validation. |
| Projection present and matching | No new warning; the issue list is byte-identical to a parse with no projection. |
| Projection present and contradicting | **One warning** per contradicting field, naming the ADR slug and both statements. Never an error. |
| Contract already has an error | The guard does not run: an invalid contract is not reviewed for advice. |

`parseContract` accepts `projectRoot` (default: the process working directory, which is the project
being validated for the CLI and the tick) and `decisions` (an already-loaded list, used by tests and
by `scripts/adr-guard.ts check`). No server or engine call site changed.

## Projection format

`docs/adr/decisions.json` is compiled from checked-in markdown sources by
`bun scripts/adr-guard.ts generate`, but it is hand-editable: the format is deliberately small.

```json
{
  "version": 1,
  "decisions": [
    {
      "slug": "adr-001-goal-store-root-surface",
      "status": "accepted",
      "subject": "goal store",
      "statement": "New runs are created under .cleo/goals",
      "forbidden": [
        "created under .opencode/goals",
        { "regex": "\\bnew runs? (?:are )?(?:created|stored) (?:in|under) `?\\.opencode/goals`?\\b" }
      ]
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `slug` | yes | The ADR handle the warning names. `[a-z0-9][a-z0-9._-]*`; an invalid slug drops the entry. |
| `status` | no | Only `accepted` (or absent) is enforced. `proposed`, `superseded`, `rejected` are ignored, so a projection can carry the whole ADR set without enforcing drafts. |
| `subject` | yes | The phrase(s) that name the subject, matched as literal case-insensitive phrases on whitespace-normalised text. A list means "any of these names the subject"; each entry is still an exact phrase. `goal store` matches "the goal store root"; `store` alone does not match "goal-store". |
| `statement` | yes | The accepted decision, quoted back in the warning. It is the only thing matched for the negation flip. |
| `forbidden` | no | What the ADR itself declares contradictory. A string (or `{phrase}`) is **always** a literal phrase — never a regex. `{regex}` is compiled case-insensitively; an invalid one is ignored. |

Prose is not read: there is no field for "the general idea" and the guard never infers a
match from body text. If an ADR has no matchable decision, it gets no entry.

### Source format (optional)

The projection can be compiled from one markdown file per ADR, so the readable statement and the
machine projection cannot drift:

```markdown
---
adr: adr-001-goal-store-root-surface
status: accepted
subject: goal store
statement: New runs are created under .cleo/goals
forbidden:
  - "created under .opencode/goals"
  - regex: "\\bnew runs? are created\\b"
---
# ADR-001: the goal store root surface

Prose for people. It projects to nothing.
```

| Command | What it does |
|---|---|
| `bun scripts/adr-guard.ts generate` | Compile `docs/adr/*.md` → `docs/adr/decisions.json` (sorted by slug, deterministic bytes). |
| `bun scripts/adr-guard.ts generate --check` | Exit 1 when the projection is stale — suitable for CI. |
| `bun scripts/adr-guard.ts check <goal.yaml>` | Print the exact warnings validation would report for one goal, exit 0 (a warning is not a failure). |

No network, no CLEO CLI, no database. A malformed source (missing frontmatter, missing `subject`,
invalid regex, duplicate slug) is a **build** error here — the runtime loader stays silent, because
the failure modes are opposite: a broken build must not ship a silently incomplete guard, and a
broken hint file must never block a launch.

## The matching rule

A decision is enforced only when the contract text names its `subject`. Two routes then exist, and
nothing else does:

1. **Declared `forbidden` phrase/regex** (`src/contract/adr-guard.ts`, `adrContradiction`). The ADR
   states what contradicts it; the phrase is matched literally, the regex case-insensitively. This
   needs no inference at all and is the route to prefer.
2. **Negation flip on a shared statement**. Only when all of these hold:
   - the ADR's `subject` appears in the contract text;
   - the ADR `statement` and the contract text share a run of **three or more** words;
   - at least one shared word is 4+ characters and not a stop word;
   - the clause holding that run is negated on exactly one side.

   Example: ADR `New runs are created under .cleo/goals` vs outcome
   `New runs are not created under the goal store root` — shared `new runs are`, ADR clause positive,
   contract clause negated → one warning.

The warning quotes the ADR statement, the contradicting clause, and says the contract is not
rewritten. The parse result (`contract`) is the same object the text produced: no field is edited,
no outcome is reworded, no stop rule is dropped.

### False-positive guards

Zero false positives matter more than coverage, so every threshold is a deliberate refusal:

- **Subject gate** — no subject phrase in the text means no comparison. A decision with an empty or
  absent subject is dropped at load time.
- **Three-word minimum run** — two-word overlaps like "release is" are ordinary English; the
  "release is tagged from main" / "release is not blocked" pair stays silent by construction.
- **One content word** — a run of stop words ("the run shall") is not a shared statement.
- **Clause, not paragraph** — polarity is read inside a comma/semicolon/sentence-delimited clause, so
  an unrelated "must not exceed the budget" elsewhere in the sentence cannot make the subject look
  negated.
- **Explicit negation only** — `not`, `never`, `no`, `without`, `forbidden`, `prohibited`,
  `disallowed`, `deprecated`, `rejected`, `avoid`, `neither`, `nor`, `n't`. No sentiment, no
  "rather than", no "instead of" (the latter reads as a substitution and produced false positives on
  text that actually agreed).
- **Literal phrases** — a bare string in `forbidden` is never treated as a regex, so a phrase with a
  `.` cannot match more than it says.
- **Advisory input** — unknown keys, invalid regexes and malformed JSON are skipped, never raised.
- **One warning per (field, ADR)** — the first contradiction is reported; a text that trips both
  routes is not flooded.

## Activating it in a project

1. Write one `docs/adr/<slug>.md` per accepted decision the contract must respect (frontmatter
   above), or hand-write `docs/adr/decisions.json`.
2. `bun scripts/adr-guard.ts generate` (and commit the projection).
3. `bun scripts/adr-guard.ts check .opencode/goals/<slug>/goal.yaml` before launch; validation,
   `goal_validate` and the write-goal skill's self-check show the same warning.

Deleting the projection turns the guard off completely — no warning, no read. That is the intended
escape hatch for a project that has no ADRs yet.

## What it does not do

- It does not check criteria statements, `intent`, `non_goals` or `scope` — only the outcome and the
  stop rules, the two places where a goal states what it may conclude.
- It does not decide whether an ADR still applies; `status` is the owner's field, and superseding an
  ADR is an owner act, not a validation one.
- It does not block a launch. A contradiction is visible at review, and the owner may still accept
  it — the same posture as the D7 inverse-stop-rule warning.
- It does not read CLEO. Regenerating the projection from CLEO ADRs, if wanted, is a separate
  documentor step; the plugin never acquires a CLEO dependency.

## Tests

`test/unit/adr-guard.test.ts` covers the three required cases plus the guards:

| Case | Assertion |
|---|---|
| Contract matches the ADR (AC1) | Contract parses; zero ADR warnings; issue list identical to a parse with no projection. |
| Contract contradicts the outcome | Exactly one warning, `path: "outcome"`, names `adr-001-goal-store-root-surface`, the ADR statement and the contract clause; the contract's outcome is unchanged; no error. |
| Contract contradicts a stop rule | One warning per contradicting field (`stop.when`, `stop.escalate_when[0]`), never on unrelated stop text. |
| Projection absent | `loadAdrDecisions` → `[]`; issues, contract and lock identical to a `decisions: []` parse. |
| Projection malformed / non-accepted / invalid regex | Silently ignored, no throw, no error. |
| False positives | Unnamed subject, two-word overlap, single shared word, same polarity — all silent. |
| Live projection | The checked-in `docs/adr/decisions.json` is fresh against its source (`generate --check`), a matching goal is clean, and a goal that resurrects the legacy default warns once naming `adr-001-goal-store-root-surface`. |
| Script | Compile, deterministic bytes, `--check` staleness, `check <goal.yaml>` end-to-end, malformed source is an error. |
