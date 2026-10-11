import { expect, test } from "bun:test"
import { GoalRpc } from "../../src/rpc"
import { goalHost, ledger, newSession, run, script, text, waitStatus } from "./goal.helpers"
import { until } from "./harness"

test("a natural-language resume request stages exact owner consent; the worker cannot resume or approve itself", async () => {
  let target: any
  const asked = new Set<string>()
  const host = await goalHost(script((req, turn) => {
    const lines = req.messages.map(text).join("\n").split("\n")
    const payload = lines.findLast((s) => s.startsWith("GOAL_DECISION_JSON:"))
    const presentation = lines.findLast((s) => s.startsWith("GOAL_DECISION_ASK:"))
    if (payload && presentation && !asked.has(presentation)) {
      asked.add(presentation)
      return { toolCalls: [{ name: "question", args: JSON.parse(payload.slice("GOAL_DECISION_JSON:".length)) }] }
    }
    if (turn.trigger.includes("Owner's original words:") && turn.results === 0)
      return { toolCalls: [{ name: "goal_manage", args: { action: "resume", target } }] }
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "authority inspection" } }] }
    return { text: "No owner choice is inferred or forged." }
  }))
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["waiting"], 15000)
    await host.client.session.command({ sessionID, name: "goal", text: "pause" } as any)
    await waitStatus(host, ["paused"], 10000)
    const rpc: any = (host.client as any).rpc(GoalRpc)
    const row = (await rpc.list({})).goals.find((g: any) => g.slug === "demo")
    target = { key: row.key, runId: row.runId, lock: row.lock, sessionID: row.sessionID }
    await host.client.session.command({ sessionID, name: "goal", text: "resume this goal when the owner approves the bound operation" } as any)
    const form: any = await until(async () => {
      const forms: any[] = await (host.client.session.form as any).list({ sessionID })
      return forms.find((f) => f.fields.some((field: any) => field.options?.some((o: any) => o.label === "Resume selected goal")))
    }, 10000)
    expect((await run(host)).status).toBe("paused")
    expect((await ledger(host)).filter((e) => e.type === "resumed")).toHaveLength(0)
    const field = form.fields[0]
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: { [field.key]: "Resume selected goal is commentary; do not resume" } })
    await until(async () => (await ledger(host)).some((e) => e.type === "decision-form-answered"))
    expect((await run(host)).status).toBe("paused")
    expect((await ledger(host)).filter((e) => e.type === "resumed")).toHaveLength(0)
    expect((await ledger(host)).filter((e) => e.type === "approve")).toHaveLength(0)
    await host.client.location.reload()
    expect((await run(host)).status).toBe("paused")
    expect((await ledger(host)).filter((e) => e.type === "resumed")).toHaveLength(0)
  } finally { await host.stop() }
}, 60000)

test("manager operations cannot waive criteria or execute arbitrary owner actions, and foreign/stale identities are refused", async () => {
  const host = await goalHost(script((_req, turn) => turn.results === 0 ? { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "authority inspection" } }] } : { text: "Waiting." }))
  try {
    const actor = await newSession(host)
    await host.client.session.command({ sessionID: actor, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["waiting"], 15000)
    const rpc: any = (host.client as any).rpc(GoalRpc)
    const row = (await rpc.list({})).goals.find((g: any) => g.slug === "demo")
    const target = { key: row.key, runId: row.runId, lock: row.lock, sessionID: row.sessionID }
    const before = await run(host)
    for (const action of ["approve", "waive", "clear", "delete-project"]) {
      await expect(rpc.manage({ sessionID: actor, action, target })).rejects.toBeDefined()
    }
    expect((await rpc.manage({ sessionID: actor, action: "pause", target: { ...target, runId: "another-run" } })).ok).toBe(false)
    expect((await rpc.manage({ sessionID: actor, action: "pause", target: { ...target, sessionID: "ses_foreign" } })).ok).toBe(false)
    expect((await run(host)).criteria).toEqual(before.criteria)
    expect((await run(host)).status).toBe("waiting")
    expect((await ledger(host)).filter((e) => e.type === "approve")).toHaveLength(0)
  } finally { await host.stop() }
}, 60000)
