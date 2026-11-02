// T185 — where the plugin's own project-level sidecars live.
//
// `.owner-decisions.json`, `.owner-launches.json`, `.owner-amendments.json` and
// `.launch-approvals.json` are not goal folders, but they ARE store state: a
// pending form belongs to the run it authorizes. Until this module they were
// pinned to `.opencode/goals`, so a canonical project lost every form.
//
// The rule is deliberately conservative during the transition:
//   - an explicit `.cleo/goal-store.json` pin always wins (a project pinned to
//     `.opencode/goals` keeps the exact location it has);
//   - otherwise a project that still HAS the legacy store keeps its records
//     beside it — never split from the runs a pending decision names;
//   - a project with no legacy store gets the resolved canonical root.
//
// Reads additionally consult the other root, so a record written before a
// store move is still honored. Only the resolved file is ever written.
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { StoreRoots } from "./store-root"

/** Every sidecar this module resolves. Nothing here is a slug: a directory is
 *  a goal only when it holds a `goal.yaml`. */
export const OWNER_STATE_FILES = [".owner-decisions.json", ".owner-launches.json", ".owner-amendments.json", ".launch-approvals.json"] as const
export type OwnerStateFile = (typeof OWNER_STATE_FILES)[number]

/** The project-relative directory that holds the owner-state sidecars. */
export function ownerStateRel(roots: StoreRoots): string {
  if (!roots.explicit && roots.goalsRel !== roots.legacy.goalsRel && existsSync(roots.legacy.goals)) return roots.legacy.goalsRel
  return roots.goalsRel
}

/** The file a sidecar is written to (and read from first). */
export function ownerStatePath(root: string, roots: StoreRoots, name: OwnerStateFile): string {
  return join(root, ownerStateRel(roots), name)
}

/** The files a sidecar may be read from, primary first. The other store root
 *  is a read-only fallback so a pre-flip record is never lost; mutations still
 *  land in `ownerStatePath` only (`OwnerReviewStore.mutate`). */
export function ownerStateReadPaths(root: string, roots: StoreRoots, name: OwnerStateFile): string[] {
  const dirRel = ownerStateRel(roots)
  const otherRel = dirRel === roots.goalsRel ? roots.legacy.goalsRel : roots.goalsRel
  const primary = join(root, dirRel, name)
  return otherRel === dirRel ? [primary] : [primary, join(root, otherRel, name)]
}
