import { expect, test } from "bun:test"
import { GoalRpc } from "../../src/rpc"
import { goalHost, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

test("fresh launch preserves the author's model/agent and history, records a durable pointer, and emits a focused navigation handoff", async () => {
  const host = await goalHost(script((_req, turn) => {
    if (turn.results === 0 && !turn.trigger.includes("HISTORY_MARKER")) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "handoff inspection" } }] }
    return { text: "Original authoring history remains intact." }
  }))
  let off: (() => void) | undefined
  try {
    // Different from the fixture's default build agent: inheriting defaults
    // accidentally must not masquerade as preserving the source session.
    const original: any = await host.client.session.create({ location: host.location, title: "Original authoring session", agent: "plan", model: { providerID: "fixture", id: "test" } } as any)
    await host.client.session.prompt({ sessionID: original.id, text: "HISTORY_MARKER preserve this original conversation" } as any)
    await until(() => host.fixture.requests.some((r) => r.tools?.length && JSON.stringify(r.messages).includes("HISTORY_MARKER")))
    const rpc: any = (host.client as any).rpc(GoalRpc)
    const handoffs: any[] = []
    off = rpc.events.on("handoff", (event: any) => handoffs.push(event.data))
    const before: any = await host.client.session.get({ sessionID: original.id } as any)
    await host.client.session.command({ sessionID: original.id, name: "goal", text: "start demo fresh" } as any)
    const state = await waitStatus(host, ["running", "waiting", "paused"], 30000)
    const fresh: any = await host.client.session.get({ sessionID: state.sessionID } as any)
    expect(state.sessionID).not.toBe(original.id)
    expect(fresh.parentID).toBeUndefined()
    expect(fresh.agent).toBe(before.agent)
    expect(fresh.model).toEqual(before.model)
    expect(state.handoff).toMatchObject({ fromSessionID: original.id, toSessionID: state.sessionID })
    const event = await until(() => handoffs.find((h) => h.fromSessionID === original.id && h.toSessionID === state.sessionID), 10000)
    expect(event.runId).toBe(state.runId)
    const originalMessages: any[] = await host.client.session.context({ sessionID: original.id } as any)
    // Public session-context messages are not OpenAI fixture ChatRequest
    // messages: preserve their structured user/parts payload when checking
    // original history and the synthetic pointer.
    const history = JSON.stringify(originalMessages)
    expect(history).toContain("HISTORY_MARKER")
    // resume:false preserves the author's idle conversation: V2 durably
    // queues the synthetic pointer in its inbox rather than delivering it
    // through an unwanted new model turn. Verify that REAL queued item,
    // independently of the always-visible persisted manager/sidebar link.
    const inbox: any[] = await (host.client.session as any).inbox.list({ sessionID: original.id })
    const pointer = inbox.find((item) => item.type === "synthetic" && item.sessionID === original.id && item.payload?.text?.includes(state.sessionID))
    expect(pointer).toBeDefined()
    expect(pointer.payload.text).toContain("Original history remains here")
    expect((await rpc.list({})).goals.find((g: any) => g.slug === "demo").handoff.fromSessionID).toBe(original.id)
  } finally { off?.(); await host.stop() }
}, 60000)
