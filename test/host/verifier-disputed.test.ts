import { expect, test } from "bun:test"
import { goalHost, ledger, newSession, run, script, waitStatus, PLUGIN } from "./goal.helpers"
import { until, type ChatRequest, type Reply } from "./harness"

// T179 — strict mode asks the verifier to confirm criteria the host already
// passed. When the two disagree, the old code replaced the host result with a
// verifier fail, so the owner could not see that a host check HAD passed. The
// disagreement is now its own state (`disputed`), names both sides, stops the
// run for an owner decision, and survives a reload. Owner approval remains the
// way to settle it.

const GOAL = `schema: goal/v1
id: demo
title: Strict dispute demo
intent:
  verbatim: "settle a host and verifier disagreement"
outcome: done.txt exists and states the status
non_goals:
  - Touching any protected file
verification:
  mode: strict
criteria:
  - id: C1
    statement: done.txt SHALL exist
    check: {kind: file, path: done.txt}
  - id: C3
    statement: done.txt states the status in a full line
    check: {kind: verifier, ask: "Does done.txt state that the status is ok in a full line?"}
protect: ["oracle.txt"]
plan:
  - {id: S1, title: Write done.txt, proves: [C1, C3]}
`

const DONE = "status: ok - a disputed criterion\n"
const evidence = { C1: "wrote done.txt", C3: "the file states it" }

const worker = (_request: ChatRequest, turn: { trigger: string; results: number }) => {
  if (turn.trigger.includes("goal started")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", note: "wrote done.txt", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  }
  return { text: "Nothing else to do." }
}

/** Round 1 disputes C1 (host says the file exists, the verifier will not certify
 *  the statement); round 2 — after the owner approval — only C3 is asked. */
let verifierRounds = 0
const verifier = (): Reply => {
  verifierRounds++
  if (verifierRounds === 1)
    return {
      toolCalls: [{ name: "goal_verdict", args: { verdicts: [
        { id: "C1", verdict: "not_proven", reason: "existence alone does not prove the statement" },
        { id: "C3", verdict: "proven", reason: "quoted the line", evidence: [{ path: "done.txt", quote: DONE.trim() }] },
      ] } }],
    }
  return { toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "quoted the line", evidence: [{ path: "done.txt", quote: DONE.trim() }] }] } }] }
}

const plugin = (options: Record<string, unknown>) => ({ package: process.env.OCGOAL_GIT_SPEC ?? PLUGIN, options }) as unknown as string

const reload = async (host: Awaited<ReturnType<typeof goalHost>>) => {
  await host.client.location.reload()
  await until(async () => {
    try {
      await host.client.plugin.list({ location: host.location } as never)
      return true
    } catch {
      return false
    }
  }, 30000)
}

test("a host pass the verifier denies is a disputed criterion that stops the run, survives a reload, and the owner can resolve", async () => {
  verifierRounds = 0
  const host = await goalHost(script(worker as never, verifier), { ".opencode/goals/demo/goal.yaml": GOAL }, { plugin: plugin({ verifierTimeoutMs: 15000, verifierMinRoundMs: 1000, verifierGraceMs: 1000 }) })
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as never)

    // 1. the dispute STOPS the run instead of folding into a plain fail
    const stopped = await waitStatus(host, ["needs_review", "paused", "blocked"], 90000)
    expect(stopped.status).toBe("needs_review")
    expect(stopped.reason).toContain("host and verifier disagree on C1")
    const c1 = stopped.criteria.C1 as { status: string; by?: string; detail?: string }
    expect(c1.status).toBe("disputed")
    expect(c1.by).toBe("disputed")
    expect(c1.detail).toContain("host passed but the verifier says not_proven")

    // 2. the verdict names BOTH sides — the host's observation is not lost
    const verdict = (stopped.verdict?.lines ?? []).join("\n")
    expect(verdict).toContain("C1 DISPUTED")
    expect(verdict).toContain("host passed: done.txt exists")
    expect(verdict).toContain("verifier said not_proven: existence alone does not prove the statement")
    expect(verdict).not.toContain("C1 FAILED")
    // the verifier's own criterion still proved on its merits
    expect(stopped.criteria.C3).toMatchObject({ status: "pass", by: "verifier" })
    expect((await ledger(host)).some((e) => e.type === "disputed" && (e.criteria as string[] | undefined)?.includes("C1"))).toBe(true)

    // 3. the dispute SURVIVES a reload (a run.json field, not process memory)
    await reload(host)
    const afterReload = await run(host)
    expect(afterReload.status).toBe("needs_review")
    expect(afterReload.criteria.C1).toMatchObject({ status: "disputed", by: "disputed" })
    expect(afterReload.criteria.C1.detail).toContain("done.txt")
    expect((afterReload.verdict?.lines ?? []).join("\n")).toContain("C1 DISPUTED")

    // 4. the owner path still resolves it: approve C1 (final) re-verifies the rest
    await host.client.session.command({ sessionID, name: "goal", text: "approve C1" } as never)
    const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 90000)
    expect(done.status).toBe("complete")
    expect(done.criteria.C1).toMatchObject({ status: "pass", by: "human" })
    expect(done.criteria.C3).toMatchObject({ status: "pass" })
  } finally {
    await host.stop()
  }
}, 240000)
