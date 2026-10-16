import { describe, expect, test } from "bun:test"
import { recordTurn } from "../../src/engine/tick-record"
import { initialRun, type RunState } from "../../src/engine/state"
import { parseContract } from "../../src/contract/parse"

// v0.7.0 - what a Stop-time observer may record. The honesty rule is the point:
// the tick records the turn, the fingerprint it can take and a claim the run
// carries; it MINES a transcript only when the payload points at a readable one;
// and it names what it could not see instead of inventing it.

const contract = parseContract(`schema: goal/v1\nid: demo\ntitle: demo\nintent:\n  verbatim: "x"\noutcome: y\nnon_goals: [z]\ncriteria:\n  - id: C1\n    statement: s\n    check: {kind: file, path: f}\n`).contract!

const state = (over: Partial<RunState> = {}): RunState => {
  const base = initialRun(contract, { sessionID: "ses_x", runId: "r1", lock: "a".repeat(64), now: 1 })
  return { ...base, turn: 2, status: "running", ...over, counters: { noProgress: 0, failures: 0, ...(over.counters ?? {}) } }
}

const transcript = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n")
const toolUse = (name: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", name }] } })
const userMsg = { type: "user", message: { content: [{ type: "text", text: "hi" }] } }

describe("recording a turn at Stop time (v0.7.0)", () => {
  test("the turn increments and the fingerprint move counts as progress", () => {
    const s = state({ turn: 2, fingerprint: "fp-A" })
    const record = recordTurn(s, contract, { fingerprint: () => "fp-B", now: 5 })
    expect(record.turn).toBe(3)
    expect(s.turn).toBe(3)
    expect(record.changed).toBe(true)
    expect(record.progress).toBe(true)
    expect(s.counters.noProgress).toBe(0)
    expect(s.fingerprint).toBe("fp-B")
    expect(s.pending).toBeUndefined()
  })

  test("a fingerprint that did not move is not progress, and the counter advances", () => {
    const s = state({ fingerprint: "fp-A", counters: { noProgress: 2, failures: 0 } })
    const record = recordTurn(s, contract, { fingerprint: () => "fp-A", now: 5 })
    expect(record.changed).toBe(false)
    expect(record.progress).toBe(false)
    expect(s.counters.noProgress).toBe(3)
  })

  test("a fingerprint that cannot be taken is stated, not treated as no progress by accident", () => {
    const s = state({ fingerprint: "fp-A" })
    const record = recordTurn(s, contract, {
      fingerprint: () => {
        throw new Error("git unavailable")
      },
      now: 5,
    })
    expect(record.couldNotSee.join(" ")).toContain("fingerprint")
    expect(record.changed).toBe(false)
  })

  test("a claim already on the run is honoured", () => {
    const s = state({ claim: { at: 1, turn: 2, summary: "done", evidence: {} } })
    const record = recordTurn(s, contract, { fingerprint: () => "fp", now: 5 })
    expect(record.claimHonoured).toBe(true)
  })

  test("a payload naming a readable transcript is MINED for tool calls and a progress call", () => {
    const s = state()
    const body = transcript([userMsg, toolUse("shell"), toolUse("goal_progress"), toolUse("write")])
    const record = recordTurn(s, contract, {
      fingerprint: () => "fp",
      payload: JSON.stringify({ hook_event_name: "Stop", transcript_path: "/tmp/t.jsonl" }),
      readTranscript: () => body,
      now: 5,
    })
    expect(record.mined).toMatchObject({ transcriptPath: "/tmp/t.jsonl", toolCalls: 3, ownerMessages: 1, progressCall: true })
    expect(record.progress).toBe(true) // the progress call is real progress
    expect(s.turnFacts.tools).toBe(3)
    expect(s.turnFacts.progressRecorded).toBe(true)
  })

  test("a transcript WITHOUT a progress call does not fabricate one", () => {
    const s = state({ fingerprint: "fp", counters: { noProgress: 1, failures: 0 } })
    const record = recordTurn(s, contract, {
      fingerprint: () => "fp",
      payload: JSON.stringify({ transcript_path: "/tmp/t.jsonl" }),
      readTranscript: () => transcript([userMsg, toolUse("shell")]),
      now: 5,
    })
    expect(record.mined).toMatchObject({ toolCalls: 1, progressCall: false })
    expect(record.progress).toBe(false)
    expect(s.counters.noProgress).toBe(2)
  })

  test("degradations are NAMED: no payload, a non-JSON payload, no transcript named, an unreadable transcript", () => {
    const noPayload = recordTurn(state(), contract, { fingerprint: () => "fp" })
    expect(noPayload.couldNotSee.join(" ")).toContain("no Stop payload")

    const badPayload = recordTurn(state(), contract, { fingerprint: () => "fp", payload: "not json" })
    expect(badPayload.couldNotSee.join(" ")).toContain("not JSON")

    const noPath = recordTurn(state(), contract, { fingerprint: () => "fp", payload: JSON.stringify({ hook_event_name: "Stop" }) })
    expect(noPath.couldNotSee.join(" ")).toContain("named no transcript")

    const unreadable = recordTurn(state(), contract, { fingerprint: () => "fp", payload: JSON.stringify({ transcript_path: "/gone" }), readTranscript: () => undefined })
    expect(unreadable.couldNotSee.join(" ")).toContain("/gone")
    expect(unreadable.mined).toBeUndefined()

    // every degradation still recorded the turn honestly
    expect(noPayload.turn).toBe(3)
    expect(unreadable.turn).toBe(3)
  })

  test("an empty but readable transcript is stated rather than counted as work", () => {
    const record = recordTurn(state(), contract, { fingerprint: () => "fp", payload: JSON.stringify({ transcript_path: "/tmp/empty" }), readTranscript: () => "" })
    expect(record.mined).toMatchObject({ toolCalls: 0, ownerMessages: 0 })
    expect(record.couldNotSee.join(" ")).toContain("no tool calls or messages")
  })
})
