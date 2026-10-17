// v0.8.0 — what a host restart does to a live run.
//
// The owner's policy: a restart is not an owner decision. If the contract on
// disk is still the locked contract and the run's own state is intact, the run
// resumes by itself. A changed contract, a divergent/repair-needed run or an
// interrupted write is still a stop: those are exactly the cases where guessing
// would resume work against bytes nobody approved.
//
// Pure: no filesystem, no clock, no OpenCode types. `app.ts` gathers the facts
// and applies the decision; the unit suite pins every case.

import type { Status } from "./state"

export type RestartFacts = {
  /** The status persisted before the restart. */
  status: Status
  /** The generation the run is bound to. */
  lock: string
  /** The lock computed from the contract currently on disk (undefined if unreadable). */
  diskLock?: string
  /** run.json parsed cleanly (no duplicate keys, no repair). */
  runIntact: boolean
  /** An amendment/launch journal says a write was in flight when the host died. */
  interruptedWrite?: boolean
}

export type RestartDecision =
  | { action: "resume"; reason: string }
  | { action: "pause"; code: "not-intact" | "interrupted-write" | "contract-missing" | "diverged"; reason: string }
  | { action: "none"; reason: string }

/** Only an ACTIVE run can resume; a stopped one is the owner's to restart. */
export function restartDecision(facts: RestartFacts): RestartDecision {
  if (!["running", "waiting", "verifying"].includes(facts.status))
    return { action: "none", reason: `the run was ${facts.status}; nothing to resume` }
  if (!facts.runIntact)
    return { action: "pause", code: "not-intact", reason: "run state was repaired from its ledger after a corrupt write; inspect it before resuming" }
  if (facts.interruptedWrite)
    return { action: "pause", code: "interrupted-write", reason: "a write was interrupted when the host stopped; the accepted generation is uncertain" }
  if (!facts.diskLock)
    return { action: "pause", code: "contract-missing", reason: "the locked contract could not be read from disk; resume would run against unknown bytes" }
  if (facts.diskLock !== facts.lock)
    return { action: "pause", code: "diverged", reason: `the contract on disk is generation ${facts.diskLock.slice(0, 12)}… but the run is locked to ${facts.lock.slice(0, 12)}…` }
  return { action: "resume", reason: "the lock is unchanged and the run is intact" }
}
