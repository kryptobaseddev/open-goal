# T189 — scope.in audit for the agnostic-goal-store goal

Read-only audit requested after the goal's completion summary flagged
`scope.in` areas as discussed-but-unproven. Source of truth: the goal's own
commits and the two merged PRs, not the summary prose.

## What the goal actually touched

Goal `agnostic-goal-store`, run 19e384b5b001, base `2b95f2c`. Merged work:
PR #26 (`eec7d2a`, 19 files) and PR #27 (`db5a603`, 2 files). Files:

`CHANGELOG.md`, `cli/ocg.ts`, `dist/cli.js`, `docs/research/agnostic-goal-store.md`,
`package.json`, `src/contract/render.ts`, `src/engine/registry.ts`,
`src/engine/store-migration.ts`, `src/engine/store-root.ts`, `src/engine/store.ts`,
`src/engine/tick.ts`, `src/server/app.ts`, plus the tests
`test/host/{goal-store-default,goal.helpers,migrate-bin,store-layout-compat,store-migration}.test.ts`
and `test/unit/{render-store-path,store-layout-compat,store-migration-plan,store-path-seam}.test.ts`.

## Per area

| scope.in | Touched? | Work and evidence |
|---|---|---|
| `src/engine` | yes | `store-root.ts` (canonical default, override resolution, `storePathKind`, `goalStatePaths`), `store.ts` (union reads, write-where-it-lives, owner-state resolution), `store-migration.ts` (planner + confirmed move), `registry.ts` (scans both roots), `tick.ts` (starts when either store exists). Proven by `store-path-seam` 29/29, `store-layout-compat` 17/17, `store-migration-plan` 12/12 and the host store files; follow-ups T182/T184 (merged) and T185/T186 (filed) carry the rest. |
| `src/server` | yes | `app.ts`: dispatch of a declared workstream to its named worker, the migration surface, and the guard over both roots. Proven by `goal-store-default` host 2/2, `store-migration` host 3/3, `migrate-bin` 4/4. |
| `src/cli` | no | No change was needed: `src/cli/status.ts` already renders from the contract, and the store path reaches it through `render.ts` (changed) rather than a literal. The remaining gap was copy, which is T187. |
| `cli` | yes | `cli/ocg.ts` gained the `migrate` subcommand (dry run, `--confirm`, refusal of live runs). Proven by `test/host/migrate-bin.test.ts`, which spawns the real bin and asserts the legacy tree is byte-identical after a dry run. T188 exposes the same planner through the goal UX. |
| `docs/research` | yes | `agnostic-goal-store.md` records the canonical store, the override, the legacy read path, the opt-in move, the no-data-loss rule and the resolver quote; C5 passed the independent verifier on a clean round. |

## Outside scope.in, named for completeness

`docs/adr` was untouched: the store decision is ADR-001 in the CLEO docs store
(`cleo docs fetch adr-001-goal-store-root-surface`), so no repository ADR file
was required. `CHANGELOG.md`, `package.json` and `dist/cli.js` changed for the
0.12.x releases, not for goal behaviour.

## Conclusion

Every `scope.in` area is either exercised with merged evidence or has a written
reason why no change was needed. The remaining store work is the filed
follow-ups T182 (merged), T183, T184 (merged), T185, T186, T187, T188 and this
audit. No code change is part of this task.
