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
      // Tool results are nested JSON, so inner quotes arrive escaped.
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")).replace(/\\"/g, '"')),
  )
}

function worker(state: { lock: string; decisionId: string; runId: string; sessionID: string }) {
  return script((_request, turn) => {
    // Answer only the divergence recovery review (the amendment review is the
    // owner's own surface and is exercised through form.list/form.reply).
    const form = turn.trigger.split("\n").find((line) => line.startsWith("GOAL_FORM_JSON:"))
    if (form && /Adopt disk version|Restore locked version/.test(form) && !turn.results)
      return { toolCalls: [{ name: "question", args: JSON.parse(form.slice(form.indexOf(":") + 1)) }] }
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
    // Recovery is offered from another live session of the project, exactly as
    // axiom staged it; the authoring session keeps its unanswered review.
    const rescuer = await newSession(host)
    state.sessionID = owner
    await host.client.session.prompt({ sessionID: rescuer, text: "RECOVER" } as never)
    const form = await until(async () => (await host.client.session.form as any).list({ sessionID: rescuer }).then((forms: any[]) => forms.find((f) => JSON.stringify(f).includes("Adopt disk version"))), 15000)
    const field = form.fields[0]!
    if (field.type !== "string") throw new Error("Expected recovery choice")
    await host.client.session.form.reply({ sessionID: rescuer, formID: form.id, answer: { [field.key]: field.options!.find((o: any) => o.label === "Adopt disk version")!.value } })
    const adopted = await until(async () => { const r = await run(host); return r.lock === sha(DISK) ? r : undefined }, 15000)
    expect(adopted.lock).toBe(sha(DISK))
    const old = JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json")).requests[request.id]
    expect(old.status).toBe("cancelled")

    // Reviews work again on the resolved generation: the same call that was
    // refused while divergent now restores/presents a review normally.
    state.lock = adopted.lock
    await host.client.session.prompt({ sessionID: owner, text: "STAGE2" } as never)
    const store = await until(async () => {
      const parsed = JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json"))
      return Object.values(parsed.requests).some((r: any) => r.status === "pending" && r.id !== request.id) ? parsed : undefined
    }, 15000)
    const next = Object.values(store.requests).find((r: any) => r.status === "pending" && r.id !== request.id) as any
    state.decisionId = next.id
    await host.client.session.prompt({ sessionID: owner, text: "REVIEW" } as never)
    const reviewed = await until(async () => (await toolResults(host)).find((text) => text.includes("native Composer") || text.includes("amendment review")), 15000)
    expect(reviewed).not.toContain("goal_recover_divergence")
    expect((await ledger(host)).filter((e) => e.type === "amended")).toHaveLength(1)
  } finally { await host.stop() }
}, 90000)
