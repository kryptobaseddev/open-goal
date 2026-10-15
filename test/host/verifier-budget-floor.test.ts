import { expect, test } from "bun:test"
import { DEFAULTS } from "../../src/server/app"
import { DEMO_GOAL, PLUGIN, goalHost, newSession, script, waitStatus } from "./goal.helpers"
import type { ChatRequest, Reply } from "./harness"

// T110: the verdict-handling tests could not run quickly because the round
// budget was clamped to a hard 60s floor, so the suite took minutes. The floor
// is now owner/config-overridable; with it below 60s this test must finish well
// under 90 seconds AND still prove a late goal_verdict is used rather than
// thrown away as a timeout.

const DONE = "status: ok - budget floor\n"
const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }

const worker = (_request: ChatRequest, turn: { trigger: string; results: number }) => {
  if (turn.trigger.includes("goal started") || turn.trigger.includes("host verdict")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  }
  return { text: "Nothing else to do." }
}

// The child answers just AFTER the 1.2s round budget but inside the grace window.
const lateVerifier = (): Reply => ({
  delayMs: 1800,
  toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "late but still an answer", evidence: [{ path: "done.txt", quote: DONE.trim() }] }] } }],
})

const plugin = (options: Record<string, unknown>) => ({ package: process.env.OCGOAL_GIT_SPEC ?? PLUGIN, options }) as unknown as string

test("with the per-round floor below 60s the test finishes under 90s and a late verdict is used", async () => {
  const started = Date.now()
  const host = await goalHost(script(worker as never, lateVerifier), {}, { plugin: plugin({ verifierTimeoutMs: 1200, verifierMinRoundMs: 1000, verifierGraceMs: 4000 }) })
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as never)
    const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 90000)
    const elapsed = Date.now() - started
    expect(done.status).toBe("complete")
    // the late goal_verdict is used, not discarded as a timeout
    expect(done.criteria.C3).toMatchObject({ status: "pass", by: "verifier" })
    expect(elapsed, "the criterion allows under 90s").toBeLessThan(90000)
    expect(elapsed, "and it clearly did not wait out the old 60s floor").toBeLessThan(40000)
  } finally { await host.stop() }
}, 120000)

test("the default per-round floor stays 60s", () => {
  expect(DEFAULTS.verifierMinRoundMs).toBe(60000)
  expect(DEFAULTS.verifierTimeoutMs).toBe(240000)
})
