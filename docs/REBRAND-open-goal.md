# Rebrand record — opencode-goal → open-goal

Done 2026-10-19 by `opencode-goal-continuity` (session `ses_ebeed1b03ffeDc98PWOK7xeeVM`), tracked as **T163**
under T124. This is the local half of the move; the public half is owner-sequenced and still outstanding.

## Done and verified

| | |
|---|---|
| Folder | `/Users/keatonhoskins/projects/opencode-goal` → `/Users/keatonhoskins/projects/open-goal` |
| CLEO project | renamed via `cleo project rename open-goal`; **id `5f4ab735-ef8e-4c8b-8d64-1eb3021ed2ff` unchanged**; `.cleo/project.json` committed |
| Worktrees | **all 6 repaired** to the new path — `main`, `.worktrees/{harness-identity,adapter-seam,agnostic-goal-store,pr2}`, and the outside `.ocg-wt-npm` |
| Goal folders | 20 intact; the three validated drafts (`harness-identity`, `adapter-seam`, `agnostic-goal-store`) still have their `goal.yaml` |
| Git | HEAD `e10ed69` untouched; the move is invisible to git |
| Package | `@cleocode/goal@0.9.2`, bins `cleo-goal` + `ocg` — already rebranded, no change needed |
| mbx project key | `5f4ab735…` (source `.cleo/project-id`), same on every checkout |

**No goal run was live at any point** — all 17 run folders read `complete` before the move, which is why this was
safe to do now. The migration is captured as `scripts/rebrand-to-open-goal.sh` (dry-run by default; refuses an
existing target or any non-terminal goal run).

## Update — 2026-10-28 (lead session `ses_e7cd53effffe4eTnSrU4iQwCDX`)

The owner asked to finish the changeover: move the lead mailbox, rename the GitHub side, retire the old
name in instructions, and keep old mbx history usable.

| Step | State |
|---|---|
| mbx identity | registered as **`open-goal-lead@macbook`** (owner chose this name over `ocg-lead`), role `lead`, project `/Users/keatonhoskins/projects/open-goal`; **owner-signed lead** (id `01M61JX1CSPKMJ4WVPH3KYS86E`, expires 2026-11-27) — the lead can read project-wide bodies with `mbx_project` and forward mail |
| Old mailboxes | kept, not deleted. The project key `5f4ab735-ef8e-4c8b-8d64-1eb3021ed2ff` is unchanged, so `opencode-goal-*` history is still visible under the new path; those identities are released and claimable only by someone who deliberately claims them. New work uses `open-goal-*`. |
| Repo content | renamed in this working tree: README/AGENTS/CLAUDE/GEMINI, `package.json` repository/homepage/bugs, `docs/design.md`, the `write-goal` skill, scripts and tests. Plugin id and RPC id are `open-goal`; `install` still recognises the old git spec and plugin id so an upgrade replaces it. Historical docs, changelog entries and `.cleo` evidence are left as written. |
| npm trusted publisher | **still outstanding** — the local npm token is invalid (`npm whoami` → 401), so `npm trust list @cleocode/goal` cannot run. Owner must `npm login` first. |
| GitHub repo rename | **still outstanding**, and must come *after* the trusted-publisher update (see below). |
| `dist/` | rebuilt from the renamed source by the build script; regenerate before tagging. |

Data-format schema ids (`opencode-goal/provenance/v1`, `opencode-goal/handoff/v1`,
`opencode-goal/git-history/v1`) are deliberately unchanged: they are stored in existing evidence and
verifying them against a renamed schema would invalidate historical runs.

## Outstanding

**1. mbx persona — done.** The lead identity is `open-goal-lead@macbook` and is the owner-signed lead of this
project. No `ocg-lead` identity is needed; do not register one.

**2. The public rename, in this order** (doing 2b before 2c breaks publishing):

- a. `git remote set-url` is **not** needed yet; leave it until the repo is renamed.
- b. Update the npm trusted publisher for `@cleocode/goal` to `kryptobaseddev/open-goal` —
  **owner action**: `npm login`, then `npm trust github @cleocode/goal --file .github/workflows/release.yml --repo kryptobaseddev/open-goal --allow-publish`.
- c. Rename the GitHub repo `kryptobaseddev/opencode-goal` → `kryptobaseddev/open-goal`
  (`gh repo rename open-goal -R kryptobaseddev/opencode-goal`).
- d. Then `git remote set-url origin git@github.com:kryptobaseddev/open-goal.git` and push.
- e. `mbx doctor` will show the cloud origin change — expected, the project key stays the same.

Skipping b before c means the next OIDC release fails: npm binds trusted publishing to `owner/repo`.

**3. Naming inside the repo — done** (2026-10-28). `AGENTS.md` is headed "open-goal — project guide", the
git-install recipes use `github:kryptobaseddev/open-goal#<tag>`, and `package.json` points at the new URLs.
The CAAMP block above the project guide is generated text; its `CAAMP:SOURCE` comments still name the old
absolute path and are harmless historical provenance — leave them rather than hand-editing generated
content.

## Known staleness that is NOT a defect

`.cleo/cache/evidence/*` still contains the old absolute path. That is cached historical evidence and is
harmless — do not rewrite it. `test/unit/check-signature.test.ts` also references the old path and needs the
update in step 2d if it asserts on the checkout path.
