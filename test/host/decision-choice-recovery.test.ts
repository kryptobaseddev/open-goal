import { expect, test } from "bun:test"
import { GoalRpc } from "../../src/rpc"
import { goalHost, ledger, newSession, run, script, text, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T085: a decision choice that arrives before / independent of its native form
// is delivered exactly once when the form resolves (bounded, explicit missed
// event recovery). A cancelled/interrupted choice never executes or logs a
// success, and a stale form id cannot re-execute a settled decision.

function choiceHost() {
  const asked = new Set<string>()
  const yaml = `schema: goal/v1
id: demo
title: Decision choice recovery
intent: {verbatim: inspect pre-form decision choice recovery}
outcome: marker exists or the owner makes one exact decision
non_goals: [production changes, fake consent]
criteria:
  - id: C1
    statement: one.txt exists
    check: {kind: file, path: one.txt}
verification: {mode: host, max_rejections: 1}
`
  return goalHost(script((req, turn) => {
    const lines = req.messages.map(text).join("\n").split("\n")
    const payload = lines.findLast((l) => l.startsWith("GOAL_DECISION_JSON:"))
    const presentation = lines.findLast((l) => l.startsWith("GOAL_DECISION_ASK:"))
    if (payload && presentation && !asked.has(presentation)) {
      asked.add(presentation)
      return { toolCalls: [{ name: "question", args: JSON.parse(payload.slice("GOAL_DECISION_JSON:".length)) }] }
    }
    if (turn.results === 0 && !payload) return { toolCalls: [{ name: "goal_claim", args: { summary: "Request review of the missing marker", evidence: { C1: "owner reviews C1" } } }] }
    return { text: "End the turn; only an actual owner selection may approve." }
  }), { ".opencode/goals/demo/goal.yaml": yaml }, { plugin: process.env.OCGOAL_GIT_SPEC })
}

const decisionForm = async (host: Awaited<ReturnType<typeof choiceHost>>, sid: string) => until(async () => {
  const forms: any[] = await (host.client.session.form as any).list({ sessionID: sid })
  return forms.find((f) => f.fields?.some((field: any) => field.options?.some((o: any) => o.label.startsWith("Approve"))))
}, 15000)

test("a decision choice is delivered exactly once; a cancelled or stale choice never executes or logs success", async () => {
  const host = await choiceHost()
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const before = await waitStatus(host, ["needs_review"], 20000)
    const form = await decisionForm(host, sid)
    const store = JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json"))
    const request: any = Object.values(store.requests).find((r: any) => r.formID === form.id)
    expect(request.target).toMatchObject({ slug: "demo", runId: before.runId })

    // cancel the form: the interrupted choice is explicit and never approves
    await (host.client.session.form as any).cancel({ sessionID: sid, formID: form.id })
    await until(async () => JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json")).requests[request.id].status === "interrupted", 10000)
    expect((await ledger(host)).filter((e) => e.type === "approve")).toHaveLength(0)
    expect((await run(host)).criteria.C1.by).not.toBe("human")

    // recovering re-presents the decision without inferring any choice, target intact
    const rpc = (host.client as any).rpc(GoalRpc)
    const result = await rpc.review({ sessionID: sid, decisionId: request.id })
    expect(String(result.message ?? "")).toMatch(/nothing was approved|no choice|inferred/i)
    expect(String(result.message ?? "")).not.toMatch(/approved the|resolved successfully/i)
    const nextForm = await decisionForm(host, sid)
    const afterStore = JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json"))
    const next: any = Object.values(afterStore.requests).find((r: any) => r.formID === nextForm.id)
    expect(next.target).toEqual(request.target)

    // the recovered exact choice approves exactly once
    const option = nextForm.fields[0].options.find((o: any) => o.label.startsWith("Approve C1"))
    await (host.client.session.form as any).reply({ sessionID: sid, formID: nextForm.id, answer: { [nextForm.fields[0].key]: option.value } })
    await until(async () => (await run(host)).criteria.C1.by === "human", 15000)
    expect((await ledger(host)).filter((e) => e.type === "approve")).toHaveLength(1)

    // a stale reply to the OLD form id never re-executes the settled decision
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { [form.fields[0].key]: form.fields[0].options[0].value } }).catch(() => {})
    await Bun.sleep(500)
    expect((await ledger(host)).filter((e) => e.type === "approve")).toHaveLength(1)
  } finally { await host.stop() }
}, 90000)
