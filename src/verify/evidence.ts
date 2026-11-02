// T178 — a verifier verdict is bound to the bytes it read. The host re-reads
// every quote at proof time (checkQuotes), but the proof used to survive the
// file itself: a later round could carry an old "pass" whose cited line no
// longer exists. This module captures the sha256 of every cited file at proof
// time and, on the next verification, names the files that moved.
//
// Pure computation: reads files, never writes.
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join, normalize, relative } from "node:path"
import type { CriterionState } from "../engine/state"

/** Where a citation resolves, or undefined when it escapes the project root. */
export function inside(root: string, path: string): string | undefined {
  const full = normalize(isAbsolute(path) ? path : join(root, path))
  const rel = relative(root, full)
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? full : rel === "" ? full : undefined
}

export const digestOf = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

const UNREADABLE = "unreadable"

/** sha256 of each cited file, keyed by the path the verifier wrote. A file the
 *  host cannot resolve or read is recorded as such, so a later round can name
 *  it instead of silently treating it as unchanged. */
export function captureFileDigests(root: string, paths: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const path of paths) {
    if (path in out) continue
    const full = inside(root, path)
    if (!full || !existsSync(full)) {
      out[path] = UNREADABLE
      continue
    }
    try {
      out[path] = digestOf(readFileSync(full))
    } catch {
      out[path] = UNREADABLE
    }
  }
  return out
}

/** One bound proof whose bytes moved. `now` is the digest found on disk. */
export type StaleBinding = { criterion: string; path: string; was: string; now: string }

export const shortDigest = (digest: string) => (digest.length === 64 ? digest.slice(0, 12) : digest)

/** The files the criterion's last proof was bound to, in citation order. */
export const boundFiles = (state: CriterionState | undefined): Array<[string, string]> =>
  state?.evidence?.files ? Object.entries(state.evidence.files) : []

/** A proven verdict's detail names the bytes it was bound to. */
export function bindingNote(files: Record<string, string>): string {
  const entries = Object.entries(files)
  return entries.length ? ` · bound sha256 ${entries.map(([path, digest]) => `${path}=${shortDigest(digest)}`).join(", ")}` : ""
}

/** The one-line reason a criterion was demoted, naming the file that moved. */
export function demotionReason(binding: StaleBinding): string {
  return `cited file ${binding.path} changed since this criterion was proven (sha256 ${shortDigest(binding.was)} → ${shortDigest(binding.now)}); the old pass no longer binds those bytes`
}

/**
 * Every proven verifier criterion whose cited bytes are no longer on disk
 * unchanged. Only criteria the verifier proved are considered: a host check is
 * re-run each round and re-establishes its own result, so binding a host pass
 * to verifier evidence would demote a criterion the host still proves.
 */
export function staleBindings(root: string, criteria: Record<string, CriterionState>, verifierIDs: Set<string>): StaleBinding[] {
  const out: StaleBinding[] = []
  for (const [id, state] of Object.entries(criteria)) {
    if (!verifierIDs.has(id)) continue
    if (state.status !== "pass") continue
    if (state.by !== "verifier" && state.by !== "verifier-fallback") continue
    for (const [path, was] of boundFiles(state)) {
      const now = captureFileDigests(root, [path])[path]!
      if (now !== was) out.push({ criterion: id, path, was, now })
    }
  }
  return out
}
