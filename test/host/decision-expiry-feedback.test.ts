import { expect, test } from "bun:test"
import { join } from "node:path"
import { GoalRpc } from "../../src/rpc"
import { goalHost, ledger, newSession, run, script, text, waitStatus } from "./goal.helpers"
import { until } from "./harness"

test("an expired native resume answer reports failure, never succeeds, and leaves an explicit recoverable review", async () => {
  const asked = new Set<string>()
  let target: any
  const host = await goalHost(script((request, turn) => {
    const payload = request.messages.map(text).join("\n").split("\n").findLast((line) => line.startsWith("GOAL_DECISION_JSON:"))
    const presentation = request.messages.map(text).join("\n").split("\n").findLast((line) => line.startsWith("GOAL_DECISION_ASK:"))
    if (payload && !asked.has(presentation ?? payload)) {
      asked.add(presentation ?? payload)
      return { toolCalls: [{ name: "question", args: JSON.parse(payload.slice("GOAL_DECISION_JSON:".length)) }] }
    }
    if (turn.trigger.includes("REQUEST_REVIEW") && turn.results === 0)
      return { toolCalls: [{ name: "goal_manage", args: { action: "resume", target } }] }
    if (turn.trigger.includes("goal started") && turn.results === 0)
      return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "Exact resume review expiry test" } }] }
    return { text: "No consent inferred." }
  }), {}, { plugin: join(import.meta.dir, "../fixtures/short-decision-review") })
  const rpc: any = (host.client as any).rpc(GoalRpc)
  const failures: any[] = []
  const off = rpc.events.on("decision.failed", (event: any) => failures.push(event.data))
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const state = await waitStatus(host, ["waiting"], 15000)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "pause" } as any)
    await waitStatus(host, ["paused"], 10000)
    target = { key: `live:demo:${state.runId}`, sessionID: sid, runId: state.runId, lock: state.lock }
    await host.client.session.prompt({ sessionID: sid, text: "REQUEST_REVIEW stage the exact review; no approval yet." } as any)
    const review = await until(async () => (await ledger(host)).findLast((e) => e.type === "decision" && e.kind === "owner-operation"), 10000)
    const form = await until(async () => {
      const forms: any[] = await (host.client.session.form as any).list({ sessionID: sid })
      return forms.find((f) => JSON.stringify(f).includes(review.decisionId))
    }, 4000)
    await Bun.sleep(5250)
    const field = form.fields[0], option = field.options.find((o: any) => o.label === "Resume selected goal")
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { [field.key]: option.value } })
    await until(() => failures.find((f) => f.decisionId === review.decisionId), 10000)
    expect(failures.find((f) => f.decisionId === review.decisionId).message).toContain("nothing executed")
    expect((await run(host)).status).toBe("paused")
    expect((await ledger(host)).filter((e) => e.type === "decision-resolved" && e.decision === review.decisionId)).toHaveLength(0)
    expect((await ledger(host)).some((e) => e.type === "decision-form-operation-failed" && e.decision === review.decisionId && e.ok === false)).toBe(true)
    await host.client.session.prompt({ sessionID: sid, text: "REQUEST_REVIEW create a fresh exact review; no consent granted." } as any)
    const next = await until(async () => (await ledger(host)).findLast((e) => e.type === "decision" && e.kind === "owner-operation" && e.decisionId !== review.decisionId), 10000)
    expect(next.decisionId).not.toBe(review.decisionId)
  } finally { off(); await host.stop() }
}, 45000)
