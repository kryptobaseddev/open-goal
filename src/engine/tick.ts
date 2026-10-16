// v0.6.0 - the `ocg tick` entry point.
//
// CLEO's Stop dispatcher (merged #2306) spawns `ocg tick` with the harness's Stop
// JSON on stdin and reads JSON ONLY from stdout:
//   {"decision":"block","reason":"<continuation>"}  keep the agent working
//   {"final":false}                                 hold the session open
//   anything else (including non-JSON, or nothing)  no live goal
// Logs go to stderr. It runs only where `.opencode/goals/` exists, and it is
// READ-ONLY: the run state is advanced by the host that owns it, so the tick
// never writes inside a goal folder (the plugin's own write guard forbids it).
//
// The decision is the SAME pure function the OpenCode adapter uses, and the
// continuation text is the same one the adapter would send, so a harness driven
// through tick behaves identically to OpenCode for the decision it makes.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseContract } from "../contract/parse"
import { renderTailNote } from "../contract/render"
import { budgetUse, TERMINAL as TERMINAL_STATUSES, type RunState } from "./state"
import { continuationTail, decide, type LoopLimits, type LoopSignals } from "./loop"

/** The plugin's own defaults, so a tick agrees with the adapter unless overridden. */
export const TICK_LIMITS: LoopLimits = { blockerRepeats: 3, stallTurns: 3, recoveryAt: 2, backstopTurns: 200 }
export const TICK_COOLDOWN_MS = 1_500

/** CLEO caps a forwarded reason at 4000 characters. */
export const REASON_CAP = 4_000

export type TickResult = {
  /** Exactly what goes to stdout (empty when no goal is live). */
  stdout: string
  /** Lines for stderr. */
  log: string[]
}

/**
 * Decide what a harness's Stop event should do, for the project at `root`.
 * Pure apart from reading the goal folders, so `test/unit/tick.test.ts` can drive
 * every case over a temp project and `test/host/tick-bin.test.ts` can drive the
 * real bin.
 */
export function tick(options: { root: string; now?: number; limits?: LoopLimits; cooldownMs?: number }): TickResult {
  const { root } = options
  const now = options.now ?? Date.now()
  const limits = options.limits ?? TICK_LIMITS
  const log: string[] = []
  const goalsDir = join(root, ".opencode", "goals")
  // Outside a goal project there is nothing to tick at all - print nothing.
  if (!existsSync(goalsDir)) {
    log.push("no .opencode/goals directory; nothing to tick")
    return { stdout: "", log }
  }

  let live: RunState | undefined
  for (const slug of readdirSync(goalsDir)) {
    let state: RunState
    try {
      state = JSON.parse(readFileSync(join(goalsDir, slug, "run.json"), "utf8")) as RunState
    } catch {
      continue // no run, or unreadable
    }
    if (!state?.slug || TERMINAL_STATUSES.includes(state.status)) continue
    if (!live || (state.updatedAt ?? 0) > (live.updatedAt ?? 0)) live = state
  }
  if (!live) {
    log.push("no live goal here; nothing to tick")
    return { stdout: "", log }
  }

  const read = parseContract(readFileSync(join(goalsDir, live.slug, "goal.yaml"), "utf8"), { slug: live.slug })
  if (!read.contract) {
    log.push(`goal ${live.slug} has no readable contract; holding`)
    return { stdout: JSON.stringify({ final: false }), log }
  }
  const contract = read.contract
  const signals: LoopSignals = {
    turn: "succeeded",
    ...(live.pending ? { pending: live.pending.kind } : {}),
    // The tick does NOT observe the turn's work: progress, file changes and
    // host-visible activity are the host's to record. It therefore decides from
    // the run state as persisted (see the design note for what that excludes).
    changed: false,
    progressRecorded: false,
    stepsChanged: false,
    activeStalled: false,
    stallReason: `stalled: no change the host could see for ${live.counters?.noProgress ?? 0} turns`,
    onStall: contract.autonomy.on_stall,
    budgetRatio: budgetUse(live, contract).ratio,
    backstop: false,
    cooldownMs: options.cooldownMs ?? TICK_COOLDOWN_MS,
    now,
  }
  const action = decide(live, signals, limits)
  const tail = continuationTail(action)
  if (!tail) {
    log.push(`goal ${live.slug}: decision ${action.kind}${action.kind === "stop" ? ` (${action.code})` : ""}; holding the session`)
    return { stdout: JSON.stringify({ final: false }), log }
  }
  const reason = renderTailNote(live, contract, tail, now).slice(0, REASON_CAP)
  log.push(`goal ${live.slug}: decision ${action.kind}; continuing with the ${tail} continuation (${reason.length} chars)`)
  return { stdout: JSON.stringify({ decision: "block", reason }), log }
}
