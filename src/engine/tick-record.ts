// v0.7.0 - RECORDING a turn at Stop time, for a harness that is not OpenCode.
//
// The OpenCode adapter records a turn from its own event stream: the turn
// counter, the repository fingerprint, whether the agent called the progress
// tool, and whether a plan step moved. A CLI at a Stop event cannot see the
// session - so this module records ONLY what a Stop-time observer can honestly
// know, and says what it could not see:
//
//   always      the turn increment; the repository fingerprint (a move counts
//               as progress); a claim the run already carries
//   from the    a transcript the Stop payload points at, mined best-effort for
//   payload     tool calls and a progress call - OPTIONAL, and its absence is
//               never an error
//
// It never invents a tool call, a progress call or a live-check transition that
// it did not observe. Everything is written through OCG's own store afterwards,
// so records, ledger and schema stay identical to the adapter's.

import type { Contract } from "../contract/types"
import type { RunState } from "./state"

/** What a Stop-time observer can see, injected so the recorder is testable. */
export type RecordInputs = {
  /** The repository fingerprint now (git), or undefined when it cannot be taken. */
  fingerprint: () => string | undefined
  /** The raw harness Stop payload, if the harness passed one. */
  payload?: string
  /** Read a transcript the payload points at. Absent/unreadable is fine. */
  readTranscript?: (path: string) => string | undefined
  now?: number
}

export type TurnRecord = {
  turn: number
  changed: boolean
  progress: boolean
  claimHonoured: boolean
  /** What the payload mining recovered, when a readable transcript was named. */
  mined?: { transcriptPath: string; toolCalls: number; ownerMessages: number; progressCall: boolean }
  /** What this observer could NOT see, named rather than assumed. */
  couldNotSee: string[]
}

/** The names a progress call may appear under in a transcript. */
const PROGRESS_TOOLS = /goal_progress|progress|goal-status/i

/**
 * Record one turn on `state` (mutating it) and return what was recorded.
 * A missing payload, transcript or fingerprint is a degradation, never an error.
 */
export function recordTurn(state: RunState, _contract: Contract, inputs: RecordInputs): TurnRecord {
  const couldNotSee: string[] = []
  state.turn = (state.turn ?? 0) + 1

  // The fingerprint is the only progress the observer can measure itself.
  let changed = false
  try {
    const fp = inputs.fingerprint()
    changed = fp !== undefined && fp !== state.fingerprint
    state.fingerprint = fp
  } catch {
    couldNotSee.push("the repository fingerprint (it could not be taken)")
  }

  // A claim already on the run is honoured: it is the agent's own statement.
  const claimHonoured = Boolean(state.claim)

  // Best-effort payload mining. A harness without a transcript simply does not
  // get tool-call accounting - and that is stated, not guessed.
  let mined: TurnRecord["mined"]
  let progressCall = false
  const payload = inputs.payload?.trim()
  if (!payload) {
    couldNotSee.push("the agent's tool calls and progress call (the harness passed no Stop payload)")
  } else {
    let transcriptPath: string | undefined
    try {
      const parsed = JSON.parse(payload)
      transcriptPath = typeof parsed?.transcript_path === "string" ? parsed.transcript_path : typeof parsed?.transcriptPath === "string" ? parsed.transcriptPath : undefined
    } catch {
      couldNotSee.push("the Stop payload (it was not JSON)")
    }
    if (!transcriptPath) {
      couldNotSee.push("the agent's tool calls and progress call (the Stop payload named no transcript)")
    } else if (!inputs.readTranscript) {
      couldNotSee.push("the transcript (this build cannot read one)")
    } else {
      let text: string | undefined
      try {
        text = inputs.readTranscript(transcriptPath)
      } catch {
        text = undefined
      }
      if (text === undefined) {
        couldNotSee.push(`the transcript at ${transcriptPath} (absent or unreadable)`)
      } else {
        let toolCalls = 0
        let ownerMessages = 0
        for (const line of text.split("\n")) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let entry: any
          try {
            entry = JSON.parse(trimmed)
          } catch {
            continue // a transcript line we cannot parse is skipped, not counted
          }
          const parts: any[] = Array.isArray(entry?.content) ? entry.content : Array.isArray(entry?.message?.content) ? entry.message.content : []
          if (String(entry?.type ?? entry?.role ?? entry?.message?.role ?? "") === "user") ownerMessages += 1
          for (const part of parts) {
            if (part?.type !== "tool_use" && part?.type !== "tool") continue
            toolCalls += 1
            if (PROGRESS_TOOLS.test(String(part?.name ?? ""))) progressCall = true
          }
        }
        mined = { transcriptPath, toolCalls, ownerMessages, progressCall }
        if (toolCalls === 0 && ownerMessages === 0) couldNotSee.push("any content in the transcript (it parsed but held no tool calls or messages)")
      }
    }
  }

  const progress = changed || progressCall
  state.counters.noProgress = progress ? 0 : (state.counters.noProgress ?? 0) + 1
  state.pending = undefined
  state.turnFacts = { tools: mined?.toolCalls ?? 0, goalCalls: progressCall ? 1 : 0, stepsChanged: false, progressRecorded: progressCall }
  state.updatedAt = inputs.now ?? Date.now()
  state.activity = { kind: "turn", since: state.updatedAt, detail: "tick" }
  return { turn: state.turn, changed, progress, claimHonoured, ...(mined ? { mined } : {}), couldNotSee }
}
