import { expect, test } from "bun:test"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"

// T092: a waiting run's claim processed behind a BUSY owner turn must verify
// exactly once and admit at most one continuation. The busy claim turn holds
// the session past the old wait deadline, so the wake path and the claim path
// could each try to advance the run.

test("a waiting run's claim behind a busy turn verifies exactly once", async () => {
  const host = await goalHost(script((_req, turn) => {
    if (turn.trigger.includes("CLAIM_BUSY") && turn.results === 0)
      return {
        toolCalls: [{ name: "goal_claim", args: { summary: "marker meets the criteria", evidence: { C1: "marker exists", C2: "grep status ok", C3: "the full line" } } }],
        delayMs: 5000,
      }
    if (turn.trigger.includes("CLAIM_BUSY")) return { text: "End the claimed turn for host verification." }
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok\n" } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_wait", args: { seconds: 15, reason: "wait before the busy claim" } }] }
    return { text: "Waiting." }
  }, () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the marker states the full line", evidence: [{ path: "done.txt", quote: "status: ok" }] }] } }] })), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const before = await waitStatus(host, ["waiting"], 15000)
    // the claim turn is busy (5s) and overlaps the wait deadline
    await host.client.session.prompt({ sessionID: sid, text: "CLAIM_BUSY claim then end the turn." } as any)
    const complete = await waitStatus(host, ["complete"], 12000)
    expect(complete.runId).toBe(before.runId)
    expect(complete.lock).toBe(before.lock)
    expect(Object.values(complete.criteria).every((c: any) => c.status === "pass")).toBe(true)
    // past the old wake deadline: no second verify, no extra admit
    await Bun.sleep(Math.max(0, before.wait.until - Date.now()) + 900)
    const events = await ledger(host)
    expect(events.filter((e) => e.type === "verify-start")).toHaveLength(1)
    expect(events.filter((e) => e.type === "complete")).toHaveLength(1)
    expect(events.filter((e) => e.type === "admit")).toHaveLength(1)
    expect((await run(host)).status).toBe("complete")
  } finally { await host.stop() }
}, 60000)
