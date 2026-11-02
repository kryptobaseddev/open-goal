// T025 — the /goal help surface: one pure builder producing an agent-forward
// guide (commands with arguments, the worker/owner permission split, storage
// layout, mid-run rules). Rendered by /goal help and pinned by a unit test so
// it cannot drift from the engine's real semantics.
//
// T187: the storage section names the store THIS project resolved, passed in
// by the caller from `resolveStoreRoots`. The legacy path is named only to keep
// history distinct from the active store; neither path is derived here.

export type HelpFacts = {
  version: string
  /** The resolved active store, project-relative POSIX (e.g. `.cleo/goals`). */
  goalsRel: string
  /** The archive that sits beside the active store. */
  archiveRel: string
  /** The readable legacy store, named only when it is not the active one. */
  legacyGoalsRel?: string
  legacyArchiveRel?: string
}

export function goalHelp({ version, goalsRel, archiveRel, legacyGoalsRel, legacyArchiveRel }: HelpFacts): string {
  const legacy = legacyGoalsRel && legacyGoalsRel !== goalsRel ? legacyGoalsRel : undefined
  const legacyArchive = legacyArchiveRel && legacyArchiveRel !== archiveRel ? legacyArchiveRel : undefined
  return [
    `# open-goal ${version} — the goal loop, for agents and owners`,
    "",
    "## Commands (owner)",
    "- `/goal new <what you want done>` — the write-goal interview (skill attached; similar-goal probe runs first)",
    "- `/goal start <slug> [acknowledge-supersede]` — rehearse every command check, then lock and run",
    "- `/goal status` · `/goal pause` · `/goal resume` · `/goal verify` — status costs no model turn",
    "- `/goal abort` — end the run for good (ledger and evidence stay)",
    "- `/goal amend [confirm]` — propose/confirm a contract re-lock after editing goal.yaml out of band",
    "- `/goal rebase [<commit>]` — owner-only: move the run's baseline to a commit (default HEAD) so a merged oracle update no longer trips INTEGRITY; the contract, its lock and its protect list stay unchanged, and changes after the new commit are still caught",
    `- \`/goal archive\` — demote a finished goal to ${archiveRel}/ (never deleted)`,
    `- \`/goal migrate [confirm]\` — plan (dry run) or, after the native owner confirmation, copy finished goals from the legacy ${legacyGoalsRel ?? goalsRel}/ into ${goalsRel}/; the legacy copy is kept and live runs are skipped`,
    "- `/goal approve <C#>` · `/goal reject <C#> <why>` — owner sign-off for human criteria",
    "- `/goal validate <slug>` · `/goal list [all]` — validate a contract; list live (or +archived) goals",
    "- `/goal reload` — after a plugin hot-load: re-announce the tool/command surface and mirror disk runs into this server; writes nothing and resumes nothing",
    "- `/goal cleo [install|init|sync|rollup]` — probe the CLEO CLI and this project's .cleo workspace (initialized / uninitialized / CLI absent); `install` and `init` run the exact documented command only on your explicit choice, never silently and never with sudo; `sync` writes per-gate evidence through the CLI; `rollup` shows proven vs unproven saga/epic work read-only",
    "",
    "## Worker tools (the agent in the loop)",
    "- `goal_progress` — record the step you are on, one line of change, the next action",
    "- `goal_claim` — claim completion with evidence per criterion; the HOST then verifies you",
    "- `goal_block` — stop for an owner-only blocker (missing credential, decision)",
    "- `goal_flag` — flag a criterion that is contradictory, impossible or unsafe as written",
    "- `goal_wait <seconds>` — pause cheaply while an external process runs",
    "- `goal_status` / `goal_validate` — read-only checks",
    "- `goal_migrate` — read-only store-migration plan; the move itself needs a native owner confirmation, never a worker call",
    "- `goal_verdict` — reserved for the read-only verifier child; never available to the worker",
    "",
    "All `goal_*` tools are called **directly by name** — they are not registered with Code Mode, so `search()`/`tools.*` inside `execute` will never find them (a routing attempt returns an unrelated Unknown-tool error).",
    "",
    "## Storage layout (per project)",
    `- \`${goalsRel}/<slug>/goal.yaml\` — the locked contract (sha256)`,
    `- \`${goalsRel}/<slug>/run.json\` — live run state; \`ledger.jsonl\` — every event, append-only`,
    `- \`${goalsRel}/<slug>/evidence/<runId>/\` — locked contract copy, rehearsal baseline, verify results, verifier transcripts, amendment records`,
    `- \`${archiveRel}/<slug>/\` — demoted goals; the machine registry still answers "was this ever a goal here?"`,
    ...(legacy
      ? [`- \`${legacy}/\`${legacyArchive ? ` and \`${legacyArchive}/\`` : ""} — the readable legacy store; /goal migrate copies finished goals into the active store and keeps this one intact`]
      : []),
    "",
    "## Mid-run rules (the contract is enforced, not advice)",
    "- The contract is rendered into every request; compaction cannot lose it.",
    `- Never edit \`${goalsRel}/**\`${legacy ? ` or the legacy \`${legacy}/**\`` : ""} while a goal exists — the write guard blocks it, running or stopped.`,
    "- Completion is proven, not declared: host checks run first, then an independent verifier child whose quotes are re-read. A rejected claim returns a HOST VERDICT turn — read it, fix the work, claim again.",
    "- Questions are deferred during a run: make the reversible choice, note it in goal_progress, or call goal_block.",
    "- Command checks live on ONE line and are rehearsed at start; a check that cannot run refuses the lock.",
    "- Supersession replaces a goal: `supersedes: <slug>@<lock>` in the new contract; live predecessors need your explicit acknowledgment.",
    "- Describe changes in the Composer; goal_propose_amendment stages an exact diff, then goal_resolve_amendment binds genuine owner chat once. No sidebar Accept or manual command is required.",
    "- Every accepted amendment is a generation-bound, audit-trailed re-lock: the prior generation is retained, changed criteria reset and re-verify, and acceptance resumes the run in the same act.",
  ].join("\n")
}
