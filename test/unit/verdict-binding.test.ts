import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lockOf, parseContract } from "../../src/contract/parse"
import { initialRun, type RunState } from "../../src/engine/state"
import { Store } from "../../src/engine/store"
import { digestOf, shortDigest, staleBindings } from "../../src/verify/evidence"
import { verifyClaim, type VerifyOutcome, type VerifierVerdict } from "../../src/verify/pipeline"

// T178 — a proven verifier verdict is bound to the bytes it read. The host
// re-reads every quote at proof time, but the old proof used to outlive the
// file: a later round could carry a "pass" whose cited line no longer existed.
// These tests pin the binding (sha256 per cited file), its appearance in the
// verdict detail, and the demotion to `stale` when those bytes move.

const TEXT = `schema: goal/v1
id: t178
title: verdict binding
intent:
  verbatim: prove the binding
outcome: status.txt states the status
non_goals: [x]
criteria:
  - id: C1
    statement: status.txt exists
    check: {kind: file, path: status.txt}
  - id: C2
    statement: the line is present
    check: {kind: command, run: "grep -q 'status: ok' status.txt"}
  - id: C3
    statement: status.txt states the status in a full line
    check: {kind: verifier, ask: "Does status.txt state the status in a full line?"}
plan:
  - {id: S1, title: Write it, proves: [C1, C2, C3]}
`

const LINE = "status: ok - verdict bound to these exact bytes"
const SECOND = "status: ok - rewritten after the proof"

const project = (body = LINE): string => {
  const root = mkdtempSync(join(tmpdir(), "ocg-t178-"))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "status.txt"), `${body}\n`)
  return root
}

const contract = () => {
  const parsed = parseContract(TEXT, { slug: "t178" })
  if (!parsed.contract) throw new Error(`fixture invalid: ${JSON.stringify(parsed.issues)}`)
  return parsed.contract
}

const state = (c: ReturnType<typeof contract>) => initialRun(c, { sessionID: "ses_x", runId: "r1", lock: lockOf(TEXT), now: 1 })

const proven = (quote: string): VerifierVerdict => ({ id: "C3", verdict: "proven", reason: "read the line", evidence: [{ path: "status.txt", quote }] })
const notProven: VerifierVerdict = { id: "C3", verdict: "not_proven", reason: "the quoted line is no longer the file", evidence: [] }

/** The app's write-back, reduced to what matters here: results land in state. */
function apply(st: RunState, results: VerifyOutcome["results"]) {
  for (const r of results) {
    const prev = st.criteria[r.id] ?? { status: "unknown" as const, rejections: 0 }
    st.criteria[r.id] = { status: r.pass ? "pass" : "fail", by: r.by, at: 2, detail: r.detail, rejections: prev.rejections, ...(r.evidence ? { evidence: r.evidence } : {}) }
  }
}

describe("a proven verifier verdict records the sha256 of every file it cited", () => {
  test("the state carries one digest per cited file and the verdict detail names them", async () => {
    const root = project()
    const c = contract()
    const st = state(c)
    const outcome = await verifyClaim(c, st, {
      root,
      contractText: TEXT,
      shell: async (command) => ({ exit: command.includes("grep") ? 0 : 1, stdout: "", stderr: "", ms: 1, timedOut: false }),
      verifier: async () => ({ verdicts: [proven(LINE)], by: "verifier" }),
    })
    expect(outcome.passed).toBe(true)
    const c3 = outcome.results.find((r) => r.id === "C3")!
    expect(c3.pass).toBe(true)
    expect(c3.by).toBe("verifier")
    // the full sha256, keyed by the path the verifier cited
    expect(c3.evidence?.files).toEqual({ "status.txt": digestOf(`${LINE}\n`) })
    // …and the detail a human reads names the digest
    expect(c3.detail).toContain(`bound sha256 status.txt=${shortDigest(digestOf(`${LINE}\n`))}`)

    apply(st, outcome.results)
    expect(st.criteria.C3?.evidence?.files?.["status.txt"]).toBe(digestOf(`${LINE}\n`))
  })

  test("every cited file is bound, not just the first", async () => {
    const root = project()
    writeFileSync(join(root, "other.txt"), "second cited line about the status\n")
    const c = contract()
    const st = state(c)
    const outcome = await verifyClaim(c, st, {
      root,
      contractText: TEXT,
      shell: async () => ({ exit: 0, stdout: "", stderr: "", ms: 1, timedOut: false }),
      verifier: async () => ({
        verdicts: [{ id: "C3", verdict: "proven", reason: "two files", evidence: [{ path: "status.txt", quote: LINE }, { path: "other.txt", quote: "second cited line about the status" }] }],
        by: "verifier",
      }),
    })
    const c3 = outcome.results.find((r) => r.id === "C3")!
    expect(Object.keys(c3.evidence!.files).sort()).toEqual(["other.txt", "status.txt"])
    expect(c3.evidence!.files["other.txt"]).toBe(digestOf("second cited line about the status\n"))
  })
})

describe("a moved cited file demotes the old pass instead of standing", () => {
  test("a changed file becomes stale, the verdict names the file, and the run cannot pass", async () => {
    const root = project()
    const c = contract()
    const st = state(c)
    const shell = async (command: string) => ({ exit: command.includes("grep") ? 0 : 1, stdout: "", stderr: "", ms: 1, timedOut: false })

    // round 1: proven, and the state now carries the binding
    const first = await verifyClaim(c, st, { root, contractText: TEXT, shell, verifier: async () => ({ verdicts: [proven(LINE)], by: "verifier" }) })
    expect(first.passed).toBe(true)
    apply(st, first.results)
    expect(st.criteria.C3?.status).toBe("pass")
    expect(st.criteria.C3?.evidence?.files?.["status.txt"]).toBe(digestOf(`${LINE}\n`))

    // the bytes the proof was bound to are replaced
    writeFileSync(join(root, "status.txt"), `${SECOND}\n`)

    // round 2: the verifier no longer proves it
    const second = await verifyClaim(c, st, { root, contractText: TEXT, shell, verifier: async () => ({ verdicts: [notProven], by: "verifier" }) })
    // demoted in the state BEFORE any caller writes the round's results back
    expect(st.criteria.C3?.status).toBe("stale")
    expect(st.criteria.C3?.detail).toContain("status.txt")
    expect(second.demotions).toHaveLength(1)
    expect(second.demotions?.[0]).toMatchObject({ criterion: "C3", path: "status.txt" })
    expect(second.demotions?.[0]?.was).toBe(digestOf(`${LINE}\n`))
    expect(second.passed).toBe(false)
    const verdict = second.lines.join("\n")
    expect(verdict).toContain("C3 STALE")
    expect(verdict).toContain("status.txt")
    expect(verdict).toContain("changed since this criterion was proven")
  })

  test("a fresh proof of the new bytes restores the pass with the new digest", async () => {
    const root = project()
    const c = contract()
    const st = state(c)
    const shell = async () => ({ exit: 0, stdout: "", stderr: "", ms: 1, timedOut: false })
    const first = await verifyClaim(c, st, { root, contractText: TEXT, shell, verifier: async () => ({ verdicts: [proven(LINE)], by: "verifier" }) })
    apply(st, first.results)
    writeFileSync(join(root, "status.txt"), `${SECOND}\n`)

    const second = await verifyClaim(c, st, { root, contractText: TEXT, shell, verifier: async () => ({ verdicts: [proven(SECOND)], by: "verifier" }) })
    expect(second.passed).toBe(true)
    expect(second.demotions?.map((d) => d.criterion)).toEqual(["C3"])
    // re-proven this round: the demotion does not block the pass…
    expect(second.lines.join("\n")).not.toContain("C3 STALE")
    apply(st, second.results)
    expect(st.criteria.C3?.status).toBe("pass")
    expect(st.criteria.C3?.evidence?.files?.["status.txt"]).toBe(digestOf(`${SECOND}\n`))
  })

  test("an unchanged file is not demoted", async () => {
    const root = project()
    const c = contract()
    const st = state(c)
    const shell = async () => ({ exit: 0, stdout: "", stderr: "", ms: 1, timedOut: false })
    const first = await verifyClaim(c, st, { root, contractText: TEXT, shell, verifier: async () => ({ verdicts: [proven(LINE)], by: "verifier" }) })
    apply(st, first.results)
    const second = await verifyClaim(c, st, { root, contractText: TEXT, shell, verifier: async () => ({ verdicts: [proven(LINE)], by: "verifier" }) })
    expect(second.demotions).toEqual([])
    expect(staleBindings(root, st.criteria, new Set(["C3"]))).toEqual([])
  })

  test("a host pass is never bound to verifier evidence", async () => {
    const root = project()
    const c = contract()
    const st = state(c)
    // a host-proven criterion with a (nonsensical) bound file that moves
    st.criteria.C1 = { status: "pass", by: "host", rejections: 0, evidence: { files: { "status.txt": digestOf("old bytes") } } }
    writeFileSync(join(root, "status.txt"), "changed\n")
    expect(staleBindings(root, st.criteria, new Set(["C3"]))).toEqual([])
  })
})

describe("additive state", () => {
  test("a run.json written before these fields existed still parses", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocg-t178-store-"))
    const goals = join(root, ".opencode", "goals", "legacy")
    mkdirSync(goals, { recursive: true })
    writeFileSync(join(goals, "goal.yaml"), TEXT.replace("id: t178", "id: legacy"))
    const legacy = {
      version: 1,
      slug: "legacy",
      title: "legacy",
      sessionID: "ses_x",
      runId: "r1",
      lock: lockOf(TEXT),
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      turn: 1,
      activeMs: 0,
      activeSince: 1,
      usage: { tokens: 0, cost: 0, baseTokens: null, baseCost: null },
      base: {},
      counters: { noProgress: 0, failures: 0 },
      wrapup: false,
      // the pre-T178 shape: no evidence field, no stale/disputed statuses
      criteria: { C1: { status: "pass", by: "verifier", rejections: 0 }, C3: { status: "pass", by: "verifier", rejections: 0 } },
      steps: { S1: "active" },
      turnFacts: { tools: 0, goalCalls: 0, stepsChanged: false, progressRecorded: false },
      steers: 0,
      compacted: false,
      flags: [],
      amendments: [],
    }
    writeFileSync(join(goals, "run.json"), `${JSON.stringify(legacy, null, 2)}\n`)
    const read = new Store(root).readRun("legacy")
    expect(read?.criteria.C3).toMatchObject({ status: "pass", by: "verifier" })
    expect(read?.criteria.C3?.evidence).toBeUndefined()
    // and a verification over it does not throw or demote what it cannot bind
    const parsed = parseContract(TEXT.replace("id: t178", "id: legacy"), { slug: "legacy" })
    const outcome = await verifyClaim(parsed.contract!, read!, {
      root,
      contractText: TEXT.replace("id: t178", "id: legacy"),
      shell: async () => ({ exit: 0, stdout: "", stderr: "", ms: 1, timedOut: false }),
      verifier: async () => ({ verdicts: [notProven], by: "verifier" }),
    })
    expect(outcome.demotions).toEqual([])
  })
})
