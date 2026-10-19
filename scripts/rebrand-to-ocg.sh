#!/usr/bin/env bash
# Rebrand the project folder opencode-goal -> open-goal, without breaking the work streams.
#
# Why a script: the repo has SIX worktrees (three of them inside .worktrees/), a CLEO project
# registration, and an mbx project scope keyed to the folder path. A bare `mv` breaks all of them.
#
# Usage:
#   scripts/rebrand-to-ocg.sh                 # dry run: print every step, change nothing
#   scripts/rebrand-to-ocg.sh --apply         # do it
#   scripts/rebrand-to-ocg.sh --apply --force # skip the "no live goal run" guard
#
# Deliberately NOT done here (they are owner steps, and doing them early breaks publishing):
#   * renaming the GitHub repo   - npm's OIDC trusted publisher is bound to owner/repo,
#                                  so the publisher must be updated first or the next release fails
#   * package.json repository.url - leave it while the GitHub repo keeps its name; GitHub
#                                  redirects, so a later rename is safe
#   * registering the ocg-lead identity - do it AFTER the move, when the project scope is `ocg`
set -euo pipefail

OLD="/Users/keatonhoskins/projects/opencode-goal"
NEW="/Users/keatonhoskins/projects/open-goal"
NEW_REPO_NAME="open-goal"

APPLY=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --force) FORCE=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() {
  if [ "$APPLY" -eq 1 ]; then say "  \$ $*"; "$@"; else say "  would: $*"; fi
}

say "== rebrand: $OLD -> $NEW =="
say "mode: $([ "$APPLY" -eq 1 ] && echo APPLY || echo DRY-RUN)"

# ── guards ────────────────────────────────────────────────────────────────────
[ -d "$OLD" ] || { say "FAIL: $OLD does not exist"; exit 1; }
[ -d "$OLD/.git" ] || { say "FAIL: $OLD is not a git checkout"; exit 1; }
if [ -e "$NEW" ]; then say "FAIL: $NEW already exists — refusing to merge two trees"; exit 1; fi

if [ "$FORCE" -eq 0 ]; then
  live=""
  for runfile in "$OLD"/.opencode/goals/*/run.json; do
    [ -e "$runfile" ] || continue
    status=$(bun -p "try { JSON.parse(await Bun.file(process.argv[1]).text()).status } catch { 'unreadable' }" "$runfile" 2>/dev/null || echo unreadable)
    case "$status" in
      complete|failed|aborted|superseded|none|"") : ;;
      *) live="$live $(basename "$(dirname "$runfile")"):$status" ;;
    esac
  done
  if [ -n "$live" ]; then
    say "FAIL: non-terminal goal runs exist:$live"
    say "      finish or archive them, or pass --force (their absolute paths will go stale)."
    exit 1
  fi
  say "guard ok: no live goal runs"
fi

say ""
say "== 1. move the tree =="
run mv "$OLD" "$NEW"

say ""
say "== 2. point git at the new path =="
say "  (worktree gitdir files hold absolute paths; repair rewrites them)"
if [ "$APPLY" -eq 1 ]; then
  ( cd "$NEW" && git worktree repair ) || { say "  WARN: git worktree repair reported a problem"; }
else
  say "  would: (cd $NEW && git worktree repair)"
fi

say ""
say "== 3. verify the worktrees survived =="
if [ "$APPLY" -eq 1 ]; then
  ( cd "$NEW" && git worktree list )
else
  say "  would: (cd $NEW && git worktree list)   # expect 6 entries, all resolvable"
fi
say "  note: the worktree at /Users/keatonhoskins/projects/.ocg-wt-npm lives OUTSIDE the"
say "        tree; if repair misses it, run: git -C /Users/keatonhoskins/projects/.ocg-wt-npm repair"

say ""
say "== 4. CLEO project identity =="
say "  the project id travels in .cleo/, so the registry sees a move, not a new project."
if [ "$APPLY" -eq 1 ]; then
  ( cd "$NEW" && cleo doctor project-identity 2>&1 | head -5 ) || true
  say "  if it reports name drift, record the move (reversible with --rollback <id>):"
  say "     cd $NEW && cleo doctor projects --apply"
else
  say "  would: (cd $NEW && cleo doctor project-identity)  # then, only if it reports drift:"
  say "         cleo doctor projects --apply"
fi

say ""
say "== 5. mbx =="
say "  the project scope is the folder path, so mail keeps its old scope (preserved, not migrated)."
say "  AFTER the move, register the lead:"
say "     mbx_identity {action:register, name:\"$NEW_REPO_NAME-lead\", role:\"lead\"}"
say "  and have the owner designate it lead of $NEW."

say ""
say "== 6. owner steps, in this order (do NOT do them early) =="
say "  a. write the handoff + close any session still sitting in $OLD"
say "  b. rename the GitHub repo kryptobaseddev/opencode-goal -> kryptobaseddev/$NEW_REPO_NAME"
say "  c. update the npm trusted publisher for @cleocode/goal to the NEW repo name"
say "     (OIDC publishing is bound to owner/repo; skip this and the next release fails)"
say "  d. then update package.json repository.url and \`git remote set-url origin\`"

say ""
say "== 7. what still points at the old name (check after applying) =="
say "  test/unit/check-signature.test.ts references the absolute path"
say "  .cleo/cache/evidence/* embeds it in cached evidence (historical, harmless)"

say ""
if [ "$APPLY" -eq 1 ]; then say "DONE. Re-open sessions in $NEW."; else say "DRY RUN. Re-run with --apply to perform it."; fi
