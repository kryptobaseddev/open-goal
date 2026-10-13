import { expect, test } from "bun:test"
import { join } from "node:path"
import { GoalRpc } from "../../src/rpc"
import { goalHost, ledger, newSession, run, script, text, waitStatus } from "./goal.helpers"
import { until } from "./harness"

function reviewHost(two = false) {
  const asked = new Set<string>()
  const yaml = `schema: goal/v1
id: demo
title: Criterion-specific owner review
intent: {verbatim: inspect rejected criterion review}
outcome: marker files exist or owner makes an explicit final decision
non_goals: [production changes, fake consent]
criteria:
  - id: C1
    statement: one.txt exists
    check: {kind: file, path: one.txt}
${two ? "  - id: C2\n    statement: two.txt exists\n    check: {kind: file, path: two.txt}\n" : ""}verification: {mode: host, max_rejections: 1}
`
  return goalHost(script((req, turn) => {
    const lines = req.messages.map(text).join("\n").split("\n")
    const payload = lines.findLast((l) => l.startsWith("GOAL_DECISION_JSON:"))
    const presentation = lines.findLast((l) => l.startsWith("GOAL_DECISION_ASK:"))
    if (payload && presentation && !asked.has(presentation)) {
      asked.add(presentation)
      return { toolCalls: [{ name: "question", args: JSON.parse(payload.slice("GOAL_DECISION_JSON:".length)) }] }
    }
    if (turn.results === 0 && !payload) return { toolCalls: [{ name: "goal_claim", args: { summary: "Request review of missing markers", evidence: { C1: "owner reviews the missing marker", ...(two ? { C2: "owner reviews the second missing marker" } : {}) } } }] }
    return { text: "End the turn; only actual owner selection may approve." }
  }), { ".opencode/goals/demo/goal.yaml": yaml }, { plugin: process.env.OCGOAL_GIT_SPEC })
}
const pending = async (host: Awaited<ReturnType<typeof reviewHost>>, sid: string) => until(async () => {
  const forms: any[] = await (host.client.session.form as any).list({ sessionID: sid })
  return forms.find((f) => f.fields?.some((field: any) => field.options?.some((o: any) => o.label.startsWith("Approve"))))
}, 15000)

test("rejected-criterion native selection approves its exact criterion and verifies the rest", async () => {
  const host = await reviewHost()
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const before = await waitStatus(host, ["needs_review"], 20000)
    const form = await pending(host, sid)
    const store = JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json"))
    const request: any = Object.values(store.requests).find((r: any) => r.formID === form.id)
    const choice = request.message.choices.find((c: any) => c.act === "approve")
    expect(choice.arg).toBe("C1")
    expect(choice.label).toContain("C1")
    const field = form.fields[0], option = field.options.find((o: any) => o.label === choice.label)
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { [field.key]: option.value } })
    const done = await waitStatus(host, ["complete"], 15000)
    expect(done.runId).toBe(before.runId)
    expect(done.lock).toBe(before.lock)
    expect(done.criteria.C1).toMatchObject({ status: "pass", by: "human" })
    expect(await host.readProject("one.txt").catch(() => undefined)).toBeUndefined() // explicit owner-final, not fabricated host pass
    expect((await ledger(host)).filter((e) => e.type === "approve").map((e) => e.criterion)).toEqual(["C1"])
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { [field.key]: option.value } }).catch(() => {})
    expect((await ledger(host)).filter((e) => e.type === "approve")).toHaveLength(1)
  } finally { await host.stop() }
}, 60000)

test("a legacy unbound failed review gets a fresh nonce, never replayed approval", async () => {
  const host = await reviewHost()
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const before = await waitStatus(host, ["needs_review"], 20000)
    const form = await pending(host, sid)
    const file = join(host.project, ".opencode/goals/.owner-decisions.json")
    const saved = JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json"))
    const old: any = Object.values(saved.requests).find((r: any) => r.formID === form.id)
    await (host.client.session.form as any).cancel({ sessionID: sid, formID: form.id })
    await until(async () => JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json")).requests[old.id].status === "interrupted", 10000)
    // Fixture-owned legacy packet only; do not mint consent or edit source.
    const data = JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json"))
    const legacy = data.requests[old.id]
    const approve = legacy.message.choices.find((c: any) => c.act === "approve")
    delete approve.arg
    approve.label = "Approve as-is (final, triggers verify)"
    approve.run = "/goal approve <C#>"
    legacy.result = 'Unknown criterion "".'
    await Bun.write(file, JSON.stringify(data))
    const rpc = (host.client as any).rpc(GoalRpc)
    const result = await rpc.review({ sessionID: sid, decisionId: old.id })
    expect(result.message).toContain("nothing was approved or executed")
    const nextForm = await pending(host, sid)
    const afterStore = JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json"))
    const next: any = Object.values(afterStore.requests).find((r: any) => r.formID === nextForm.id)
    expect(next.id).not.toBe(old.id)
    expect(next.target).toEqual(old.target)
    expect(next.message.choices.find((c: any) => c.act === "approve").arg).toBe("C1")
    expect(afterStore.requests[old.id].status).toBe("cancelled")
    expect((await ledger(host)).filter((e) => e.type === "approve")).toHaveLength(0)
    expect((await run(host)).criteria.C1.by).not.toBe("human")
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { q0: "Approve as-is (final, triggers verify)" } }).catch(() => {})
    expect((await ledger(host)).filter((e) => e.type === "approve")).toHaveLength(0)
    const option = nextForm.fields[0].options.find((o: any) => o.label.startsWith("Approve C1"))
    await (host.client.session.form as any).reply({ sessionID: sid, formID: nextForm.id, answer: { [nextForm.fields[0].key]: option.value } })
    const done = await waitStatus(host, ["complete"], 15000)
    expect(done.runId).toBe(before.runId)
    expect(done.criteria.C1).toMatchObject({ status: "pass", by: "human" })
    expect((await ledger(host)).filter((e) => e.type === "approve")).toHaveLength(1)
  } finally { await host.stop() }
}, 60000)

test("multiple rejected criteria are separate offered approvals, not an implicit group", async () => {
  const host = await reviewHost(true)
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["needs_review"], 20000)
    const form = await pending(host, sid)
    const store = JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json"))
    const request: any = Object.values(store.requests).find((r: any) => r.formID === form.id)
    expect(request.message.choices.filter((c: any) => c.act === "approve").map((c: any) => c.arg)).toEqual(["C1", "C2"])
    const option = form.fields[0].options.find((o: any) => o.label.startsWith("Approve C1"))
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { [form.fields[0].key]: option.value } })
    await until(async () => (await run(host)).criteria.C1.by === "human", 15000)
    const after = await run(host)
    expect(after.criteria.C1.status).toBe("pass")
    expect(after.criteria.C2).toMatchObject({ status: "fail", by: "host" })
    expect(after.status).toBe("needs_review")
    expect((await ledger(host)).filter((e) => e.type === "approve").map((e) => e.criterion)).toEqual(["C1"])
  } finally { await host.stop() }
}, 60000)

test("Amend the check is an actionable Composer interview, never confirmation of a nonexistent edited contract", async () => {
  const host = await reviewHost()
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const before = await waitStatus(host, ["needs_review"], 20000)
    const yaml = await host.readProject(".opencode/goals/demo/goal.yaml")
    const form = await pending(host, sid)
    const field = form.fields[0], option = field.options.find((o: any) => o.label === "Amend the check")
    expect(option).toBeDefined()
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { [field.key]: option.value } })
    await until(() => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("amend the check for goal demo; interview me")), 15000)
    expect(await host.readProject(".opencode/goals/demo/goal.yaml")).toBe(yaml)
    expect((await run(host)).lock).toBe(before.lock)
    expect((await run(host)).criteria).toEqual(before.criteria)
    expect((await ledger(host)).filter((e) => e.type === "approve" || e.type === "amended")).toHaveLength(0)
  } finally { await host.stop() }
}, 60000)
