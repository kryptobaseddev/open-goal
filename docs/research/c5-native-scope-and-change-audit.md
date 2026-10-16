---
title: C5 native owner scope and bounded change audit
audience: maintainer
status: draft
---
# C5 native owner scope and bounded change audit

## Question

The turn0 independent verifier accepted ownership-before-disposition, exact targets and refusal/reload tests, but could not independently establish the absence of unrelated repairs or the actual owner scope expansion across T104/T105. This is evidence-only remediation. No code, goal history, permission/provider setting, oracle or tag is changed to make C5 pass.

## Findings

### Actual owner scope is exported from native records, not reconstructed quotations

Read `.tmp/verification/c5-audit/native-owner-scope-records.json` (SHA256dae4df470e647c4fb32ae0e65663687e4d37ab11d0b721ce534e74fde1514c1f). It preserves original `data` JSON strings plus decoded data, native IDs, seq, type, created/updated times and exact session identity. Source is a coherent READ-ONLY backup of the real OpenCode store, taken before external inspection. Only exact current-session rows were queried/exported; no credentials table or other session's message content was queried. The private full backup is not published or committed.

The session row binds `ses_ec9b07c72ffeWHkmiuQxRJXUha`, parent_id:null, directory `/Users/keatonhoskins/projects/opencode-goal`, agent build. Original records:

- seq4/msg_1364f8390001h3axaLCAO5pzSQ: owner requests T103 reproduction/triage while preserving authority guards, through release.
- seq712/msg_137a11c12001MSteRZD1CekNkY: owner says “Just go ahead and start the plan. I approve.” This was ordinary execution approval, not invented successful launch.
- seq1732/msg_13ae37527001PnPnYCuAZtQNCH: actual owner “continue your goal.”
- **seq1798/msg_13b6f10800010L4q1Re1M5urZF, created1791998496993 (2026-10-14T17:21:36.993Z)**: actual user requests fixing the banner/launch, carrying out/completing the goal, and MUST P0 coordination with axiom-lab-dev's recursive continuation/completion issues. This predates T105 code changes. It supports the related P0 launch/prerequisite work; no peer claim or synthetic prompt was substituted for owner scope.

These historical records are evidence, not replayable consent or a waiver of criteria. No edited goal contract is used to expand scope.

### Raw Git change audit names every repair

`.tmp/verification/c5-audit/git-change-audit.json` records exact commands/hashes; `changes.patch`, `changed-paths.tsv` and `commits.txt` are unfiltered Git outputs from initial handoff3d455cd4c38e28e63be3c5a2ec9111d72390b881 to c8243d0caff2903b46b1717202c65657ed6b1e10. Patch SHA256a9339e7140af2592e665f8a605bbd32eec94a8d44346a06a3492a8884f537bb6.

Change set is bounded: app.ts (T104 diagnostic branches, T105 owner launch/prerequisites), engine/owner-intent.ts and launches.ts (T105 authenticated actual-chat handling), bundled write-goal guide, new related fixtures/tests, package version/changelog, and research/evidence documents. There are no unrelated application modules, provider/permission configuration files, production goal files or existing oracle edits in the Git change set. T104 commit2800f81 is reporting-only; T105 a768035 is the separately owner-requested P0 work; immutable releases0ce8e69/v314 and cccda35/v315 are separate. c8243d0 adds install-test adapters/evidence only, with no runtime artifact change.

The audit also reads exact remote tag refs. v312 remains2bf4109318351f8524ed45b5829bd4d299000776; v313 remains5ea9874783b4988e915c79522cd9f326d668d067. New314/315 match their published immutable commits. No old tag replacement is inferred from a version label.

### Native operation audit distinguishes actor writes from concurrent state

`all-tool-inputs.jsonl` exports **all434 native tool calls** in the captured current-session span, with native message/call IDs, seq, input, execution/status. `mutation-and-goal-tools.jsonl` retains complete original tool parts for patch, shell, execute and goal operations, including outputs/errors. `native-export-manifest.json` provides capture/source hashes. This is not an agent-authored reconstruction of performed commands.

`operation-audit-index.json` is navigation, not replacement evidence:37 patch calls,0 direct global config patches;4 standard package pin mutations (remove313/add314; remove314/add315) and2 configuration reloads. Read-only plugin list/help calls are correctly separated. Inspect raw shell scripts/state mentions to distinguish isolated temp fixtures and generated audit data from production mutation. The only direct goal-folder patch is seq591: creation of the new draft goal.yaml/context/decision log BEFORE launch, not an edit/restore of an existing production run, lock or receipt. Actual launched state/provenance are host-owned. No raw owner lifecycle API or fabricated production form reply is used.

### Existing goal and oracle evidence is bounded and checkable

`state-and-oracle-audit.json` compares the initial native goal_inventory response (seq15, raw original tool part in native-goal-inventory-records.json) to current READ-ONLY files for all5 older goals. Their slug/runId/lock/sessionID/status/updatedAt tuples are exactly unchanged, including completed ship-v033 run12739b68c001. This is native before/current state evidence, not a promise that arbitrary bytes on the whole host never changed.

The same audit compares6 protected script/oracle blobs byte-for-byte against initial Git baselines: original target/launch/Composer tests and installed checker at3d455cd; newly authored lab-triage/boundary oracle at fdd365e. All are equal. No oracle was edited after its protected red baseline to force a pass. Working-tree raw status shows only existing untracked goal folders; no production goal history was staged.

### Configuration comparison does not hide missing historical coverage

`config-hash-comparison.json` reads the actual global JSONC and existing pre-release backups without modifying them; it outputs hashes/top-level key names and plugin targets only, no secret values. **Providers hash matches the older Oct11/12 snapshots; there is no permissions key in either.** Current plugin target is v315, as required by installed proof.

Do NOT claim all non-plugin configuration is identical across that wider interval: the MCP subtree differs. `mcp-historical-differences.json` identifies the ONLY differing path `/mcp/servers/playwright/command`, with old/current value hashes and no secret values. That older Oct12 backup is not a manufactured exact before-image for T104/T105. The complete captured actor operation audit shows no MCP/provider/permission edit by this held worker; it shows only the standard package pin/reload calls. It cannot attribute unrelated concurrent host changes to this worker, and no such attribution or whole-host immutability claim is made. No correction/restoration of that MCP difference was attempted.

## Sources and read order

1. native-owner-scope-records.json: native user seq1798 is the actual P0 scope record.
2. git-change-audit.json + changed-paths.tsv/commits.txt/changes.patch: independently inspect the complete code and release scope.
3. operation-audit-index.json: navigation into all-tool-inputs.jsonl and complete raw mutation-and-goal-tools.jsonl. Retained failed attempts are not relabeled successes.
4. state-and-oracle-audit.json + native-goal-inventory-records.json: five unchanged old goal tuples and six equal oracle blobs.
5. config-hash-comparison.json + mcp-historical-differences.json: provider/permission evidence and explicitly limited wider-backup MCP comparison.
6. Existing .tmp/verification/t105-installed/{chat-launch,amendment-recovery}.json and native run engine-provenance: actual tagged tests, fresh owner authentication, journalled apply/retirement ordering, same-run admission and actual installed315 serving identity. Current host already proved C2/C3/C4/I1/I2; this audit doesn't self-grade C5.

Peer disk900/locked600 divergence is a SEPARATE integrity class. A pending proposal's nextLock matching disk is NOT acceptance or write-ahead approval: actual engine writeAhead requires authenticated reserve and commit={state,acceptedAt}. No manual rollback, lock move, pending-review retirement or retrospective consent is authorized from a peer claim. T101's separate owner-reviewed integrity disposition remains outside this goal. No peer completion is asserted.