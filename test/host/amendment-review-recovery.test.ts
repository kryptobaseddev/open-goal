import { expect, test } from "bun:test"
import { join } from "node:path"
import { GoalRpc } from "../../src/rpc"
import { parseContract } from "../../src/contract/parse"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

test("Composer recovery finds amendment reviews; expired legacy consent is visible and needs a new exact owner choice", async () => {
  const next = DEMO_GOAL.replace("Demo file says ok", "Revised owner-reviewed marker")
  const host = await goalHost(script((_req, turn) => {
    const line = turn.trigger.split("\n").find((l) => l.startsWith("GOAL_FORM_JSON:"))
    if (line && turn.results === 0) return { toolCalls: [{ name: "question", args: JSON.parse(line.slice("GOAL_FORM_JSON:".length)) }] }
    if (turn.trigger.includes("PROPOSE_REVIEW") && turn.results === 0) return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "demo", expectedLock: parseContract(DEMO_GOAL).lock, yaml: next, rationale: "Owner requested title clarification" } }] }
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "amendment review recovery inspection" } }] }
    return { text: "No owner consent inferred." }
  }))
  const rpc: any = (host.client as any).rpc(GoalRpc)
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const before = await waitStatus(host, ["waiting"], 15000)
    await host.client.session.prompt({ sessionID: sid, text: "PROPOSE_REVIEW stage the exact diff; no acceptance yet." } as any)
    const file = join(host.project, ".opencode/goals/.owner-amendments.json")
    const review = await until(async () => Object.values((await Bun.file(file).json()).requests).find((p: any) => p.status === "pending") as any, 10000)
    const getForm = async (id: string): Promise<any> => until(async () => (await (host.client.session.form as any).list({ sessionID: sid })).find((f: any) => JSON.stringify(f).includes(id)), 10000)
    const form = await getForm(review.id)
    expect((await rpc.review({ sessionID: sid, decisionId: review.id })).message).toContain("already present")
    // Trusted fixture models a pre-upgrade timed record, not a fabricated
    // owner response. New target-bound records are covered separately.
    const data: any = await Bun.file(file).json()
    delete data.requests[review.id].expiryPolicy
    data.requests[review.id].expiresAt = Date.now() - 1
    await Bun.write(file, JSON.stringify(data))
    const field = form.fields[0], option = field.options.find((o: any) => o.label === "Accept amendment")
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { [field.key]: option.value } })
    await until(async () => (await ledger(host)).some((e) => e.type === "amendment-review-expired" && e.decisionId === review.id), 10000)
    expect((await run(host)).lock).toBe(before.lock)
    expect((await ledger(host)).filter((e) => e.type === "amended")).toHaveLength(0)
    expect((await rpc.review({ sessionID: sid, decisionId: review.id })).message).toContain("NEW real owner selection")
    const replacement = await until(async () => Object.values((await Bun.file(file).json()).requests).find((p: any) => p.id !== review.id && p.status === "pending") as any, 10000)
    expect(replacement.lock).toBe(before.lock)
    expect(replacement.nextLock).toBe(review.nextLock)
    expect(replacement.expiryPolicy).toBe("target")
    expect((await run(host)).lock).toBe(before.lock)
    const restored = await getForm(replacement.id), f = restored.fields[0], choice = f.options.find((o: any) => o.label === "Accept amendment")
    await (host.client.session.form as any).reply({ sessionID: sid, formID: restored.id, answer: { [f.key]: choice.value } })
    await until(async () => (await run(host)).lock === replacement.nextLock, 10000)
    // v0.8.0 C2: acceptance resumes in the same act; the goal is not left paused.
    expect(["running", "waiting"]).toContain((await run(host)).status)
    expect((await ledger(host)).filter((e) => e.type === "amendment-resumed" && e.decisionId === replacement.id)).toHaveLength(1)
    expect((await ledger(host)).filter((e) => e.type === "amended")).toHaveLength(1)
    const replay = await rpc.review({ sessionID: sid, decisionId: replacement.id })
    expect(replay.ok).toBe(false)
    expect(replay.actionExecuted).toBe(false)
    expect(replay.message).toContain("replayed")
    expect((await ledger(host)).filter((e) => e.type === "amended")).toHaveLength(1)
  } finally { await host.stop() }
}, 60000)
