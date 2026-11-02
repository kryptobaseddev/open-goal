import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { lockOf, parseContract } from "../../src/contract/parse"
import { initialRun } from "../../src/engine/state"
import { verifyClaim, type VerifierVerdict } from "../../src/verify/pipeline"

// T179 — strict mode has the verifier re-check criteria the host already
// passed. When the two disagree the old code replaced the host result with a
// verifier fail, losing the fact that a host check had passed at all. A
// disagreement between two honest machines is now its own state (`disputed`),
// names both sides, and cannot pass the run.

const TEXT = `schema: goal/v1
id: t179
title: strict dispute
intent:
  verbatim: settle the disagreement
outcome: status.txt exists and states the status
non_goals: [x]
verification:
  mode: strict
criteria:
  - id: C1
    statement: status.txt exists
    check: {kind: file, path: status.txt}
  - id: C3
    statement: status.txt states the status in a full line
    check: {kind: verifier, ask: "Does status.txt state the status in a full line?"}
plan:
  - {id: S1, title: Write it, proves: [C1, C3]}
`

const LINE = "status: ok - disputed criterion"
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "ocg-t179-"))
  writeFileSync(join(dir, "status.txt"), `${LINE}\n`)
  return dir
}

const contract = () => {
  const parsed = parseContract(TEXT, { slug: "t179" })
  if (!parsed.contract) throw new Error(`fixture invalid: ${JSON.stringify(parsed.issues)}`)
  return parsed.contract
}
const state = (c: ReturnType<typeof contract>) => initialRun(c, { sessionID: "ses_x", runId: "r1", lock: lockOf(TEXT), now: 1 })

const provenC3: VerifierVerdict = { id: "C3", verdict: "proven", reason: "read it", evidence: [{ path: "status.txt", quote: LINE }] }
const deniedC1: VerifierVerdict = { id: "C1", verdict: "not_proven", reason: "existence alone does not prove the statement", evidence: [] }

describe("strict mode: a host pass the verifier denies is disputed, not a silent fail", () => {
  test("the criterion is recorded as disputed and the verdict names BOTH sides", async () => {
    const c = contract()
    const st = state(c)
    const outcome = await verifyClaim(c, st, {
      root: root(),
      contractText: TEXT,
      shell: async () => ({ exit: 0, stdout: "", stderr: "", ms: 1, timedOut: false }),
      verifier: async () => ({ verdicts: [deniedC1, provenC3], by: "verifier" }),
    })
    const c1 = outcome.results.find((r) => r.id === "C1")!
    expect(c1.pass).toBe(false)
    expect(c1.by).toBe("disputed")
    expect(c1.dispute).toMatchObject({ verdict: "not_proven", reason: "existence alone does not prove the statement" })
    // the host's own observation is preserved verbatim
    expect(c1.dispute?.host).toContain("status.txt exists")
    expect(c1.dispute?.verifier).toContain("existence alone does not prove the statement")
    expect(outcome.disputed).toEqual(["C1"])
    expect(outcome.passed).toBe(false)
    const lines = outcome.lines.join("\n")
    expect(lines).toContain("C1 DISPUTED")
    expect(lines).toContain("host passed:")
    expect(lines).toContain("verifier said not_proven")
    // C3 was still proven on its own merits
    expect(outcome.results.find((r) => r.id === "C3")).toMatchObject({ pass: true, by: "verifier" })
  })

  test("the owner resolves it: an owner-approved criterion is final and the run can pass", async () => {
    const c = contract()
    const st = state(c)
    const first = await verifyClaim(c, st, {
      root: root(),
      contractText: TEXT,
      shell: async () => ({ exit: 0, stdout: "", stderr: "", ms: 1, timedOut: false }),
      verifier: async () => ({ verdicts: [deniedC1, provenC3], by: "verifier" }),
    })
    expect(first.disputed).toEqual(["C1"])

    // the owner approves the disputed criterion (native form / /goal approve C1)
    st.criteria.C1 = { status: "pass", by: "human", at: 2, detail: "approved by the owner", rejections: 0 }

    const asked: string[] = []
    const second = await verifyClaim(c, st, {
      root: root(),
      contractText: TEXT,
      shell: async () => ({ exit: 0, stdout: "", stderr: "", ms: 1, timedOut: false }),
      verifier: async (input) => {
        asked.push(...input.criteria.map((x) => x.id))
        return { verdicts: [provenC3], by: "verifier" }
      },
    })
    // the approval is final: the verifier is never asked about C1 again
    expect(asked).not.toContain("C1")
    expect(second.disputed).toEqual([])
    expect(second.results.find((r) => r.id === "C1")).toMatchObject({ pass: true, by: "human" })
    expect(second.passed).toBe(true)
  })

  test("a verifier that does not answer is not a dispute — it still fails closed", async () => {
    const c = contract()
    const st = state(c)
    const outcome = await verifyClaim(c, st, {
      root: root(),
      contractText: TEXT,
      shell: async () => ({ exit: 0, stdout: "", stderr: "", ms: 1, timedOut: false }),
      verifier: async () => ({ verdicts: [provenC3], by: "verifier", error: "no verdict for C1" }),
    })
    const c1 = outcome.results.find((r) => r.id === "C1")!
    expect(c1.by).toBe("verifier")
    expect(c1.pass).toBe(false)
    expect(c1.dispute).toBeUndefined()
    expect(outcome.disputed).toEqual([])
    expect(outcome.passed).toBe(false)
  })

  test("an unverifiable 'proven' quote is a fail, not a dispute", async () => {
    const c = contract()
    const st = state(c)
    const outcome = await verifyClaim(c, st, {
      root: root(),
      contractText: TEXT,
      shell: async () => ({ exit: 0, stdout: "", stderr: "", ms: 1, timedOut: false }),
      verifier: async () => ({ verdicts: [{ id: "C1", verdict: "proven", evidence: [{ path: "status.txt", quote: "this line is nowhere in the file" }] }, provenC3], by: "verifier" }),
    })
    const c1 = outcome.results.find((r) => r.id === "C1")!
    expect(c1.by).toBe("verifier")
    expect(c1.dispute).toBeUndefined()
    expect(c1.detail).toContain("host passed but verifier disagrees")
  })
})
