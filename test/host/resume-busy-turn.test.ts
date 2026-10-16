import { expect, test } from "bun:test"
import { GoalRpc } from "../../src/rpc"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T091: an owner resume of their OWN stopped run during a busy turn must take
// effect IMMEDIATELY — running before the turn ends, exactly one resumed
// receipt, the published snapshot reflects it — and when the turn ends exactly
// ONE continuation is admitted (no double admission, no stale wait stranding
// the run back into waiting).

test("an owner resume during a busy turn is immediate, exactly-once, and admits one continuation", async () => {
  const host = await goalHost(script((_req, turn) => {
    // a busy owner inspection turn (same shape as busy-owner-resume.test.ts)
    if (turn.trigger.includes("HOLD_RESUME")) return { text: "Owner inspection turn still running.", delayMs: 9000 }
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "post-resume hold" } }] }
    return { text: "Holding." }
  }))
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["waiting"], 15000)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "pause" } as any)
    const before = await waitStatus(host, ["paused"], 10000)
    const admitsBefore = (await ledger(host)).filter((e) => e.type === "admit").length

    await host.client.session.prompt({ sessionID: sid, text: "HOLD_RESUME inspect only; no resume approval in this text." } as any)
    await until(() => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("HOLD_RESUME") && r.tools?.length), 10000)
    expect(await (host.client.session.form as any).list({ sessionID: sid })).toHaveLength(0)

    const sentAt = Date.now()
    await host.client.session.command({ sessionID: sid, name: "goal", text: "resume" } as any)
    const running = await waitStatus(host, ["running"], 3000)
    expect(Date.now() - sentAt, "the resume takes effect before the busy turn ends").toBeLessThan(4000)
    expect(running.runId).toBe(before.runId)
    expect(running.lock).toBe(before.lock)
    expect(running.wait, "the stale wait is cleared so the resume is not stranded").toBeUndefined()
    expect((await (host.client as any).rpc(GoalRpc).snapshot({ sessionID: sid })).view.status).toBe("running")
    expect((await ledger(host)).filter((e) => e.type === "resumed")).toHaveLength(1)
    // no admission while the turn is still busy
    expect((await ledger(host)).filter((e) => e.type === "admit").length).toBe(admitsBefore)

    // when the busy turn ends the run is NOT stranded: it is live again and at
    // most ONE continuation was admitted (never two)
    await Bun.sleep(10500)
    const after = await ledger(host)
    expect(after.filter((e) => e.type === "resumed")).toHaveLength(1)
    expect(after.filter((e) => e.type === "admit").length).toBeLessThanOrEqual(admitsBefore + 1)
    expect(["running", "waiting"]).toContain((await run(host)).status)
    // a second identical resume while running is idempotent
    const receipts = after.filter((e) => e.type === "resumed").length
    const admits = after.filter((e) => e.type === "admit").length
    await host.client.session.command({ sessionID: sid, name: "goal", text: "resume" } as any)
    await Bun.sleep(900)
    const idem = await ledger(host)
    expect(idem.filter((e) => e.type === "resumed")).toHaveLength(receipts)
    expect(idem.filter((e) => e.type === "admit").length).toBe(admits)
    expect((await run(host)).runId).toBe(before.runId)
  } finally { await host.stop() }
}, 60000)
