import { expect, test } from "bun:test"
import { GoalRpc, type GoalTarget } from "../../src/rpc"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, text, waitStatus } from "./goal.helpers"

// T094: a focused manager action must dispatch EXACTLY ONCE against the bound
// panel actor and the exact selected target, or show explicit scoped
// pending/unavailable feedback — it must never silently no-op and must never
// affect another session's goal. The native Enter/pointer route lands on this
// same rpc.manage/rpc.act contract.

async function managerHost() {
  const asked = new Set<string>()
  return goalHost(script((req, turn) => {
    const lines = req.messages.map(text).join("\n").split("\n")
    const payload = lines.findLast((s) => s.startsWith("GOAL_DECISION_JSON:"))
    const presentation = lines.findLast((s) => s.startsWith("GOAL_DECISION_ASK:"))
    if (payload && presentation && !asked.has(presentation)) {
      asked.add(presentation)
      return { toolCalls: [{ name: "question", args: JSON.parse(payload.slice("GOAL_DECISION_JSON:".length)) }] }
    }
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "manager activation inspection" } }] }
    return { text: "Waiting for the owner's manager action." }
  }), { ".opencode/goals/second/goal.yaml": DEMO_GOAL.replace("id: demo", "id: second").replace("Demo file says ok", "Second independent goal") })
}

async function selected(rpc: any, slug: string): Promise<GoalTarget> {
  const goal = (await rpc.list({})).goals.find((g: any) => g.slug === slug && !g.archived)
  return { key: goal.key, runId: goal.runId, lock: goal.lock, sessionID: goal.sessionID }
}

async function twoGoals(host: Awaited<ReturnType<typeof goalHost>>) {
  const primary = await newSession(host), one = await newSession(host), two = await newSession(host)
  await host.client.session.command({ sessionID: one, name: "goal", text: "start demo" } as any)
  await waitStatus(host, ["waiting"], 15000)
  await host.client.session.command({ sessionID: two, name: "goal", text: "start second" } as any)
  await waitStatus(host, ["waiting"], 15000, "second")
  return { primary, one, two, rpc: (host.client as any).rpc(GoalRpc) }
}

test("a focused manager action dispatches once on the selected target and never on another session", async () => {
  const host = await managerHost()
  try {
    const { primary, two, rpc } = await twoGoals(host)
    const target = await selected(rpc, "demo")
    const before = (await ledger(host)).filter((e) => e.type === "paused").length
    const result = await rpc.manage({ sessionID: primary, action: "pause", target })
    expect(result.ok).toBe(true)
    await waitStatus(host, ["paused"], 10000)
    // exactly one dispatch on the selected goal...
    expect((await ledger(host)).filter((e) => e.type === "paused").length).toBe(before + 1)
    // ...and the other session's goal is untouched
    expect((await run(host, "second")).status).toBe("waiting")
    expect((await run(host, "second")).sessionID).toBe(two)
  } finally { await host.stop() }
}, 90000)

test("a redundant or unavailable manager action returns explicit scoped feedback, never a silent no-op", async () => {
  const host = await managerHost()
  try {
    const { primary, rpc } = await twoGoals(host)
    const target = await selected(rpc, "demo")
    expect((await rpc.manage({ sessionID: primary, action: "pause", target })).ok).toBe(true)
    await waitStatus(host, ["paused"], 10000)
    const paused = (await ledger(host)).filter((e) => e.type === "paused").length
    // pausing an already-paused goal: explicit scoped feedback, no second dispatch
    const again = await rpc.manage({ sessionID: primary, action: "pause", target })
    expect(again.ok).toBe(false)
    expect(String(again.message ?? "")).toMatch(/paused|only|not|already/i)
    expect((await ledger(host)).filter((e) => e.type === "paused").length).toBe(paused)
    // a stale/mismatched target is refused explicitly and changes nothing
    const stale = await rpc.manage({ sessionID: primary, action: "resume", target: { ...target, lock: "0".repeat(64) } })
    expect(stale.ok).toBe(false)
    expect((await run(host)).status).toBe("paused")
    expect((await run(host)).lock).toBe(target.lock)
  } finally { await host.stop() }
}, 90000)
