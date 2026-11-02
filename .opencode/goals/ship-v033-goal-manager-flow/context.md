# Current-state audit — 2026-10-10

## Release and installation

- Repository HEAD: `8f712a8`; clean checkout at audit start; package version `0.3.2`.
- GitHub's newest release tag: `v0.3.2`, annotated object `fba3d5508acbd7694a0c664f512f150ad125e98f`, peeled commit `c9f84b90080f8b848784122d0e0ac63147530512` (`git ls-remote --tags origin`).
- OpenCode client and live service: `2.0.26` (the repo's dev dependencies remain `2.0.22`).
- Location-specific live `/api/plugin` response: opencode-goal active, server/TUI/RPC features present, target `github:kryptobaseddev/opencode-goal#v0.3.2`, loaded revision `1003962ca9adc72800257086c8e02026eb6f03ad`, `outdated: true`.
- Loaded package cache: `/Users/keatonhoskins/.cache/opencode/npm/git-opencode-goal-c90e5a365903/1791240060476/node_modules/opencode-goal`.
- Cached `src/tui/index.tsx` and `dashboard.ts` match Git commit `1003962` byte-for-byte, NOT the current v0.3.2 tag. The cache lacks `panelFocusPending` and `quickActRows`. Cached server/app.ts does match the tag. The runtime is therefore an older UI despite a matching 0.3.2 version label.
- The git-install test only checks command/skill registration and runtime dependencies in the newest cache directory; it does NOT assert the resolved commit or the bytes of the installed UI. Earlier reinstall/proof claims cannot establish the later UI fixes were deployed.
- `git diff v0.3.2..HEAD --stat`: four files (HANDOFF, dogfood-5, command-ack test, decision-ledger test). Source/runtime changes are in the tag; later test/docs repairs are only in main.
- Another local plugin fails setup: `.opencode/plugins/cleo-heavy-command.js`, with missing V2 default definition/id. opencode-goal itself is active. Do not delete generated CLEO configuration to hide this failure.

### Installation corrected during this audit

`cleo run --wait --class install -- opencode plugin update github:kryptobaseddev/opencode-goal#v0.3.2` returned `Updated Server plugin "opencode-goal"` and exit 0.

Post-update, the location-specific live plugin API reports active server/TUI/RPC at **`c9f84b90080f8b848784122d0e0ac63147530512`**, the current published tag revision, with no outdated flag. The new cache epoch is `1791654395670`. Actual relevant source bytes match `git show v0.3.2:<path>`:

| File | SHA256 | Matches tag |
|---|---|---|
| src/tui/index.tsx | f976f0e64036a1304483152741617973c28e00211da9fa37930395105f1c66ba | yes |
| src/tui/dashboard.ts | d60fd63457346f910d5431f59d6ad52d92e440edae0783fa75359fad51b6e991 | yes |
| src/server/app.ts | 1bd9e7279cfe13d8ffa0ef600702062d9a284c64c27cba74795c0334d20eaca9 | yes |

Only the goal package was updated; the old cache was preserved and no tag, unrelated configuration or session history was changed. The generated CLEO plugin setup failure remains separately reported. Package activation and exact bytes are now proven; a fresh visual dogfood claim is not implied by that check.

## Goal contracts on disk

| Area | Slug | State | Proven | Turn |
|---|---|---|---|---|
| goals | ship-v031-launch-experience | complete | 22/22 | 11 |
| goals | ship-v032-trust-the-card | complete | 16/16 | 7 |
| goals-archive | dogfood-buildout | complete | 21/21 | 4 |
| goals-archive | ship-v03-feedback-loop | complete | 22/22 | 6 |

Before this draft there were NO unfinished goal.yaml contracts. The previous v0.3.3 interview was not turned into a contract or launched. The completed runs still contain active/pending plan-step markers; criterion completion does not imply every plan step was marked done. These historical artifacts must not be rewritten to pretend otherwise.

## CLEO hierarchy (CLI reads, not direct DB reads)

```text
T001 saga — pending
├─ T002 original-plugin epic — pending
│  ├─ T076 visible fresh-session handoff — pending
│  ├─ T077 cross-session multi-goal sidebar — pending
│  ├─ T078 manager in the primary session — pending
│  └─ T079 expand/jump navigation — pending
├─ T024 v0.3 epic — done
├─ T035 integrity/rehearsal/amendment epic — pending
│  └─ T036–T038 — all done
└─ T039 hardening/release epic — pending
   └─ T040–T043 — all done
```

`cleo find '' --status pending --limit 0` returned exactly these eight pending records (four parent records plus T076–T079). No active or blocked tasks were returned. T069–T075 are all done. T035/T039's unfinished parents need evidence/lifecycle reconciliation, not implementation of already-completed children. CLI graph coverage is missing (`cleo focus T078`), so static impact coverage is UNKNOWN, not NONE.

## Source-level gaps

- Bare `/goal` reports status. `/goal <unrecognized text>` invokes write-goal, but recognized first words such as `start`, `amend`, and `pause` are handled as rigid subcommands, not semantic requests.
- The model-facing surface contains start/validate/progress/claim/block/flag/wait/status, not a general authenticated lifecycle operation surface. Amendment remains owner-edits-file then `/goal amend confirm`; no staged model proposal/apply flow exists.
- Launch approval only recognizes answers starting with `Start goal now`; skill options `Start clean` and `Start in a fresh session` do not match that label even though the skill says they work. Approval is session-based rather than bound to the specific contract and intended launch mode.
- Clean start creates a new root session and admits the kickoff, preserving the original context. No automatic tabs.open/focus or persistent source-session pointer exists. It is NOT a clear-in-place implementation.
- Sidebar and panel render only `views[currentSessionID]`; a session with no goal cannot render the manager. The Goals tab is textual; it has no selection/expansion/jump actions. Thus T077–T079 are not implemented.
- Pending decisions/forms and deferred commands live in memory. Form.created binds the first subsequent form without checking its decision identity; replies use label-prefix matching; cancellations do not clear pending decision-form state. ownerAct records a successful resolution BEFORE action validation. These need regression tests for cancellation/restart/ambiguous replies/replay/failed actions.
- Old amendment comparison uses criterion id + check only, not the statement. Statement changes must invalidate evidence too.
- Fixed sidebar width and global tab binding remain UI limitations; test real width/focus behavior, not just formatting strings.

## Fresh verification

- `cleo run --wait --class test -- bun test test/host/clean-start.test.ts test/host/launch-approval.test.ts test/host/ask-tool-decisions.test.ts test/host/amend.test.ts --timeout 120000`: 4 pass, 0 fail, 35 assertions; isolated OpenCode 2.0.26 hosts using the working tree. Transport teardown warnings remain in output. This is not a live installed-UI proof.
- Earlier focused dispatch/decision set: 5 pass, 0 fail, 43 assertions.
- `cleo run --wait --class typecheck -- bun run typecheck`: exit 0.
- No full-suite claim is made for today. Historic 165-test green results are not fresh validation of the deployed cache.

## Documentation consulted

- OpenCode V2 plugins, CLI plugins, API and plugin update CLI help. Current docs place navigation at `context.ui.tabs`; use enabled() + focus() and router.navigate fallback when tabs are disabled.
- Context7 `/websites/opencode_ai_v2`: package update/check and cached Git plugin behavior. Tags can be outdated while cached packages remain loaded; exact revision and artifact verification are necessary.
