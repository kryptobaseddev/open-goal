import { expect, test } from "bun:test"
import { GoalRpc } from "../../src/rpc"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

test("direct owner resume updates the exact paused run during a busy turn without a competing kickoff", async () => {
  const host = await goalHost(script((_req, turn) => {
    if (turn.trigger.includes("HOLD_RESUME_TURN")) return { text: "Owner inspection turn still in progress.", delayMs: 8000 }
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "busy owner resume inspection" } }] }
    return { text: "Holding for inspection." }
  }))
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["waiting"], 15000)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "pause" } as any)
    const before = await waitStatus(host, ["paused"], 10000)
    const receipts = await ledger(host)
    await host.client.session.prompt({ sessionID: sid, text: "HOLD_RESUME_TURN inspect only; no resume approval in this text." } as any)
    await until(() => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("HOLD_RESUME_TURN") && r.tools?.length), 10000)
    expect(await (host.client.session.form as any).list({ sessionID: sid })).toHaveLength(0)
    const sentAt = Date.now()
    await host.client.session.command({ sessionID: sid, name: "goal", text: "resume" } as any)
    const resumed = await waitStatus(host, ["running"], 2500)
    expect(Date.now() - sentAt).toBeLessThan(4000)
    expect(resumed.runId).toBe(before.runId)
    expect(resumed.lock).toBe(before.lock)
    const snapshot = await (host.client as any).rpc(GoalRpc).snapshot({ sessionID: sid })
    expect(snapshot.view.status).toBe("running")
    const after = await ledger(host)
    expect(after.filter((e) => e.type === "resumed")).toHaveLength(1)
    expect(after.filter((e) => e.type === "admit")).toHaveLength(receipts.filter((e) => e.type === "admit").length)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "pause" } as any)
    expect((await run(host)).status).toBe("paused")
  } finally { await host.stop() }
}, 45000)
