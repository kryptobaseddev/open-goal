import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T106: while the disk contract differs from the lock, re-offering (or
// re-presenting) the impossible amendment acceptance review just burns
// rounds — axiom answered it 10+ times. The engine must refuse to re-offer it,
// name the recovery call, and offer reviews normally again once the
// divergence is resolved.

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const DISK = DEMO_GOAL.replace("Demo file says ok", "Disk edit title")

async function toolResults(host: Awaited<ReturnType<typeof goalHost>>) {
  type Message = { role?: string; content?: unknown }
  return (host.fixture.requests as Array<{ messages?: Message[] }>).flatMap((request) =>
    (request.messages ?? [])
      .filter((m) => m.role === "tool")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))),
  )
}

function worker(state: { lock: string; decisionId: string; runId: string; sessionID: string }) {
  return script((_request, turn) => {
    if (turn.trigger === "STAGE" && !turn.results)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "demo", expectedLock: state.lock, yaml: DISK, rationale: "raise the title" } }] }
    if (turn.trigger === "STAGE2" && !turn.results)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "demo", expectedLock: state.lock, yaml: DISK.replace("title: Disk edit title", "title: Second staged title"), rationale: "second review after recovery" } }] }
    if (turn.trigger === "REVIEW" && !turn.results && state.decisionId)
      return { toolCalls: [{ name: "goal_review", args: { decisionId: state.decisionId } }] }
    if (turn.trigger === "RESUME" && !turn.results)
      return { toolCalls: [{ name: "goal_manage", args: { action: "resume", target: { key: `live:demo:${state.runId}`, lock: state.lock, runId: state.runId, sessionID: state.sessionID } } }] }
    if (turn.trigger === "RECOVER" && !turn.results)
      return { toolCalls: [{ name: "goal_recover_divergence", args: { slug: "demo", expectedLock: state.lock } }] }
    if (["STAGE", "STAGE2", "REVIEW", "RESUME", "RECOVER"].includes(turn.trigger)) return { text: "Recorded." }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold for prerequisite guidance" } }] }
    return { text: "Holding." }
  })
}

async function divergent(state: { lock: string; decisionId: string; runId: string; sessionID: string }) {
  const host = await goalHost(worker(state), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  const owner = await newSession(host)
  await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
  const initial = await waitStatus(host, ["waiting"], 15000)
  state.lock = initial.lock; state.runId = initial.runId; state.sessionID = owner
  await host.client.session.prompt({ sessionID: owner, text: "STAGE" } as never)
  const request = await until(async () => {
    const store = JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json").catch(() => '{"requests":{}}'))
    return Object.values(store.requests).find((r: any) => r.slug === "demo" && r.status === "pending") as any
  }, 15000)
  state.decisionId = request.id
  await Bun.write(join(host.project, ".opencode/goals/demo/goal.yaml"), DISK)
  return { host, owner, initial, request }
}

test("while the disk differs, the amendment review is not re-presented and the refusal names recovery", async () => {
  const state = { lock: "", decisionId: "", runId: "", sessionID: "" }
  const { host, owner, initial, request } = await divergent(state)
  try {
    await host.client.session.prompt({ sessionID: owner, text: "REVIEW" } as never)
    const refusal = await until(async () => (await toolResults(host)).find((text) => text.includes("goal_recover_divergence")), 15000)
    expect(refusal).toContain(initial.lock)
    expect(refusal).toContain(sha(DISK))
    // No second native form was minted for the impossible review.
    const forms: any[] = await (host.client.session.form as any).list({ sessionID: owner })
    expect(forms.some((f) => JSON.stringify(f).includes("Accept amendment") && JSON.stringify(f).includes(request.id))).toBe(false)
    expect((await run(host)).lock).toBe(initial.lock)
  } finally { await host.stop() }
}, 60000)

test("a resume prerequisite in a divergent goal names the recovery call, not the amendment review", async () => {
  const state = { lock: "", decisionId: "", runId: "", sessionID: "" }
  const { host, owner, initial } = await divergent(state)
  try {
    await host.client.session.prompt({ sessionID: owner, text: "RESUME" } as never)
    const refusal = await until(async () => (await toolResults(host)).find((text) => text.includes("goal_recover_divergence")), 15000)
    expect(refusal).toContain(initial.lock)
    expect(refusal).toContain(sha(DISK))
    expect(refusal).toMatch(/disk/i)
    expect((await run(host)).lock).toBe(initial.lock)
    expect((await ledger(host)).filter((e) => e.type === "resumed")).toHaveLength(0)
  } finally { await host.stop() }
}, 60000)

test("once the divergence is resolved, a new review is offered normally", async () => {
  const state = { lock: "", decisionId: "", runId: "", sessionID: "" }
  const { host, owner, request } = await divergent(state)
  try {
    // The owner adopts the disk bytes through the supported recovery review.
    await host.client.session.prompt({ sessionID: owner, text: "RECOVER" } as never)
    const form = await until(async () => (await host.client.session.form as any).list({ sessionID: owner }).then((forms: any[]) => forms.find((f) => JSON.stringify(f).includes("Adopt disk version"))), 15000)
    const field = form.fields[0]!
    if (field.type !== "string") throw new Error("Expected recovery choice")
    await host.client.session.form.reply({ sessionID: owner, formID: form.id, answer: { [field.key]: field.options!.find((o: any) => o.label === "Adopt disk version")!.value } })
    const adopted = await until(async () => { const r = await run(host); return r.lock === sha(DISK) ? r : undefined }, 15000)
    expect(adopted.lock).toBe(sha(DISK))
    const old = JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json")).requests[request.id]
    expect(old.status).toBe("cancelled")

    // Reviews work again on the resolved generation.
    state.lock = adopted.lock
    await host.client.session.prompt({ sessionID: owner, text: "STAGE2" } as never)
    const store = JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json"))
    const next = Object.values(store.requests).find((r: any) => r.status === "pending" && r.id !== request.id) as any
    expect(next).toBeDefined()
    state.decisionId = next.id
    await host.client.session.prompt({ sessionID: owner, text: "REVIEW" } as never)
    const forms: any[] = await until(async () => {
      const list: any[] = await (host.client.session.form as any).list({ sessionID: owner })
      return list.some((f) => JSON.stringify(f).includes("Accept amendment")) ? list : undefined
    }, 15000)
    expect(forms.some((f) => JSON.stringify(f).includes("Accept amendment"))).toBe(true)
    expect((await ledger(host)).filter((e) => e.type === "amended")).toHaveLength(1)
  } finally { await host.stop() }
}, 90000)
