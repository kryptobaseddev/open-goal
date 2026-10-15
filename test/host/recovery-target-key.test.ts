import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T106(b): after an adopt, axiom called goal_manage resume with the bare
// slug/lock and got "Selected goal identity changed" — the goal KEY changes to
// live:<slug>:<runId> and nothing surfaced it, so a round was lost to
// goal_inventory. Recovering a divergence must return the refreshed target
// tuple in the tool result and in goal_status, and that exact tuple must make
// goal_manage work.

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

function worker(state: { lock: string; decisionId: string; runId: string; sessionID: string; target?: unknown }) {
  return script((_request, turn) => {
    if (turn.trigger === "STAGE" && !turn.results)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "demo", expectedLock: state.lock, yaml: DISK, rationale: "raise the title" } }] }
    if (turn.trigger === "RECOVER" && !turn.results)
      return { toolCalls: [{ name: "goal_recover_divergence", args: { slug: "demo", expectedLock: state.lock } }] }
    if (turn.trigger === "STATUS" && !turn.results)
      return { toolCalls: [{ name: "goal_status", args: {} }] }
    if (turn.trigger === "RESUME" && !turn.results && state.target)
      return { toolCalls: [{ name: "goal_manage", args: { action: "resume", target: state.target } }] }
    if (["STAGE", "RECOVER", "STATUS", "RESUME"].includes(turn.trigger)) return { text: "Recorded." }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold for target key" } }] }
    return { text: "Holding." }
  })
}

test("an adopt returns the refreshed target tuple, goal_status carries it, and goal_manage accepts it", async () => {
  const state = { lock: "", decisionId: "", runId: "", sessionID: "", target: undefined as unknown }
  const host = await goalHost(worker(state), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
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

    await host.client.session.prompt({ sessionID: owner, text: "RECOVER" } as never)
    const recovery = await until(async () => (await toolResults(host)).find((text) => text.includes('"target"')), 15000)
    const parsed = JSON.parse(recovery.slice(recovery.indexOf("{"))) as any
    expect(parsed.target).toMatchObject({ key: `live:demo:${initial.runId}`, runId: initial.runId, sessionID: owner, lock: state.lock })
    expect(parsed.target.lock).not.toBe(initial.lock)
    expect(parsed.target.lock).toBe(sha(DISK))

    // goal_status carries the same tuple after adoption.
    const form = await until(async () => (await host.client.session.form as any).list({ sessionID: owner }).then((forms: any[]) => forms.find((f) => JSON.stringify(f).includes("Adopt disk version"))), 15000)
    const field = form.fields[0]!
    if (field.type !== "string") throw new Error("Expected recovery choice")
    await host.client.session.form.reply({ sessionID: owner, formID: form.id, answer: { [field.key]: field.options!.find((o: any) => o.label === "Adopt disk version")!.value } })
    const adopted = await until(async () => { const r = await run(host); return r.lock === sha(DISK) ? r : undefined }, 15000)

    await host.client.session.prompt({ sessionID: owner, text: "STATUS" } as never)
    const status = await until(async () => (await toolResults(host)).find((text) => text.includes(`live:demo:${initial.runId}`)), 15000)
    expect(status).toContain(`live:demo:${initial.runId}`)
    expect(status).toContain(adopted.lock)

    // The exact tuple resumes without an identity-changed refusal.
    state.target = { key: `live:demo:${initial.runId}`, runId: initial.runId, sessionID: owner, lock: adopted.lock }
    await host.client.session.prompt({ sessionID: owner, text: "RESUME" } as never)
    const resume = await until(async () => (await toolResults(host)).find((text) => text.includes("resume") || text.includes("Resume")), 15000)
    expect(resume).not.toContain("Selected goal identity changed")
    expect((await ledger(host)).filter((e) => e.type === "amended")).toHaveLength(1)
  } finally { await host.stop() }
}, 90000)

test("a restore returns the same locked target tuple and keeps goal_manage working", async () => {
  const state = { lock: "", decisionId: "", runId: "", sessionID: "", target: undefined as unknown }
  const host = await goalHost(worker(state), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    const initial = await waitStatus(host, ["waiting"], 15000)
    state.lock = initial.lock; state.runId = initial.runId; state.sessionID = owner
    await host.client.session.prompt({ sessionID: owner, text: "STAGE" } as never)
    await until(async () => {
      const store = JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json").catch(() => '{"requests":{}}'))
      return Object.values(store.requests).some((r: any) => r.slug === "demo" && r.status === "pending")
    }, 15000)
    await Bun.write(join(host.project, ".opencode/goals/demo/goal.yaml"), DISK)

    await host.client.session.prompt({ sessionID: owner, text: "RECOVER" } as never)
    const recovery = await until(async () => (await toolResults(host)).find((text) => text.includes('"target"')), 15000)
    const parsed = JSON.parse(recovery.slice(recovery.indexOf("{"))) as any
    expect(parsed.target).toMatchObject({ key: `live:demo:${initial.runId}`, runId: initial.runId, sessionID: owner, lock: initial.lock })

    const form = await until(async () => (await host.client.session.form as any).list({ sessionID: owner }).then((forms: any[]) => forms.find((f) => JSON.stringify(f).includes("Restore locked version"))), 15000)
    const field = form.fields[0]!
    if (field.type !== "string") throw new Error("Expected recovery choice")
    await host.client.session.form.reply({ sessionID: owner, formID: form.id, answer: { [field.key]: field.options!.find((o: any) => o.label === "Restore locked version")!.value } })
    await until(async () => sha(await host.readProject(".opencode/goals/demo/goal.yaml")) === initial.lock, 15000)

    state.target = { key: `live:demo:${initial.runId}`, runId: initial.runId, sessionID: owner, lock: initial.lock }
    await host.client.session.prompt({ sessionID: owner, text: "RESUME" } as never)
    const resume = await until(async () => (await toolResults(host)).find((text) => text.includes("resume") || text.includes("Resume")), 15000)
    expect(resume).not.toContain("Selected goal identity changed")
    expect((await ledger(host)).filter((e) => e.type === "divergence-restored")).toHaveLength(1)
    expect((await run(host)).lock).toBe(initial.lock)
  } finally { await host.stop() }
}, 90000)
