import { expect, test } from "bun:test"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { GoalRpc } from "../../src/rpc"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

ensureSolidTransformPlugin()
const { testRender } = await import("@opentui/solid")
// Exercise shipped precompiled bytes, not the source-only Solid transform.
const plugin = (await import("../../tui")).default

test("real two-session sidebar converges after missed events and reload from a goal-less primary session", async () => {
  const host = await goalHost(script((_req, turn) => {
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "sidebar convergence inspection" } }] }
    return { text: "Waiting while the owner inspects cards." }
  }), { ".opencode/goals/second/goal.yaml": DEMO_GOAL.replace("id: demo", "id: second").replace("Demo file says ok", "Second waiting goal") })
  let stop: (() => void) | undefined
  let terminal: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    const primary = await newSession(host), first = await newSession(host), second = await newSession(host)
    await host.client.session.command({ sessionID: first, name: "goal", text: "start demo" } as any)
    const one = await waitStatus(host, ["running", "waiting"], 30000)
    await host.client.session.command({ sessionID: second, name: "goal", text: "start second" } as any)
    const two = await waitStatus(host, ["running", "waiting"], 30000, "second")
    const real: any = (host.client as any).rpc(GoalRpc)
    const slots = new Map<string, any>()
    let reconnect: (event: any) => void = () => {}
    // Deliberately discard EVERY updated event. Collection polling must be
    // an independent path, not merely a retry of this session's snapshot.
    const rpc = {
      snapshot: (input: any) => real.snapshot(input, { location: host.location }),
      list: () => real.list({}, { location: host.location }),
      events: { on: () => () => {} },
    }
    stop = await plugin.setup({
      client: { rpc: () => rpc },
      data: { session: { get: () => ({ location: host.location }) }, listen: (cb: any) => { reconnect = cb; return () => {} } },
      theme: { text: { base: "#ffffff", muted: "#888888", feedback: {} } },
      ui: { slot: (claim: any) => { slots.set(claim.append, claim); return () => slots.delete(claim.append) }, router: { current: () => ({ type: "session", sessionID: primary }) }, toast: { show: () => {} }, dialog: {} },
    } as any)
    terminal = await testRender(() => slots.get("sidebar.content").render({ sessionID: primary, width: 34 }), { width: 34, height: 14 })
    const id1 = `goal-card:live:demo:${one.runId}`, id2 = `goal-card:live:second:${two.runId}`
    await until(async () => { await terminal!.renderOnce(); return terminal!.renderer.root.findDescendantById(id1) && terminal!.renderer.root.findDescendantById(id2) }, 10000)
    expect(await run(host).then((s) => s.sessionID)).toBe(first)
    const originalControl = terminal.renderer.root.findDescendantById(id1)
    await host.client.session.command({ sessionID: second, name: "goal", text: "pause" } as any)
    await waitStatus(host, ["paused"], 10000, "second")
    await until(async () => {
      await terminal!.renderOnce()
      const control = terminal!.renderer.root.findDescendantById(id2) as any
      return control?.getSelectedOption()?.description.includes("paused")
    }, 12000, 200)
    expect(["running", "waiting"]).toContain((await run(host)).status)
    expect(terminal.renderer.root.findDescendantById(id1)).toBe(originalControl)
    await host.client.location.reload()
    // v0.8.0 C1: `second` was owner-paused and stays paused; `demo` resumes.
    await waitStatus(host, ["paused"], 10000, "second")
    await until(async () => (await ledger(host)).some((e) => e.type === "restart-resume"), 10000)
    reconnect({ details: { type: "server.connected" } })
    // v0.8.0 C1: the clean reload resumes `demo`; only the owner-paused
    // `second` stays paused.
    await until(async () => {
      await terminal!.renderOnce()
      const paused = (id: string) => (terminal!.renderer.root.findDescendantById(id) as any)?.getSelectedOption()?.description.includes("paused")
      return paused(id2) && !paused(id1)
    }, 12000, 200)
    expect(terminal.renderer.root.findDescendantById(id1)).toBe(originalControl)
  } finally { stop?.(); terminal?.renderer.destroy(); await host.stop() }
}, 90000)
