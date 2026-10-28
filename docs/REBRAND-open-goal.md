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
| GitHub repo rename | **done 2026-10-28**: `kryptobaseddev/opencode-goal` → `kryptobaseddev/open-goal`; the old URL redirects; the remote is `https://github.com/kryptobaseddev/open-goal.git` and `main` is pushed. |
| npm trusted publisher | **done 2026-10-28**: `npm trust github @cleocode/goal --file release.yml --repo kryptobaseddev/open-goal --allow-publish` succeeded (trust id `d0a1062a-91c1-463f-8f14-a5d4e7826354`, permissions publish + stage publish). Note the order had to be inverted: npm validates that the GitHub repo exists, so the repo rename came first and the publisher second; no release was cut in between. |
| `dist/` | rebuilt from the renamed source by the build script; regenerate before tagging. |

Data-format schema ids (`opencode-goal/provenance/v1`, `opencode-goal/handoff/v1`,
`opencode-goal/git-history/v1`) are deliberately unchanged: they are stored in existing evidence and
verifying them against a renamed schema would invalidate historical runs.

## Outstanding

**1. mbx persona — done.** The lead identity is `open-goal-lead@macbook` and is the owner-signed lead of this
project. No `ocg-lead` identity is needed; do not register one.

**2. The public rename, in this order** (doing 2b before 2c breaks publishing):

All four steps are **done**:

- a. `git remote set-url origin https://github.com/kryptobaseddev/open-goal.git` — done.
- b. Rename the GitHub repo (`gh repo rename open-goal --repo kryptobaseddev/opencode-goal --yes`) — done;
  the old URL redirects.
- c. Update the npm trusted publisher (`npm trust github @cleocode/goal --file release.yml --repo
  kryptobaseddev/open-goal --allow-publish`) — done, after a browser 2FA approval. `--file` takes the bare
  filename, not a path.
- d. Push `main` — done.

**Correction to the earlier ordering advice:** npm validates that the target GitHub repo exists, so the
trusted-publisher move returned E404 until the repo was renamed. The safe order is repo rename → push →
trusted-publisher move, with **no release** until the publisher is updated. Skipping the publisher update
still breaks the next OIDC release, because npm binds publishing to `owner/repo`.

**3. Naming inside the repo — done** (2026-10-28). `AGENTS.md` is headed "open-goal — project guide", the
git-install recipes use `github:kryptobaseddev/open-goal#<tag>`, and `package.json` points at the new URLs.
The CAAMP block above the project guide is generated text; its `CAAMP:SOURCE` comments still name the old
absolute path and are harmless historical provenance — leave them rather than hand-editing generated
content.

## Known staleness that is NOT a defect

`.cleo/cache/evidence/*` still contains the old absolute path. That is cached historical evidence and is
harmless — do not rewrite it. `test/unit/check-signature.test.ts` also references the old path and needs the
update in step 2d if it asserts on the checkout path.
