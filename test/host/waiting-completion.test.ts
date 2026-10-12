import { expect, test } from "bun:test"
import { GoalRpc } from "../../src/rpc"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

test("a claim made during an active wait verifies automatically at execution end, not at the old wake deadline", async () => {
  const host = await goalHost(script((_req, turn) => {
    if (turn.trigger.includes("CLAIM_DURING_WAIT") && turn.results === 0)
      return { toolCalls: [{ name: "goal_claim", args: { summary: "The marker meets every criterion", evidence: { C1: "marker exists", C2: "marker states status ok", C3: "independent verifier checks the full line" } } }] }
    if (turn.trigger.includes("CLAIM_DURING_WAIT")) return { text: "End the claim turn for host verification." }
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok\n" } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_wait", args: { seconds: 10, reason: "wait before completion inspection" } }] }
    return { text: "Waiting for inspection." }
  }, () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "The marker contains the complete status ok line", evidence: [{ path: "done.txt", quote: "status: ok" }] }] } }] })), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const before = await waitStatus(host, ["waiting"], 15000)
    expect(await host.readProject("done.txt")).toBe("status: ok\n")
    await host.client.session.prompt({ sessionID: sid, text: "CLAIM_DURING_WAIT claim the verified marker, then end the turn." } as any)
    const complete = await waitStatus(host, ["complete"], 6500)
    expect(complete.runId).toBe(before.runId)
    expect(complete.lock).toBe(before.lock)
    expect(complete.wait).toBeUndefined()
    expect(Object.values(complete.criteria).every((c: any) => c.status === "pass")).toBe(true)
    expect((await (host.client as any).rpc(GoalRpc).snapshot({ sessionID: sid })).view.status).toBe("complete")
    await Bun.sleep(Math.max(0, before.wait.until - Date.now()) + 500)
    const events = await ledger(host)
    expect(events.filter((e) => e.type === "verify-start")).toHaveLength(1)
    expect(events.filter((e) => e.type === "complete")).toHaveLength(1)
    expect(events.filter((e) => e.type === "admit")).toHaveLength(1)
    expect((await run(host)).status).toBe("complete")
  } finally { await host.stop() }
}, 45000)

test("an expired wait respects an unrelated native form, then wakes once; pause still stops it", async () => {
  let waits = 0
  const host = await goalHost(script((_req, turn) => turn.results === 0
    ? { toolCalls: [{ name: "goal_wait", args: { seconds: waits++ === 0 ? 10 : 300, reason: "native form hold inspection" } }] }
    : { text: "Waiting for inspection." }), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const before = await waitStatus(host, ["waiting"], 15000)
    const form = await (host.client.session.form as any).create({ sessionID: sid, title: "Unrelated inspection hold", fields: [{ key: "q0", type: "string", custom: true, options: [{ label: "Release inspection hold", value: "release" }] }] })
    await Bun.sleep(Math.max(0, before.wait.until - Date.now()) + 500)
    expect((await run(host)).status).toBe("waiting")
    expect((await ledger(host)).filter((e) => e.type === "admit")).toHaveLength(1)
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { q0: "release" } })
    const after = await until(async () => { const s = await run(host); return s.turn === 2 && s.status === "waiting" ? s : undefined }, 6000)
    expect(after.runId).toBe(before.runId)
    expect((await ledger(host)).filter((e) => e.type === "admit")).toHaveLength(2)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "pause" } as any)
    await Bun.sleep(1100)
    expect((await run(host)).status).toBe("paused")
    expect((await ledger(host)).filter((e) => e.type === "admit")).toHaveLength(2)
  } finally { await host.stop() }
}, 45000)

test("an expired wait held by owner execution wakes once after that execution ends", async () => {
  let waits = 0
  const host = await goalHost(script((_req, turn) => {
    if (turn.trigger.includes("BUSY_WAIT_EXPIRY")) return { text: "Owner inspection ends normally.", delayMs: 12000 }
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: waits++ === 0 ? 10 : 300, reason: "owner busy wait expiry inspection" } }] }
    return { text: "Waiting for the owner's inspection." }
  }), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const before = await waitStatus(host, ["waiting"], 15000)
    await host.client.session.prompt({ sessionID: sid, text: "BUSY_WAIT_EXPIRY inspect only, without requesting resume." } as any)
    await until(() => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("BUSY_WAIT_EXPIRY") && r.tools?.length), 10000)
    await Bun.sleep(Math.max(0, before.wait.until - Date.now()) + 500)
    expect((await run(host)).status).toBe("waiting")
    expect((await ledger(host)).filter((e) => e.type === "admit")).toHaveLength(1)
    const after = await until(async () => { const s = await run(host); return s.turn === 2 && s.status === "waiting" ? s : undefined }, 6000)
    expect(after.runId).toBe(before.runId)
    expect(after.lock).toBe(before.lock)
    await Bun.sleep(500)
    expect((await ledger(host)).filter((e) => e.type === "admit")).toHaveLength(2)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "pause" } as any)
    expect((await run(host)).status).toBe("paused")
  } finally { await host.stop() }
}, 45000)
