---
title: 'Bounds of the live-goal write guard: what a static path scan cannot see'
audience: maintainer
status: final
---

# Bounds of the live-goal write guard

## The mechanism

`src/server/app.ts` registers an `execute.before` hook. For every tool call it
computes `targetPaths(tool, input)`:

- `edit` / `write` / `patch` → the named file paths;
- `shell` / `bash` / `execute` → `shellWriteTargets(command)`.

`shellWriteTargets` scans the command string for write-shaped uses of a live
goal path: redirection (`>`, `>>`), `tee`, `sed -i`, and
`mv|cp|install|rm|truncate|touch|chmod|chown|ln|dd` naming the path, plus
interpreters (`python`/`node`/`bun`/`ruby`/`perl`) whose script writes or renames
it — while a **read** through an interpreter is explicitly not a write (the
v0.4.4 fix: `open(path)` without a write mode is a read). A refused write names
the supported tools: `goal_progress`, `goal_wait`, `goal_block`, `goal_flag`,
`goal_claim`, `goal_manage`, `goal_recover_divergence`.

The same hook also refuses any write into `.opencode/goals/**` for the live run
and into an archived folder, and refuses a write to a contract `protect` glob.

## A captured example

The protected `test/host/run-state-write-guard.test.ts` drives real shell
commands against a live run and asserts, per command, that the refusal names a
supported tool and that `run.json` is unchanged. Its captured shapes:

| command | outcome |
|---|---|
| `echo '{...}' > .opencode/goals/demo/run.json` | **refused** — names the supported tools |
| `cat run.json >> run.json` | **refused** |
| `python3 -c "open('run.json','w').write(...)"` | **refused** |
| `sed -i '' 's/paused/running/' run.json` | **refused** |
| `mv /dev/null run.json` | **refused** |
| `cat run.json` · `grep -c version run.json` · `ls -la .opencode/goals/demo` | **allowed** (reads) |
| `python3 -c "import json;print(json.load(open('run.json'))['status'])"` | **allowed** (read interpreter) |

And the reported failure it closes: an agent hand-merged `run.json`, producing
duplicate `updatedAt`/`tokens`/`tools`/`lastUsageEmit` keys, because the guard
originally covered only `edit`/`write`/`patch`.

## The residual risk — not full coverage

A static scan of the command **string** cannot see every writer. What it cannot
name:

1. **Opaque binaries.** A compiled program (or a `bun`/`python` script that reads
   the path from a file, env var or network) that writes the goal folder is not
   detected. It is caught later, if at all, by the load-time corruption check,
   not by this guard.
2. **Indirection.** `bash -c "$CMD"`, variable expansion, `eval`, a shell
   function, a here-doc that builds the command, or a wrapper script whose own
   body is never scanned.
3. **Alternate write spellings.** Syscalls via a non-listed interpreter, a
   language not in the interpreter list, `install -m`, an in-place editor other
   than `sed -i`, or a program that renames a temp file over the path.
4. **Out-of-band writes.** Another process, a filesystem job, a git hook or a
   file watcher mutating the folder while the tool-call guard only sees the
   agent's own calls.
5. **Semantic escapes.** A write to a *different* path that later becomes the
   goal path (a symlink), or a path expressed with `..`, `$PWD` or a relative
   base the scan resolves differently than the shell would.

The guard reduces the reachable surface; it does not prove that no writer
exists. The honest bound is: **every write the agent reaches through the tools
and the shell command it composes is refused; a static path scan cannot name a
writer whose path it never sees.** The load-time duplicate-key/corruption check
and the owner-owned evidence snapshot are the backstop for what the guard
misses, not a substitute for it.

## Why this is recorded, not "fixed"

The contract's assumption A4 asked for the residual risk to be bounded and
documented rather than over-claimed. A static guard cannot be made complete
against an arbitrary program; the value is in naming exactly what it covers and
what it does not, which the table and the list above do.
