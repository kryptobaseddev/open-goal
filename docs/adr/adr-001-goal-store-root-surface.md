---
adr: adr-001-goal-store-root-surface
status: accepted
subject:
  - goal store
  - .cleo/goals
  - .opencode/goals
statement: New runs are created under .cleo/goals, and .opencode/goals stays readable and resumable
forbidden:
  - "created under .opencode/goals as the default"
  - "delete the legacy .opencode/goals store"
  - regex: '\b(?:goal )?store\b[^.\n]{0,40}\b(?:defaults?|defaulting|defaulted)\b[^.\n]{0,20}?\.opencode/goals'
  - regex: '\b(?:defaults?|defaulting|defaulted)\b[^.\n]{0,20}?\b(?:goal )?store\b[^.\n]{0,20}?\.opencode/goals'
  - regex: '\bnew runs? (?:are )?(?:created|stored|written) (?:in|under) `?\.opencode/goals`?\b'
---
# ADR-001 projection — the goal store root surface

Readable source for `docs/adr/decisions.json`, which `bun scripts/adr-guard.ts generate` compiles
and the contract validator reads. The canonical ADR is the CLEO document
`adr-001-goal-store-root-surface` (`cleo docs fetch adr-001-goal-store-root-surface`); this file
projects only what validation can compare, so it must be refreshed if that decision is amended.

An accepted decision read by validation is a warning, never a gate: a goal whose outcome or stop
rule contradicts it is flagged at review and can still launch if the owner decides the ADR should be
superseded.
