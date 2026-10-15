import { expect, test } from "bun:test"
import { DEMO_GOAL, PLUGIN, goalHost, ledger, newSession, script, waitStatus } from "./goal.helpers"
import type { ChatRequest } from "./harness"

// T107: the criterion could not say which model judges it, so a fast model could
// burn the whole budget on reading. The contract now names the verifier model
// and effort; an invalid value falls back to the default resolution and the
// ledger records why, so a typo never blocks a run.

const DONE = "status: ok - verifier model\n"
const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }

const worker = (_request: ChatRequest, turn: { trigger: string; results: number }) => {
  if (turn.trigger.includes("goal started") || turn.trigger.includes("host verdict")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  }
  return { text: "Nothing else to do." }
}

const verifier = () => ({
  toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the file states it", evidence: [{ path: "done.txt", quote: DONE.trim() }] }] } }],
})

test("a contract-named verifier model and effort are used for the child", async () => {
  const goal = DEMO_GOAL + 'verification: {mode: host+verifier, model: "fixture/test", effort: "high"}\n'
  const host = await goalHost(script(worker as never, verifier), { ".opencode/goals/demo/goal.yaml": goal }, { plugin: PLUGIN })
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as never)
    const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 90000)
    expect(done.status).toBe("complete")
    const events = await ledger(host)
    expect(events.find((e) => e.type === "verifier-model")?.model).toBe("fixture/test#high")
    expect(events.some((e) => e.type === "verifier-model-fallback")).toBe(false)
    const verifierRequests = host.fixture.requests.filter((r) => JSON.stringify(r.messages).includes("independent completion verifier"))
    expect(verifierRequests.length).toBeGreaterThan(0)
    // the child ran on the named model (the wire id is the model id)
    expect(String(verifierRequests[0]!.model)).toContain("test")
  } finally { await host.stop() }
}, 120000)

test("an invalid contract model falls back to the default with the reason journalled", async () => {
  const goal = DEMO_GOAL + 'verification: {mode: host+verifier, model: "nonsense-model"}\n'
  const host = await goalHost(script(worker as never, verifier), { ".opencode/goals/demo/goal.yaml": goal }, { plugin: PLUGIN })
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as never)
    const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 90000)
    expect(done.status).toBe("complete")
    const events = await ledger(host)
    const fallback = events.find((e) => e.type === "verifier-model-fallback")
    expect(fallback, "an invalid model records a fallback reason").toBeTruthy()
    expect(String(fallback!.reason)).toContain("providerID/modelID")
    expect(fallback!.requested).toBe("nonsense-model")
    expect(String(fallback!.used)).toContain("fixture/test")
    expect(String(events.find((e) => e.type === "verifier-model")?.model)).toContain("fixture/test")
  } finally { await host.stop() }
}, 120000)
