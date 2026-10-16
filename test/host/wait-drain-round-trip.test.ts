import { expect, test } from "bun:test"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T092: a wait that expires during a busy owner turn must drain exactly ONE
// continue admission afterwards (never stranded, never double), and a claim
// that ends the wait must cancel the obsolete wait wakeup so the old deadline
// does not verify or admit again.

test("a wait expiring during a busy owner turn drains exactly one continue afterwards", async () => {
  let waits = 0
  const host = await goalHost(script((_req, turn) => {
    if (turn.trigger.includes("BUSY_WAIT")) return { text: "Owner inspection ends normally.", delayMs: 12000 }
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: waits++ === 0 ? 10 : 300, reason: "wait drain round-trip" } }] }
    return { text: "Waiting." }
  }), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const before = await waitStatus(host, ["waiting"], 15000)
    // a busy owner turn overlaps the wait deadline
    await host.client.session.prompt({ sessionID: sid, text: "BUSY_WAIT inspect only, no resume." } as any)
    await until(() => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("BUSY_WAIT") && r.tools?.length), 10000)
    // the deadline passes while the turn is still running: no wake, not stranded
    await Bun.sleep(Math.max(0, before.wait.until - Date.now()) + 500)
    expect((await run(host)).status).toBe("waiting")
    expect((await ledger(host)).filter((e) => e.type === "admit")).toHaveLength(1)
    // when the turn ends, exactly ONE continue is admitted
    const after = await until(async () => { const s = await run(host); return s.turn === 2 && s.status === "waiting" ? s : undefined }, 8000)
    expect(after.runId).toBe(before.runId)
    expect(after.lock).toBe(before.lock)
    await Bun.sleep(500)
    const admits = (await ledger(host)).filter((e) => e.type === "admit")
    expect(admits).toHaveLength(2)
    expect(admits[1]!.kind).toBe("continue")
  } finally { await host.stop() }
}, 60000)

test("a claim ending the wait cancels the obsolete wakeup (no second verify or admit)", async () => {
  const host = await goalHost(script((_req, turn) => {
    if (turn.trigger.includes("CLAIM_NOW") && turn.results === 0)
      return { toolCalls: [{ name: "goal_claim", args: { summary: "marker meets the criteria", evidence: { C1: "marker exists", C2: "grep status ok", C3: "the full line" } } }] }
    if (turn.trigger.includes("CLAIM_NOW")) return { text: "End the claim turn for host verification." }
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok\n" } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_wait", args: { seconds: 12, reason: "wait before the claim" } }] }
    return { text: "Waiting." }
  }, () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the marker states the full line", evidence: [{ path: "done.txt", quote: "status: ok" }] }] } }] })), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const before = await waitStatus(host, ["waiting"], 15000)
    await host.client.session.prompt({ sessionID: sid, text: "CLAIM_NOW claim the verified marker" } as any)
    const complete = await waitStatus(host, ["complete"], 10000)
    expect(complete.runId).toBe(before.runId)
    expect(complete.wait).toBeUndefined()
    // the obsolete wake deadline must produce no second verify and no admit
    await Bun.sleep(Math.max(0, before.wait.until - Date.now()) + 900)
    const events = await ledger(host)
    expect(events.filter((e) => e.type === "verify-start")).toHaveLength(1)
    expect(events.filter((e) => e.type === "complete")).toHaveLength(1)
    expect(events.filter((e) => e.type === "admit")).toHaveLength(1)
    expect((await run(host)).status).toBe("complete")
  } finally { await host.stop() }
}, 60000)
