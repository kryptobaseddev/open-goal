import { expect, test } from "bun:test"
import { GoalRpc, type GoalTarget } from "../../src/rpc"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, text, waitStatus } from "./goal.helpers"
import { until } from "./harness"

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
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "manager action inspection" } }] }
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

test("manager targets pause/resume/verify/attach to the selected goal even when the actor owns ANOTHER goal", async () => {
  const host = await managerHost()
  try {
    const { primary, one, two, rpc } = await twoGoals(host)
    let target = await selected(rpc, "demo")
    expect((await rpc.manage({ sessionID: two, action: "pause", target })).ok).toBe(true)
    await waitStatus(host, ["paused"], 10000)
    expect((await run(host, "second")).status).toBe("waiting")
    expect((await run(host)).sessionID).toBe(one)
    const bad = await rpc.manage({ sessionID: primary, action: "resume", target: { ...target, lock: "0".repeat(64) } })
    expect(bad.ok).toBe(false)
    expect((await run(host)).status).toBe("paused")
    const details = await rpc.details({ key: target.key })
    expect(details.goal.details.criteria.map((c: any) => c.id)).toEqual(["C1", "C2", "C3"])
    expect(details.goal.sessionID).toBe(one)
    expect((await rpc.manage({ sessionID: primary, action: "resume", target })).ok).toBe(true)
    await waitStatus(host, ["waiting"], 15000)
    expect((await run(host, "second")).status).toBe("waiting")
    expect((await rpc.manage({ sessionID: primary, action: "pause", target })).ok).toBe(true)
    await waitStatus(host, ["paused"], 10000)
    const checked = await rpc.manage({ sessionID: primary, action: "verify", target })
    expect(checked.ok).toBe(true)
    expect((await run(host)).verdict).toBeDefined()
    expect((await run(host, "second")).verdict).toBeUndefined()
    // Failed verification may continue under the original contract; pause
    // its loop before moving its session ownership.
    if (["running", "waiting"].includes((await run(host)).status)) await rpc.manage({ sessionID: primary, action: "pause", target })
    await waitStatus(host, ["paused", "needs_review"], 10000)
    target = await selected(rpc, "demo")
    const before = await run(host)
    expect((await rpc.manage({ sessionID: primary, action: "attach", target })).ok).toBe(true)
    const after = await run(host)
    expect(after.sessionID).toBe(primary)
    expect(after.runId).toBe(before.runId)
    expect(after.criteria).toEqual(before.criteria)
    expect((await run(host, "second")).sessionID).toBe(two)
    expect((await rpc.manage({ sessionID: two, action: "pause", target })).ok).toBe(false) // old owner identity rejected
  } finally { await host.stop() }
}, 120000)

test("abort is a native bound decision, not a direct/destructive manager call; cancel and acceptance never change the other goal", async () => {
  const host = await managerHost()
  try {
    const { primary, rpc } = await twoGoals(host)
    const target = await selected(rpc, "demo")
    await rpc.manage({ sessionID: primary, action: "pause", target })
    await waitStatus(host, ["paused"], 10000)
    const forms = async () => {
      const listed: any[] = await (host.client.session.form as any).list({ sessionID: primary })
      return listed.find((f) => f.fields.some((field: any) => field.options?.some((o: any) => o.label === "Abort selected goal")))
    }
    const prepared = await rpc.manage({ sessionID: primary, action: "abort", target })
    expect(prepared).toMatchObject({ ok: true, pending: true })
    expect((await run(host)).status).toBe("paused")
    let form = await until(forms, 10000)
    let field = form.fields[0]
    await (host.client.session.form as any).reply({ sessionID: primary, formID: form.id, answer: { [field.key]: field.options.find((o: any) => o.label === "Cancel operation").value } })
    await until(async () => (await ledger(host)).some((e) => e.type === "decision-declined"))
    expect((await run(host)).status).toBe("paused")
    const again = await rpc.manage({ sessionID: primary, action: "abort", target })
    expect(again.pending).toBe(true)
    form = await until(forms, 10000)
    field = form.fields[0]
    await (host.client.session.form as any).reply({ sessionID: primary, formID: form.id, answer: { [field.key]: field.options.find((o: any) => o.label === "Abort selected goal").value } })
    await waitStatus(host, ["aborted"], 10000)
    expect((await run(host, "second")).status).toBe("waiting")
    expect((await ledger(host)).filter((e) => e.type === "aborted")).toHaveLength(1)
  } finally { await host.stop() }
}, 90000)
