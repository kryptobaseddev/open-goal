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

## Outstanding

**1. The `ocg-lead` persona is NOT registered.** The mbx MCP disconnected from this session during the move
(`agentmbx whoami` works via the CLI, but the `mbx_*` tools are gone from the tool catalog), and registration
needs the MCP tool — `whoami --as` only reads the identity a session already holds. Fix: reload/restart the
session so the MCP reconnects, then run:

```
mbx_identity {"action":"register","name":"ocg-lead","role":"lead",
              "description":"OCG lead: own the open-goal project; the 0.9.3 -> 0.10.0 -> 0.11.0 goal chain."}
```

Then have the owner designate it **lead of `open-goal`**. Note the naming tension: the owner asked for the
handle `ocg-lead`, while the folder is now `open-goal`, so mbx's `<project>-<role>` convention would produce
`open-goal-lead`. `ocg` remains the short/bin name, so `ocg-lead` is defensible as a handle — but it is the
owner's call which of the two to standardise on.

**2. The public rename, in this order** (doing 2b before 2c breaks publishing):

- a. `git remote set-url` is **not** needed yet; leave it until the repo is renamed.
- b. Update the npm trusted publisher for `@cleocode/goal` to `kryptobaseddev/open-goal`.
- c. Rename the GitHub repo `kryptobaseddev/opencode-goal` → `kryptobaseddev/open-goal`.
- d. Then `git remote set-url origin` and update `package.json` `repository.url`.
- e. `mbx doctor` will show the cloud origin change — expected, the project key stays the same.

Skipping b before c means the next OIDC release fails: npm binds trusted publishing to `owner/repo`.

**3. Naming still inconsistent inside the repo** — `AGENTS.md` is headed "opencode-goal — project guide" and
its git-install recipe still uses `github:kryptobaseddev/opencode-goal#<tag>`. Both are correct *today* because
the GitHub repo has not been renamed; update them in step 2d, not before. `AGENTS.md` is CAAMP-managed, so
prefer editing the CAAMP source over the generated file.

## Known staleness that is NOT a defect

`.cleo/cache/evidence/*` still contains the old absolute path. That is cached historical evidence and is
harmless — do not rewrite it. `test/unit/check-signature.test.ts` also references the old path and needs the
update in step 2d if it asserts on the checkout path.
