import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { goalHost, ledger, newSession, run, script, waitStatus, PLUGIN } from "./goal.helpers"
import { until, type ChatRequest, type Reply } from "./harness"

// T178 — a proven verifier verdict is bound to the bytes it read. The host
// re-reads every quote at proof time; here a real host runs one passing
// verifier round, the cited file is then replaced INSIDE THE TEMP PROJECT, and
// the next verification must demote the old pass to `stale` naming the file
// instead of leaving it standing.

const GOAL = `schema: goal/v1
id: demo
title: Verdict binding demo
intent:
  verbatim: "bind the verifier verdict to the bytes it read"
outcome: done.txt states the status and second.txt exists
non_goals:
  - Touching any protected file
criteria:
  - id: C1
    statement: done.txt SHALL exist
    check: {kind: file, path: done.txt}
  - id: C2
    statement: 'done.txt SHALL contain the line "status: ok"'
    check: {kind: command, run: "grep -q 'status: ok' done.txt"}
  - id: C3
    statement: done.txt states the status in a full line
    check: {kind: verifier, ask: "Does done.txt state that the status is ok in a full line?"}
  - id: C4
    statement: second.txt SHALL exist (keeps round 1 from completing)
    check: {kind: file, path: second.txt}
protect: ["oracle.txt"]
plan:
  - {id: S1, title: Write done.txt, proves: [C1, C2, C3, C4]}
`

const FIRST = "status: ok - the bytes the verdict was bound to"
const SECOND = "status: ok - rewritten after the proof"
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it", C4: "not yet" }

const worker = (_request: ChatRequest, turn: { trigger: string; results: number }) => {
  if (turn.trigger.includes("goal started")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: `${FIRST}\n` } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", note: "wrote done.txt", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  }
  if (turn.trigger.includes("host verdict")) {
    // park the loop so the owner (the test) can replace the cited bytes
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 3000, reason: "wait for the owner to re-verify the bound proof" } }] }
  }
  return { text: "Waiting." }
}

/** Round 1 proves C3 with a quote of the original line; round 2 refuses it. */
let verifierRounds = 0
const verifier = (): Reply => {
  verifierRounds++
  if (verifierRounds === 1)
    return { toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "quoted the line", evidence: [{ path: "done.txt", quote: FIRST }] }] } }] }
  return { toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "not_proven", reason: "the quoted line is no longer in done.txt" }] } }] }
}

const plugin = (options: Record<string, unknown>) => ({ package: process.env.OCGOAL_GIT_SPEC ?? PLUGIN, options }) as unknown as string

test("a cited file changed after a passing verdict demotes it to stale, naming the file", async () => {
  verifierRounds = 0
  const host = await goalHost(script(worker as never, verifier), { ".opencode/goals/demo/goal.yaml": GOAL }, { plugin: plugin({ verifierTimeoutMs: 15000, verifierMinRoundMs: 1000, verifierGraceMs: 1000 }) })
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as never)

    // round 1: the verifier proved C3 and the binding landed in the run state
    const proven = await until(async () => {
      const state = await run(host).catch(() => undefined)
      return state?.criteria?.C3?.status === "pass" ? state : undefined
    }, 90000)
    const bound = proven.criteria.C3 as { status: string; by?: string; evidence?: { files?: Record<string, string> } }
    expect(bound.status).toBe("pass")
    expect(bound.by).toBe("verifier")
    expect(bound.evidence?.files?.["done.txt"]).toBe(sha(`${FIRST}\n`))
    // C4 still fails, so the run is not complete and a later verify can run
    expect(proven.criteria.C4?.status).not.toBe("pass")
    expect(proven.status).not.toBe("complete")

    // the loop parks on goal_wait, then the test replaces the cited bytes
    await waitStatus(host, ["waiting"], 30000)
    await Bun.write(join(host.project, "done.txt"), `${SECOND}\n`)
    expect(readFileSync(join(host.project, "done.txt"), "utf8")).toBe(`${SECOND}\n`)

    // a later verification re-runs: the old proof must not stand
    await host.client.session.command({ sessionID, name: "goal", text: "verify" } as never)
    const after = await waitStatus(host, ["paused", "needs_review", "complete"], 90000)
    const c3 = after.criteria.C3 as { status: string; detail?: string; evidence?: { files?: Record<string, string> } }
    expect(c3.status).toBe("stale")
    expect(c3.detail).toContain("done.txt")
    expect(c3.detail).toContain("changed since this criterion was proven")
    // the hash set captured at proof time is kept for audit; it no longer matches
    expect(c3.evidence?.files?.["done.txt"]).toBe(sha(`${FIRST}\n`))
    expect(c3.evidence?.files?.["done.txt"]).not.toBe(sha(`${SECOND}\n`))

    // the verdict says WHICH proof went stale and why
    const verdict = (after.verdict?.lines ?? []).join("\n")
    expect(verdict).toContain("C3 STALE")
    expect(verdict).toContain("done.txt")
    expect(verdict).toContain("Re-prove it against the current bytes")
    // …and the demotion is a durable ledger fact, not only a verdict string
    expect((await ledger(host)).some((e) => e.type === "criterion-stale" && e.criterion === "C3" && e.path === "done.txt")).toBe(true)
  } finally {
    await host.stop()
  }
}, 240000)
