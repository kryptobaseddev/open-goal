import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// Owner-set autonomy policy: the OWNER lists change classes in the launched
// contract. Inside them the agent applies amendments and divergence
// recovery itself — journalled, visible and reversible by the owner. Outside
// them (criteria, checks, protect, scope, verification, the policy itself)
// the change is routed to the owner. The agent can never grant itself more.

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const BASE = DEMO_GOAL.replace(`check: {kind: command, run: "grep -q 'status: ok' done.txt"}`, `check: {kind: command, run: "grep -q 'status: ok' done.txt", timeout: 30}`)
const POLICY = `${BASE}autonomy: {amend: [timeout, recover]}\n`
const TIMEOUT = POLICY.replace("timeout: 30}", "timeout: 90}")
const CHECK = POLICY.replace("grep -q 'status: ok' done.txt", "true")
const WIDEN = POLICY.replace("amend: [timeout, recover]", "amend: [timeout, recover, budget, plan]")
const DROP = POLICY.replace(/  - id: C3\n[\s\S]*?Does done.txt state that the status is ok in a full line\?"}\n/, "").replace("proves: [C1, C2, C3]", "proves: [C1, C2]")
const amendments = async (host: Awaited<ReturnType<typeof goalHost>>) =>
  Object.values((await Bun.file(join(host.project, ".opencode/goals/.owner-amendments.json")).json().catch(() => ({ requests: {} }))).requests) as Array<Record<string, any>>

function worker(state: { lock: string; yaml: string }) {
  return script((_request, turn) => {
    if (turn.trigger === "PROPOSE" && !turn.results)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "demo", expectedLock: state.lock, yaml: state.yaml, rationale: "agent change" } }] }
    if (turn.trigger === "RECOVER" && !turn.results)
      return { toolCalls: [{ name: "goal_recover_divergence", args: { slug: "demo", expectedLock: state.lock } }] }
    if (["PROPOSE", "RECOVER"].includes(turn.trigger)) return { text: "Recorded." }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold for policy scenario" } }] }
    return { text: "Holding." }
  })
}

async function launch(goal: string) {
  const state = { lock: "", yaml: "" }
  const host = await goalHost(worker(state), { ".opencode/goals/demo/goal.yaml": goal }, { plugin: process.env.OCGOAL_GIT_SPEC })
  const owner = await newSession(host), agent = await newSession(host)
  await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
  const initial = await waitStatus(host, ["waiting"], 15000)
  state.lock = initial.lock
  return { host, owner, agent, initial, state }
}

const toolResult = (host: Awaited<ReturnType<typeof goalHost>>, needle: string) =>
  until(async () => host.fixture.requests.map((r) => JSON.stringify(r.messages)).find((m) => m.includes(needle)), 10000)

test("an in-policy amendment is applied by the agent itself, journalled, visible and owner-revertible", async () => {
  const { host, owner, agent, initial, state } = await launch(POLICY)
  try {
    state.yaml = TIMEOUT
    await host.client.session.prompt({ sessionID: agent, text: "PROPOSE" } as never)
    const applied = await until(async () => { const r = await run(host); return r.lock === sha(TIMEOUT) ? r : undefined }, 15000)
    expect(await host.client.session.form.list({ sessionID: agent })).toHaveLength(0)
    expect(await host.client.session.form.list({ sessionID: owner })).toHaveLength(0)
    const request = (await amendments(host)).find((p) => p.nextLock === sha(TIMEOUT))!
    expect(request.status).toBe("succeeded")
    expect(request.commit).toBeDefined()
    expect(request.appliedBy).toBe("agent-policy")
    const events = await ledger(host)
    expect(events.some((e) => e.type === "amended" && e.by === "agent-policy" && e.oldLock === initial.lock && e.newLock === sha(TIMEOUT))).toBe(true)
    expect(applied.amendments.at(-1)).toMatchObject({ status: "accepted", rationale: expect.stringContaining("agent policy") })
    expect(applied.runId).toBe(initial.runId)
    expect(await host.readProject(".opencode/goals/demo/goal.yaml")).toBe(TIMEOUT)

    // Owner revert restores the previous generation as a new journalled one.
    await host.client.session.command({ sessionID: owner, name: "goal", text: "revert demo" } as never)
    await until(async () => (await run(host)).lock === initial.lock, 15000)
    expect(await host.readProject(".opencode/goals/demo/goal.yaml")).toBe(POLICY)
    expect((await ledger(host)).some((e) => e.type === "reverted" && e.by === "owner" && e.from === sha(TIMEOUT) && e.to === initial.lock)).toBe(true)
  } finally { await host.stop() }
}, 60000)

for (const [name, yaml] of [["a changed check", CHECK], ["a removed criterion", DROP], ["a self-widened policy", WIDEN]] as const) {
  test(`${name} is outside the policy and routed to the owner, not applied`, async () => {
    const { host, agent, initial, state } = await launch(POLICY)
    try {
      state.yaml = yaml
      await host.client.session.prompt({ sessionID: agent, text: "PROPOSE" } as never)
      const form = await until(async () => (await host.client.session.form.list({ sessionID: agent })).find((f) => JSON.stringify(f).includes("Accept amendment")), 15000)
      expect(form).toBeDefined()
      expect(await toolResult(host, "outside the owner-set autonomy policy")).toBeDefined()
      expect((await run(host)).lock).toBe(initial.lock)
      expect((await ledger(host)).filter((e) => e.type === "amended")).toHaveLength(0)
      expect(await host.readProject(".opencode/goals/demo/goal.yaml")).toBe(POLICY)
    } finally { await host.stop() }
  }, 60000)
}

test("without a policy every agent amendment still needs the owner", async () => {
  const { host, agent, initial, state } = await launch(BASE)
  try {
    state.yaml = BASE.replace("timeout: 30}", "timeout: 90}")
    await host.client.session.prompt({ sessionID: agent, text: "PROPOSE" } as never)
    await until(async () => (await host.client.session.form.list({ sessionID: agent })).find((f) => JSON.stringify(f).includes("Accept amendment")), 15000)
    expect((await run(host)).lock).toBe(initial.lock)
    expect((await ledger(host)).filter((e) => e.type === "amended")).toHaveLength(0)
  } finally { await host.stop() }
}, 60000)

test("an in-policy out-of-band disk edit is recovered by the agent; an out-of-policy one goes to the owner", async () => {
  const { host, agent, initial, state } = await launch(POLICY)
  try {
    await Bun.write(join(host.project, ".opencode/goals/demo/goal.yaml"), TIMEOUT)
    await host.client.session.prompt({ sessionID: agent, text: "RECOVER" } as never)
    await until(async () => (await run(host)).lock === sha(TIMEOUT), 15000)
    expect(await host.client.session.form.list({ sessionID: agent })).toHaveLength(0)
    expect((await ledger(host)).some((e) => e.type === "divergence-adopted" && e.by === "agent-policy" && e.oldLock === initial.lock)).toBe(true)

    state.lock = sha(TIMEOUT)
    await Bun.write(join(host.project, ".opencode/goals/demo/goal.yaml"), TIMEOUT.replace("Demo file says ok", "Retitled out of band"))
    await host.client.session.prompt({ sessionID: agent, text: "RECOVER" } as never)
    await until(async () => (await host.client.session.form.list({ sessionID: agent })).find((f) => JSON.stringify(f).includes("Adopt disk version")), 15000)
    expect((await run(host)).lock).toBe(sha(TIMEOUT))
  } finally { await host.stop() }
}, 60000)
