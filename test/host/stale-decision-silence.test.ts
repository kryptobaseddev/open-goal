import { expect, test } from "bun:test"
import { join } from "node:path"
import { GoalRpc } from "../../src/rpc"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// v0.8.0 C3 — an expired, answered or superseded decision is never shown again.
// A dismissed (interrupted) review is still unanswered and may be restored.

test("expired, answered and superseded decisions are silenced; none is re-presented", async () => {
  let target: any
  const asked = new Set<string>()
  const host = await goalHost(script((_req, turn) => {
    const payload = turn.trigger.split("\n").findLast((l) => l.startsWith("GOAL_DECISION_JSON:"))
    if (payload && turn.results === 0 && !asked.has(payload)) {
      asked.add(payload)
      return { toolCalls: [{ name: "question", args: JSON.parse(payload.slice("GOAL_DECISION_JSON:".length)) }] }
    }
    if (turn.trigger.includes("REQUEST_REVIEW") && turn.results === 0)
      return { toolCalls: [{ name: "goal_manage", args: { action: "resume", target } }] }
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "stale decision inspection" } }] }
    return { text: "No owner consent inferred." }
  }))
  const rpc: any = (host.client as any).rpc(GoalRpc)
  const formsFor = async (id: string) =>
    (await (host.client.session.form as any).list({ sessionID: sid })).filter((f: any) => JSON.stringify(f).includes(id))
  let sid = ""
  const seen = new Set<string>()
  const review = async () => {
    await host.client.session.command({ sessionID: sid, name: "goal", text: "pause" } as any)
    await waitStatus(host, ["paused"], 15000)
    await host.client.session.prompt({ sessionID: sid, text: "REQUEST_REVIEW stage the exact resume review" } as any)
    return until(async () => {
      const store = JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json"))
      const fresh = Object.values(store.requests ?? {})
        .filter((d: any) => d.kind === "owner-operation" && d.status === "pending" && d.formID && !seen.has(d.id))
        .sort((a: any, b: any) => b.createdAt - a.createdAt)[0] as any
      if (!fresh) return
      seen.add(fresh.id)
      return fresh
    }, 15000)
  }
  const reload = async () => {
    await host.client.location.reload()
    await until(async () => {
      try { await host.client.plugin.list({ location: host.location } as any); return true } catch { return false }
    }, 30000)
  }
  try {
    sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const initial = await waitStatus(host, ["waiting"], 20000)
    target = { key: `live:demo:${initial.runId}`, runId: initial.runId, lock: initial.lock, sessionID: sid }

    // ── already answered: never re-presented ──
    const answered = await review()
    const answeredForm = await until(async () => (await formsFor(answered.id))[0], 10000)
    const field = answeredForm.fields[0]
    const choice = field.options.find((o: any) => o.label === "Resume selected goal")
    await (host.client.session.form as any).reply({ sessionID: sid, formID: answeredForm.id, answer: { [field.key]: choice.value } })
    await until(async () => (await ledger(host)).some((e) => e.type === "decision-resolved" && e.decision === answered.id && e.ok === true), 15000)
    await reload()
    await Bun.sleep(1500)
    expect(await formsFor(answered.id)).toHaveLength(0)
    const answeredReview = await rpc.review({ sessionID: sid, decisionId: answered.id })
    expect(answeredReview.ok).toBe(false)
    expect(String(answeredReview.message)).toMatch(/replayed|cannot|settled|succeeded/i)

    // ── expired (legacy timed review): silenced, not replaced ──
    const expired = await review()
    // Wait until the native form is bound before editing the sidecar: the
    // server writes the binding, and a racing edit would be overwritten.
    await until(async () => {
      const store = JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json"))
      return store.requests[expired.id]?.formID
    }, 10000)
    const file = join(host.project, ".opencode/goals/.owner-decisions.json")
    const data: any = await Bun.file(file).json()
    delete data.requests[expired.id].expiryPolicy
    data.requests[expired.id].expiresAt = Date.now() - 1
    await Bun.write(file, JSON.stringify(data))
    const asksBefore = (await ledger(host)).filter((e) => e.type === "decision-form-asked" && e.decision === expired.id).length
    await reload()
    await until(async () => (await ledger(host)).some((e) => e.type === "decision-silenced" && e.decision === expired.id && e.code === "expired"), 15000)
    expect((await ledger(host)).filter((e) => e.type === "decision-form-asked" && e.decision === expired.id).length).toBe(asksBefore)
    expect(await formsFor(expired.id)).toHaveLength(0)
    const expiredReview = await rpc.review({ sessionID: sid, decisionId: expired.id })
    expect(expiredReview.ok).toBe(false)
    expect(String(expiredReview.message)).toMatch(/expired|replayed|cannot/i)

    // ── superseded target: silenced, never re-presented ──
    const superseded = await review()
    const raw = JSON.parse(await host.readProject(".opencode/goals/demo/run.json"))
    raw.status = "superseded"
    raw.reason = "superseded by a successor in this fixture"
    await Bun.write(join(host.project, ".opencode/goals/demo/run.json"), JSON.stringify(raw, null, 2))
    await reload()
    await until(async () => (await ledger(host)).some((e) => e.type === "decision-silenced" && e.decision === superseded.id && e.code === "superseded"), 15000)
    expect(await formsFor(superseded.id)).toHaveLength(0)
    const supersededReview = await rpc.review({ sessionID: sid, decisionId: superseded.id })
    expect(supersededReview.ok).toBe(false)
    expect(String(supersededReview.message)).toMatch(/superseded|cancelled|replayed|cannot/i)
    expect((await run(host)).status).toBe("superseded")
  } finally {
    await host.stop()
  }
}, 180000)
