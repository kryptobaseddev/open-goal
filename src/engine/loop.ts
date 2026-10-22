// v0.6.0 - the loop's DECISION, extracted from the OpenCode adapter.
//
// `decide(state, signals, limits)` is PURE: no filesystem, no network, no
// OpenCode types. The adapter calls it from `onTurnEnd` and maps the action onto
// its existing calls (setStatus, ledger, decide dialog, admit/schedule); the `ocg
// tick` entry point calls it and maps the action onto CLEO's tick contract. One
// loop, many harnesses.
//
// Parity is the point: each action here corresponds to a branch the adapter
// already took, and the TailKind of a continuation is the same one the adapter
// already sent. `test/unit/loop-decision.test.ts` pins every case and
// docs/research/harness-agnostic-loop-decision.md carries the parity table.

import type { TailKind } from "../contract/render"
import type { RunState, Status } from "./state"

/** How the harness reported the turn ending. */
export type LoopTurn = "succeeded" | "failed" | "interrupted"

/** The owner-set and host-set bounds the decision reads (never hard-coded here). */
export type LoopLimits = {
  blockerRepeats: number
  stallTurns: number
  recoveryAt: number
  backstopTurns: number
}

/** Everything the decision needs, gathered by the caller (all pure data). */
export type LoopSignals = {
  turn: LoopTurn
  /** The kind of continuation the host had pending for this turn, if any. */
  pending?: TailKind
  /** Host-visible repository change since the last turn. */
  changed: boolean
  /** The agent recorded progress with the progress tool this turn. */
  progressRecorded: boolean
  /** A plan step changed state this turn. */
  stepsChanged: boolean
  /** A stalled run whose recent turns showed host-visible activity. */
  activeStalled: boolean
  /** The reason text for a stall (already formatted by the adapter). */
  stallReason: string
  /** The owner-set stall policy from the contract. */
  onStall: "pause" | "continue"
  /** Budget consumed, 0..1+ (the adapter computes it). */
  budgetRatio: number
  /** No contract budget, and the backstop turn count was reached. */
  backstop: boolean
  /** The adapter's cooldown between scheduled continuations. */
  cooldownMs: number
  now?: number
}

/** What the loop decided to do next. */
export type LoopAction =
  | { kind: "none" }
  | { kind: "verify" }
  | { kind: "admit"; tail: TailKind }
  | { kind: "schedule"; tail: TailKind; delayMs: number; waiting?: { reason: string } }
  | { kind: "stop"; status: Status; code: "blocked" | "stalled" | "budget" | "backstop" | "wrapup"; reason: string }

/**
 * The one decision. Ordering mirrors the adapter exactly:
 * claim -> kickoff -> wrap-up done -> blocked -> budget/backstop -> stall ->
 * wait -> continue (recovery when progress has been missing long enough).
 */
export function decide(state: RunState, signals: LoopSignals, limits: LoopLimits): LoopAction {
  // A failed or interrupted turn is the adapter's failure path, not this one.
  if (signals.turn !== "succeeded") return { kind: "none" }
  // Only a running run continues; a WAITING run continues only because it claimed.
  if (state.status !== "running" && !(state.status === "waiting" && state.claim)) return { kind: "none" }
  if (state.claim) return { kind: "verify" }
  if (state.turn === 0) return { kind: "admit", tail: "kickoff" }
  if (signals.pending === "wrapup")
    return { kind: "stop", status: "budget_limited", code: "wrapup", reason: "budget used; wrap-up turn done" }
  if (state.blocker && state.blocker.count >= limits.blockerRepeats)
    return { kind: "stop", status: "blocked", code: "blocked", reason: `${state.blocker.key}: ${state.blocker.reason}` }
  if (signals.budgetRatio >= 1 || signals.backstop) {
    // One wrap-up turn is admitted before the run stops for the owner.
    if (!state.wrapup) return { kind: "admit", tail: "wrapup" }
    // D9: a backstop stop is NOT an exhausted budget. It means no contract
    // budget was set at all, so it gets its own status and a reason that names
    // the remedy instead of pretending the owner's budget ran out.
    if (signals.backstop)
      return { kind: "stop", status: "backstop_limited", code: "backstop", reason: `backstop of ${limits.backstopTurns} turns reached; no contract budget set — set budget.turns to control the run` }
    return { kind: "stop", status: "budget_limited", code: "budget", reason: "budget used" }
  }
  if (state.counters.noProgress >= limits.stallTurns) {
    // Owner-set policy: a genuinely stalled-but-active run may continue with a
    // recorded report instead of pausing. Idle runs and the default still stop.
    if (signals.activeStalled && signals.onStall === "continue")
      return { kind: "schedule", tail: "continue", delayMs: signals.cooldownMs }
    return { kind: "stop", status: "paused", code: "stalled", reason: signals.stallReason }
  }
  const now = signals.now ?? Date.now()
  if (state.wait && state.wait.until > now)
    return { kind: "schedule", tail: "continue", delayMs: state.wait.until - now, waiting: { reason: state.wait.reason } }
  return { kind: "schedule", tail: state.counters.noProgress >= limits.recoveryAt ? "recovery" : "continue", delayMs: signals.cooldownMs }
}

/**
 * The continuation text this action produces, as the OpenCode adapter would send
 * it. `null` means the loop is not sending a continuation for this action (it is
 * verifying or stopping), which is what the tick reports as `{"final":false}`.
 */
export function continuationTail(action: LoopAction): TailKind | null {
  switch (action.kind) {
    case "admit":
    case "schedule":
      return action.tail
    default:
      return null
  }
}
