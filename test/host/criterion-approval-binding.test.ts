import { expect, test } from "bun:test"
import { GoalRpc } from "../../src/rpc"
import { goalHost, ledger, newSession, run, script, text, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T093 (exact binding): a rejected-criterion review offers per-criterion native
// approval bound to the exact decision/run/lock/criterion. Only the exact
// offered selection approves that criterion; a stale/unknown/mismatched
// approval is refused and flips nothing. (The legacy fresh-nonce recovery is
// proven by the protected criterion-approval.test.ts.)

function bindingHost() {
  const asked = new Set<string>()
  const yaml = `schema: goal/v1
id: demo
title: Exact criterion binding
intent: {verbatim: inspect exact criterion binding}
outcome: marker exists or the owner makes one exact per-criterion decision
non_goals: [production changes, fake consent]
criteria:
  - id: C1
    statement: one.txt exists
    check: {kind: file, path: one.txt}
  - id: C2
    statement: two.txt exists
    check: {kind: file, path: two.txt}
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
    if (turn.results === 0 && !payload) return { toolCalls: [{ name: "goal_claim", args: { summary: "Request review of the missing markers", evidence: { C1: "owner reviews C1", C2: "owner reviews C2" } } }] }
    return { text: "End the turn; only an actual owner selection may approve." }
  }), { ".opencode/goals/demo/goal.yaml": yaml }, { plugin: process.env.OCGOAL_GIT_SPEC })
}

const pendingApproval = async (host: Awaited<ReturnType<typeof bindingHost>>, sid: string) => until(async () => {
  const forms: any[] = await (host.client.session.form as any).list({ sessionID: sid })
  return forms.find((f) => f.fields?.some((field: any) => field.options?.some((o: any) => o.label.startsWith("Approve C1"))))
}, 15000)

test("only the exact offered per-criterion selection approves, and an unknown decision is refused", async () => {
  const host = await bindingHost()
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const before = await waitStatus(host, ["needs_review"], 20000)
    const form = await pendingApproval(host, sid)
    const store = JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json"))
    const request: any = Object.values(store.requests).find((r: any) => r.formID === form.id)
    // the offered approvals carry the exact criterion id, never a bare approve
    const approveChoices = request.message.choices.filter((c: any) => c.act === "approve")
    expect(approveChoices.map((c: any) => c.arg).sort()).toEqual(["C1", "C2"])
    expect(approveChoices.every((c: any) => typeof c.arg === "string" && /^C\d+$/.test(c.arg))).toBe(true)

    // an unknown decision id is refused and changes nothing
    const rpc = (host.client as any).rpc(GoalRpc)
    const unknown = await rpc.review({ sessionID: sid, decisionId: "no-such-decision" })
    expect(String(unknown.message ?? "")).not.toMatch(/approved|resolved/i)
    expect((await run(host)).criteria.C1.by).not.toBe("human")

    // the exact offered value for C1 approves C1 only, exactly once
    const choice = request.message.choices.find((c: any) => c.act === "approve" && c.arg === "C1")
    const field = form.fields[0]
    const option = field.options.find((o: any) => o.label === choice.label)
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { [field.key]: option.value } })
    await until(async () => (await run(host)).criteria.C1.by === "human", 15000)
    const after = await run(host)
    expect(after.runId).toBe(before.runId)
    expect(after.lock).toBe(before.lock)
    expect(after.criteria.C1).toMatchObject({ status: "pass", by: "human" })
    expect(after.criteria.C2.by).not.toBe("human") // the sibling criterion was not silently grouped
    expect((await ledger(host)).filter((e) => e.type === "approve").map((e) => e.criterion)).toEqual(["C1"])

    // a repeated reply to the same (now stale) form does not approve again
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { [field.key]: option.value } }).catch(() => {})
    await Bun.sleep(500)
    expect((await ledger(host)).filter((e) => e.type === "approve")).toHaveLength(1)
  } finally { await host.stop() }
}, 90000)
