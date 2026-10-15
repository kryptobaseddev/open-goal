import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T106(a): axiom-lab-release answered an impossible "Accept amendment" 10+
// times. Every refusal read "The latest actual owner chat does not authorize
// this action/continuation" while the real cause was that the disk goal.yaml
// already differed from the locked generation. The refusal must name the
// divergence, both hashes and the exact recovery call — and a refusal whose
// cause is NOT divergence must keep its existing wording.

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const DISK = DEMO_GOAL.replace("Demo file says ok", "Disk edit title")

/** Every tool result the fixture saw (role "tool" contents). */
async function toolResults(host: Awaited<ReturnType<typeof goalHost>>) {
  type Message = { role?: string; content?: unknown }
  return (host.fixture.requests as Array<{ messages?: Message[] }>).flatMap((request) =>
    (request.messages ?? [])
      .filter((m) => m.role === "tool")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))),
  )
}

function worker(state: { lock: string; decisionId: string }) {
  return script((_request, turn) => {
    if (turn.trigger === "STAGE" && !turn.results)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "demo", expectedLock: state.lock, yaml: DISK, rationale: "raise the title" } }] }
    if (turn.trigger === "RESOLVE" && turn.results === 0 && state.decisionId)
      return { toolCalls: [{ name: "goal_resolve_amendment", args: { decisionId: state.decisionId, action: "accept" } }] }
    if (turn.trigger === "STAGE" || turn.trigger === "RESOLVE") return { text: "Recorded." }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold for divergence guidance" } }] }
    return { text: "Holding." }
  })
}

async function staged(state: { lock: string; decisionId: string }) {
  const host = await goalHost(worker(state), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  const owner = await newSession(host)
  await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
  const initial = await waitStatus(host, ["waiting"], 15000)
  state.lock = initial.lock
  await host.client.session.prompt({ sessionID: owner, text: "STAGE" } as never)
  const request = await until(async () => {
    const store = JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json").catch(() => '{"requests":{}}'))
    return Object.values(store.requests).find((r: any) => r.slug === "demo" && r.status === "pending") as any
  }, 15000)
  state.decisionId = request.id
  return { host, owner, initial, request }
}

test("a refusal caused by divergence names both hashes and the exact recovery call", async () => {
  const state = { lock: "", decisionId: "" }
  const { host, owner, initial, request } = await staged(state)
  try {
    // Axiom's shape: the disk bytes were written outside the engine, so disk
    // already equals the unaccepted proposal's nextLock.
    await Bun.write(join(host.project, ".opencode/goals/demo/goal.yaml"), DISK)
    await host.client.session.prompt({ sessionID: owner, text: "RESOLVE" } as never)
    const refusal = await until(async () => (await toolResults(host)).find((text) => text.includes("goal_recover_divergence")), 15000)
    expect(refusal).toContain(initial.lock)
    expect(refusal).toContain(sha(DISK))
    expect(refusal).toMatch(/disk/i)
    expect(refusal).toContain(`"slug":"demo"`)
    expect(refusal).toContain(initial.lock)
    // Nothing was applied and no consent was spent.
    expect((await run(host)).lock).toBe(initial.lock)
    expect((await ledger(host)).filter((e) => e.type === "amended" || e.type === "owner-message-consumed")).toHaveLength(0)
    expect(JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json")).requests[request.id].status).toBe("pending")
  } finally { await host.stop() }
}, 60000)

test("a refusal whose cause is not divergence keeps its existing wording", async () => {
  const state = { lock: "", decisionId: "" }
  const { host, owner, initial } = await staged(state)
  try {
    // No disk edit: the lock still matches. The owner's message simply is not
    // an authorization, so the resolver's own wording must survive unchanged.
    await host.client.session.prompt({ sessionID: owner, text: "RESOLVE" } as never)
    const refusal = await until(async () => (await toolResults(host)).find((text) => text.includes("does not authorize")), 15000)
    expect(refusal).toContain("The latest actual owner chat does not authorize this action/continuation")
    expect(refusal).not.toContain("goal_recover_divergence")
    expect((await run(host)).lock).toBe(initial.lock)
  } finally { await host.stop() }
}, 60000)

test("the recovery call in a divergence refusal uses the selected goal's own lock and slug", async () => {
  const state = { lock: "", decisionId: "" }
  const { host, owner, initial } = await staged(state)
  try {
    await Bun.write(join(host.project, ".opencode/goals/demo/goal.yaml"), DISK)
    await host.client.session.prompt({ sessionID: owner, text: "RESOLVE" } as never)
    const refusal = await until(async () => (await toolResults(host)).find((text) => text.includes("goal_recover_divergence")), 15000)
    // The exact call the owner can run, with the locked generation it targets.
    expect(refusal).toMatch(/goal_recover_divergence[^"]*\{[^}]*"slug"\s*:\s*"demo"/)
    expect(refusal).toMatch(new RegExp(`"expectedLock"\\s*:\\s*"${initial.lock}"`))
  } finally { await host.stop() }
}, 60000)
