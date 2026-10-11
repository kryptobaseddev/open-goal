import { expect, test } from "bun:test"
import { GoalRpc } from "../../src/rpc"
import { goalHost, ledger, newSession, run, script, text, waitStatus } from "./goal.helpers"
import { until } from "./harness"

const yaml = `schema: goal/v1
id: decision-review
title: Bound owner sign-off
intent: {verbatim: write a marker and review it}
outcome: marker exists and owner reviews it
non_goals: [other files]
criteria:
  - id: C1
    statement: marker exists
    check: {kind: file, path: marker.txt}
  - id: C4
    statement: owner signs off the marker
    check: {kind: human, ask: review the marker}
`

async function reviewHost(forms: boolean) {
  const asked = new Set<string>()
  const host = await goalHost(script((_req, turn) => {
    const payload = _req.messages.map(text).join("\n").split("\n").findLast((s) => s.startsWith("GOAL_DECISION_JSON:"))
    const presentation = _req.messages.map(text).join("\n").split("\n").findLast((s) => s.startsWith("GOAL_DECISION_ASK:")) ?? payload
    if (forms && payload && !asked.has(presentation!)) {
      asked.add(presentation!)
      return { toolCalls: [{ name: "question", args: JSON.parse(payload.slice("GOAL_DECISION_JSON:".length)) }] }
    }
    // Compatibility with the existing decision prompt, for the red baseline.
    if (forms && !payload && turn.all.includes("goal-decision") && !asked.has("legacy")) {
      asked.add("legacy")
      return { toolCalls: [{ name: "question", args: { questions: [{ header: "Goal", question: "goal.needs-review.signoff", options: [
        { label: "Approve C4 (triggers verify)", description: "Owner signs off and host verifies." },
        { label: "Reject with a reason", description: "Keep it stopped with a failed criterion." },
        { label: "Show status (guidance — advice, not an action)", description: "Read the board; no operation." },
      ] }] } }] }
    }
    if (turn.trigger.includes("REOPEN_DECISION") && turn.results === 0)
      return { toolCalls: [{ name: "goal_review", args: {} }] }
    if (turn.trigger.includes("goal started")) {
      if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "marker.txt", content: "marker\n" } }] }
      if (turn.results === 1) return { toolCalls: [{ name: "goal_claim", args: { summary: "marker exists", evidence: { C1: "written", C4: "owner review required" } } }] }
    }
    return { text: "No owner approval inferred." }
  }), { ".opencode/goals/decision-review/goal.yaml": yaml })
  const sessionID = await newSession(host)
  await host.client.session.command({ sessionID, name: "goal", text: "start decision-review" } as any)
  await waitStatus(host, ["needs_review"], 30000, "decision-review")
  await until(async () => (await ledger(host, "decision-review")).some((e) => e.type === "decision-form-asked"))
  return { host, sessionID, rpc: (host.client as any).rpc(GoalRpc) }
}
async function reviewForm(host: Awaited<ReturnType<typeof goalHost>>, sessionID: string) {
  return until(async () => {
    const forms: any[] = await (host.client.session.form as any).list({ sessionID })
    return forms.find((f) => f.fields.some((field: any) => field.options?.some((o: any) => o.label === "Approve C4 (triggers verify)")))
  }, 10000)
}

test("an unrelated form offering an identical label cannot attach to the engine's pending decision", async () => {
  const { host, sessionID } = await reviewHost(false)
  try {
    const unrelated = await (host.client.session.form as any).create({ sessionID, title: "Unrelated wording choice", fields: [{ key: "q0", type: "string", options: [{ label: "Approve C4 (triggers verify)", value: "Approve C4 (triggers verify)" }] }] })
    await (host.client.session.form as any).reply({ sessionID, formID: unrelated.id, answer: { q0: "Approve C4 (triggers verify)" } })
    await host.client.session.prompt({ sessionID, text: "Confirm the unrelated form was only a preference, not goal consent." } as any)
    await until(() => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("only a preference")))
    const state = await run(host, "decision-review")
    expect(state.criteria.C4.status).not.toBe("pass")
    expect(state.status).toBe("needs_review")
    expect((await ledger(host, "decision-review")).filter((e) => e.type === "decision-resolved" && e.ok === true)).toHaveLength(0)
  } finally { await host.stop() }
}, 60000)

test("dismissal preserves the unresolved review without a form loop; an explicit review request restores it", async () => {
  const { host, sessionID } = await reviewHost(true)
  try {
    const form = await reviewForm(host, sessionID)
    const decision = (await ledger(host, "decision-review")).findLast((e) => e.type === "decision")!
    await (host.client.session.form as any).cancel({ sessionID, formID: form.id, message: "Read this later; no choice." })
    await until(async () => (await ledger(host, "decision-review")).some((e) => e.type === "decision-form-interrupted" && e.decision === decision.decisionId))
    await Bun.sleep(250) // let the cancelled question's completion event arrive
    const pending: any[] = await (host.client.session.form as any).list({ sessionID })
    expect(pending).toHaveLength(0)
    expect((await run(host, "decision-review")).criteria.C4.status).not.toBe("pass")
    await host.client.session.prompt({ sessionID, text: "REOPEN_DECISION show the unresolved native review again" } as any)
    const restored = await reviewForm(host, sessionID)
    expect(JSON.stringify(restored)).toContain(decision.decisionId)
    expect(restored.id).not.toBe(form.id)
  } finally { await host.stop() }
}, 60000)

test("a dialog decision is session-bound, restricted to its offered operation and one-use against a late form reply", async () => {
  const { host, sessionID, rpc } = await reviewHost(true)
  try {
    const form = await reviewForm(host, sessionID)
    const decision = (await ledger(host, "decision-review")).findLast((e) => e.type === "decision")!
    const other = await newSession(host)
    expect((await rpc.act({ sessionID: other, decisionId: decision.decisionId, action: "approve", arg: "C4" })).ok).toBe(false)
    expect((await rpc.act({ sessionID, decisionId: decision.decisionId, action: "resume" })).ok).toBe(false)
    expect((await run(host, "decision-review")).status).toBe("needs_review")
    expect((await rpc.act({ sessionID, decisionId: decision.decisionId, action: "approve", arg: "C4" })).ok).toBe(true)
    await waitStatus(host, ["complete"], 30000, "decision-review")
    expect((await rpc.act({ sessionID, decisionId: decision.decisionId, action: "approve", arg: "C4" })).ok).toBe(false)
    const field = form.fields.find((f: any) => f.options?.some((o: any) => o.label === "Approve C4 (triggers verify)"))
    const option = field.options.find((o: any) => o.label === "Approve C4 (triggers verify)")
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: { [field.key]: option.value } })
    expect((await ledger(host, "decision-review")).filter((e) => e.type === "approve" && e.criterion === "C4")).toHaveLength(1)
    expect((await ledger(host, "decision-review")).filter((e) => e.type === "decision-resolved" && e.decision === decision.decisionId)).toHaveLength(1)
  } finally { await host.stop() }
}, 60000)

test("commentary beginning with a choice label is not the selected approval", async () => {
  const { host, sessionID } = await reviewHost(true)
  try {
    const form = await reviewForm(host, sessionID)
    const field = form.fields.find((f: any) => f.options?.some((o: any) => o.label === "Approve C4 (triggers verify)"))
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: { [field.key]: "Approve C4 (triggers verify) is wording to revise; do not approve" } })
    await host.client.session.prompt({ sessionID, text: "Confirm the response was commentary, not sign-off." } as any)
    await until(() => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("commentary, not sign-off")))
    expect((await run(host, "decision-review")).criteria.C4.status).not.toBe("pass")
    expect((await ledger(host, "decision-review")).filter((e) => e.type === "decision-resolved" && e.ok === true)).toHaveLength(0)
  } finally { await host.stop() }
}, 60000)

test("a failed operation never resolves or logs the pending decision as successful", async () => {
  const { host, sessionID, rpc } = await reviewHost(false)
  try {
    const before = (await ledger(host, "decision-review")).findLast((e) => e.type === "decision")!
    const failed = await rpc.act({ sessionID, action: "approve", arg: "C404" })
    expect(failed.ok).toBe(false)
    expect(failed.message).toContain("Unknown criterion")
    const events = await ledger(host, "decision-review")
    expect(events.filter((e) => e.type === "decision-resolved" && e.decision === before.decisionId && e.ok === true)).toHaveLength(0)
    expect(events.findLast((e) => e.type === "decision-attempt" && e.decision === before.decisionId)).toMatchObject({ ok: false, action: "approve", message: expect.stringContaining("Unknown criterion") })
    expect((await run(host, "decision-review")).status).toBe("needs_review")
  } finally { await host.stop() }
}, 60000)

test("a dismissed/reloaded review is re-presented with its exact decision identity rather than forgotten", async () => {
  const { host, sessionID } = await reviewHost(true)
  try {
    const form = await reviewForm(host, sessionID)
    const decision = (await ledger(host, "decision-review")).findLast((e) => e.type === "decision")!
    // Core cancellation on location reload must not be mistaken for owner
    // acceptance/rejection. The actual pending review is restored natively.
    await host.client.location.reload()
    const restored: any = await until(async () => {
      const forms: any[] = await (host.client.session.form as any).list({ sessionID })
      return forms.find((f) => JSON.stringify(f).includes(decision.decisionId))
    }, 10000)
    expect(restored.id).not.toBe(form.id)
    const field = restored.fields.find((f: any) => f.options?.some((o: any) => o.label === "Approve C4 (triggers verify)"))
    const choice = field.options.find((o: any) => o.label === "Approve C4 (triggers verify)")
    await (host.client.session.form as any).reply({ sessionID, formID: restored.id, answer: { [field.key]: choice.value } })
    await waitStatus(host, ["complete"], 30000, "decision-review")
    expect((await run(host, "decision-review")).criteria.C4).toMatchObject({ status: "pass", by: "human" })
  } finally { await host.stop() }
}, 60000)
