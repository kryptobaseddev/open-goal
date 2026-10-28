// v0.7.0 - the `ocg tick` entry point: RECORD the turn, DECIDE, then act.
//
// CLEO's Stop dispatcher spawns `ocg tick` with the harness's Stop JSON on stdin
// and reads JSON ONLY from stdout:
//   {"decision":"block","reason":"<continuation>"}  keep the agent working
//   {"final":false}                                 hold the session open
//   anything else (including non-JSON, or nothing)  no live goal
// Logs go to stderr. It runs only where `.opencode/goals/` exists.
//
// v0.6.0 made the tick decide; it was read-only, so nothing advanced the counters
// the stall, recovery, wrap-up and claim decisions read - a goal could never be
// driven to an end outside OpenCode. v0.7.0 records the turn first (through OCG's
// own store, in the adapter's own shape) and RUNS the verification of a claim, so
// a host-only goal can actually reach `complete`. Everything it records is what a
// Stop-time observer can know or recover from the payload - never a guess, and a
// missing payload, transcript or store is a stated degradation, not an error.

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { Contract } from "../contract/types"
import { renderTailNote } from "../contract/render"
import { budgetUse, setStatus, TERMINAL as TERMINAL_STATUSES, type RunState } from "./state"
import { continuationTail, decide, type LoopLimits, type LoopSignals } from "./loop"
import { recordTurn } from "./tick-record"
import { dispatcherIdentity } from "./harness-identity"
import type { VerifyOutcome } from "../verify/pipeline"

/** The plugin's own defaults, so a tick agrees with the adapter unless overridden. */
export const TICK_LIMITS: LoopLimits = { blockerRepeats: 3, stallTurns: 3, recoveryAt: 2, backstopTurns: 200 }
export const TICK_COOLDOWN_MS = 1_500
/** CLEO caps a forwarded reason at 4000 characters. */
export const REASON_CAP = 4_000

/** The store surface the tick writes through - OCG's own store, never a hand edit. */
export type TickStore = {
  slugs: () => string[]
  readRun: (slug: string) => RunState | undefined
  writeRun: (state: RunState) => void
  readContract: (slug: string) => { contract?: Contract; text: string } | undefined
  ledger: (slug: string, event: Record<string, unknown> & { type: string }) => void
  evidence: (slug: string, runId: string, name: string, data: unknown) => string
}

export type TickDeps = {
  root: string
  store: TickStore
  /** The repository fingerprint now (git), or undefined when it cannot be taken. */
  fingerprint?: () => string | undefined
  /** Run the claim verification. Absent means the tick cannot finish a goal. */
  verify?: (state: RunState, contract: Contract, contractText: string) => Promise<VerifyOutcome>
  /** The raw harness Stop payload, when the harness passed one. */
  payload?: string
  /** The dispatcher's environment. Defaults to the real one. */
  env?: Record<string, string | undefined>
  readTranscript?: (path: string) => string | undefined
  limits?: LoopLimits
  cooldownMs?: number
  now?: number
}

export type TickResult = {
  /** Exactly what goes to stdout (empty when no goal is live). */
  stdout: string
  /** Lines for stderr. */
  log: string[]
}

const BLOCK = (reason: string) => JSON.stringify({ decision: "block", reason })
const HOLD = JSON.stringify({ final: false })
const why = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** The newest non-terminal run in the project, by `updatedAt`.
 *
 * An absent or unreadable store is a stated degradation, never an exception: a
 * crash looks exactly like "no live goal" to the dispatcher (empty stdout), which
 * would silently drop the run. If a record cannot be read we cannot rule out a
 * live goal, so the caller HOLDS rather than printing nothing. */
function liveRun(store: TickStore, log: string[]): { live?: RunState; unreadable: boolean } {
  let slugs: string[]
  try {
    slugs = store.slugs()
  } catch (error) {
    log.push(`could not read the run store (${why(error)}); cannot rule out a live goal`)
    return { unreadable: true }
  }
  let live: RunState | undefined
  let unreadable = false
  for (const slug of slugs) {
    let state: RunState | undefined
    try {
      state = store.readRun(slug)
    } catch (error) {
      log.push(`could not read the run record for ${slug} (${why(error)}); cannot rule it out`)
      unreadable = true
      continue
    }
    if (!state?.slug || TERMINAL_STATUSES.includes(state.status)) continue
    if (!live || (state.updatedAt ?? 0) > (live.updatedAt ?? 0)) live = state
  }
  return { live, unreadable }
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  const log: string[] = []
  const now = deps.now ?? Date.now()
  const limits = deps.limits ?? TICK_LIMITS
  // Outside a goal project there is nothing to tick at all - print nothing.
  if (!existsSync(join(deps.root, ".opencode", "goals"))) {
    log.push("no .opencode/goals directory; nothing to tick")
    return { stdout: "", log }
  }
  const { live, unreadable } = liveRun(deps.store, log)
  if (!live && unreadable) {
    log.push("a run record could not be read; cannot rule out a live goal - holding")
    return { stdout: HOLD, log }
  }
  if (!live) {
    log.push("no live goal here; nothing to tick")
    return { stdout: "", log }
  }
  let read: { contract?: Contract; text: string } | undefined
  try {
    read = deps.store.readContract(live.slug)
  } catch (error) {
    log.push(`could not read the contract for ${live.slug} (${why(error)}); holding`)
    return { stdout: HOLD, log }
  }
  if (!read?.contract) {
    log.push(`goal ${live.slug} has no readable contract; holding`)
    return { stdout: HOLD, log }
  }
  const contract = read.contract

  // ── 1. RECORD the turn, through OCG's own store, in the adapter's own shape.
  const record = recordTurn(live, contract, { fingerprint: deps.fingerprint ?? (() => undefined), ...(deps.payload ? { payload: deps.payload } : {}), ...(deps.readTranscript ? { readTranscript: deps.readTranscript } : {}), now })
  // ── 1a. DECLARE the harness that produced this run, once. CLEO's dispatcher
  // names it (`CLEO_HOOK_PROVIDER`); absent or unrecognised is `unknown`, never a
  // guess from the payload. A run already carries its producer, so it is never
  // renamed by a later tick.
  const identity = dispatcherIdentity(deps.env ?? process.env)
  if (!live.harness) {
    live.harness = identity
    deps.store.ledger(live.slug, { type: "harness", name: identity.name, version: identity.version, capabilities: identity.capabilities, source: "tick" })
    log.push(`recorded harness ${identity.name}${identity.name === "unknown" ? " (no CLEO_HOOK_PROVIDER declared)" : ""}`)
  } else if (live.harness.name !== identity.name && identity.name !== "unknown") {
    log.push(`harness is already recorded as ${live.harness.name}; the dispatcher declared ${identity.name} - keeping the producer`)
  }
  deps.store.ledger(live.slug, {
    type: "turn",
    turn: live.turn,
    kind: "tick",
    tools: live.turnFacts.tools,
    activity: live.turnFacts.tools > 0,
    changed: record.changed,
    progress: record.progress,
    noProgress: live.counters.noProgress,
  })
  deps.store.writeRun(live)
  log.push(`recorded turn ${record.turn} for ${live.slug} (${record.progress ? "progress" : "no progress"}${record.claimHonoured ? ", claim honoured" : ""})`)
  for (const gap of record.couldNotSee) log.push(`could not see ${gap}`)

  // ── 2. DECIDE, with the same pure function the OpenCode adapter uses.
  const signals: LoopSignals = {
    turn: "succeeded",
    ...(live.pending ? { pending: live.pending.kind } : {}),
    changed: record.changed,
    progressRecorded: record.progress,
    stepsChanged: false,
    activeStalled: false,
    stallReason: `stalled: no change the host could see for ${live.counters.noProgress} turns`,
    onStall: contract.autonomy.on_stall,
    budgetRatio: budgetUse(live, contract).ratio,
    backstop: false,
    cooldownMs: deps.cooldownMs ?? TICK_COOLDOWN_MS,
    now,
  }
  const action = decide(live, signals, limits)

  // ── 3. ACT.
  switch (action.kind) {
    case "verify": {
      if (!deps.verify) {
        log.push("a claim is pending but this tick cannot verify; holding")
        return { stdout: HOLD, log }
      }
      live.claim = undefined
      setStatus(live, "verifying", "tick verification")
      deps.store.ledger(live.slug, { type: "verify-start", source: "claim", turn: live.turn })
      deps.store.writeRun(live)
      const outcome = await deps.verify(live, contract, read.text)
      for (const r of outcome.results) live.criteria[r.id] = { status: r.pass ? "pass" : "fail", by: r.by, at: now, detail: r.detail.slice(0, 600), rejections: live.criteria[r.id]?.rejections ?? 0 }
      live.verdict = { passed: outcome.passed, lines: outcome.lines.slice(0, 20), at: now, turn: live.turn }
      deps.store.evidence(live.slug, live.runId, `verify-tick-${live.turn}`, outcome)
      if (outcome.passed) {
        setStatus(live, "complete", "all required criteria verified")
        deps.store.ledger(live.slug, { type: "complete", turn: live.turn })
        deps.store.writeRun(live)
        log.push(`goal ${live.slug} complete: ${outcome.lines[0] ?? "all required criteria verified"}`)
        return { stdout: "", log } // no live goal remains; the harness session may end
      }
      // Not proven: keep the run going and hand the agent the verdict.
      setStatus(live, "running")
      deps.store.writeRun(live)
      log.push(`goal ${live.slug} did not pass verification: ${outcome.lines.slice(0, 2).join(" ").slice(0, 200)}`)
      return { stdout: BLOCK(renderTailNote(live, contract, "verdict", now).slice(0, REASON_CAP)), log }
    }
    case "admit":
    case "schedule": {
      const tail = continuationTail(action)!
      deps.store.writeRun(live)
      const reason = renderTailNote(live, contract, tail, now).slice(0, REASON_CAP)
      log.push(`goal ${live.slug}: decision ${action.kind}; continuing with the ${tail} continuation (${reason.length} chars)`)
      return { stdout: BLOCK(reason), log }
    }
    default: {
      if (action.kind === "stop") setStatus(live, action.status, action.reason)
      deps.store.writeRun(live)
      log.push(`goal ${live.slug}: decision ${action.kind}${action.kind === "stop" ? ` (${action.code})` : ""}; holding the session`)
      return { stdout: HOLD, log }
    }
  }
}
