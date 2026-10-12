import { expect, test } from "bun:test"
import { join } from "node:path"
import { goalHost, ledger, newSession, run, script, text, waitStatus } from "./goal.helpers"
import { until } from "./harness"
import { GoalRpc } from "../../src/rpc"

test("an aged Composer lifecycle review still resumes exactly once without a clock window", async () => {
  const asked = new Set<string>()
  let target: any
  const host = await goalHost(script((request, turn) => {
    const lines = request.messages.map(text).join("\n").split("\n")
    const payload = lines.findLast((line) => line.startsWith("GOAL_DECISION_JSON:"))
    const presentation = lines.findLast((line) => line.startsWith("GOAL_DECISION_ASK:"))
    if (payload && !asked.has(presentation ?? payload)) {
      asked.add(presentation ?? payload)
      return { toolCalls: [{ name: "question", args: JSON.parse(payload.slice("GOAL_DECISION_JSON:".length)) }] }
    }
    if (turn.trigger.includes("REQUEST_REVIEW") && turn.results === 0)
      return { toolCalls: [{ name: "goal_manage", args: { action: "resume", target } }] }
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "target-bound review inspection" } }] }
    return { text: "No source consent manufactured." }
  }))
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const initial = await waitStatus(host, ["waiting"], 15000)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "pause" } as any)
    await waitStatus(host, ["paused"], 10000)
    target = { key: `live:demo:${initial.runId}`, runId: initial.runId, lock: initial.lock, sessionID: sid }
    await host.client.session.prompt({ sessionID: sid, text: "REQUEST_REVIEW show the exact question; no approval yet." } as any)
    const decision = await until(async () => (await ledger(host)).findLast((e) => e.type === "decision" && e.kind === "owner-operation"), 10000)
    const form = await until(async () => (await (host.client.session.form as any).list({ sessionID: sid })).find((f: any) => JSON.stringify(f).includes(decision.decisionId)), 10000)
    const file = join(host.project, ".opencode/goals/.owner-decisions.json")
    const before: any = await Bun.file(file).json()
    expect(before.requests[decision.decisionId].expiryPolicy).toBe("target")
    before.requests[decision.decisionId].createdAt -= 86400000
    await Bun.write(file, JSON.stringify(before)) // trusted fixture simulates elapsed wall time, not consent
    const field = form.fields[0], choice = field.options.find((o: any) => o.label === "Resume selected goal")
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { [field.key]: choice.value } })
    const resumed = await waitStatus(host, ["waiting"], 15000)
    expect(resumed.runId).toBe(initial.runId)
    expect(resumed.lock).toBe(initial.lock)
    const receipts = await ledger(host)
    expect(receipts.filter((e) => e.type === "resumed")).toHaveLength(1)
    expect(receipts.filter((e) => e.type === "decision-resolved" && e.decision === decision.decisionId && e.ok === true)).toHaveLength(1)
    const record: any = await Bun.file(file).json()
    expect(record.requests[decision.decisionId].status).toBe("succeeded")
  } finally { await host.stop() }
}, 45000)

test("repeating the exact destructive review preserves its nonce and never invalidates the pending Composer form", async () => {
  const host = await goalHost(script((_request, turn) => turn.results === 0
    ? { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "repeated native review inspection" } }] }
    : { text: "Holding; no consent supplied." }))
  try {
    const sid = await newSession(host), actor = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const initial = await waitStatus(host, ["waiting"], 15000)
    const rpc: any = (host.client as any).rpc(GoalRpc)
    const input = { sessionID: actor, action: "abort", target: { key: `live:demo:${initial.runId}`, runId: initial.runId, lock: initial.lock, sessionID: sid } }
    const first = await rpc.manage(input), second = await rpc.manage(input)
    expect(first.pending).toBe(true)
    expect(second.pending).toBe(true)
    expect(second.decisionId).toBe(first.decisionId)
    expect((await ledger(host)).filter((e) => e.type === "decision" && e.kind === "owner-operation")).toHaveLength(1)
    expect((await run(host)).status).toBe("waiting")
    expect((await ledger(host)).filter((e) => e.type === "decision-resolved" && e.decision === first.decisionId)).toHaveLength(0)
  } finally { await host.stop() }
}, 45000)
