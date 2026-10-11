import { expect, test } from "bun:test"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import type { GoalView } from "../../src/rpc"

// Exercise the actual slot with the actual Solid/OpenTUI renderer. A pure
// bannerText test cannot catch a slot that calculates that string only once.
ensureSolidTransformPlugin()
const { testRender } = await import("@opentui/solid")
const plugin = (await import("../../src/tui/index")).default
const sessionID = "ses_banner_transition"

const view = (slug: string, status: string): GoalView => ({
  slug, title: slug, outcome: "a verified outcome", status, runId: `run_${slug}`,
  turn: 1, timeline: [], activeMs: 0, activeSince: null,
  usage: { tokens: 0, cost: 0 }, budget: [], budgetRatio: 0,
  criteria: [], steps: [], awaitingUser: false, amendments: 0, flags: 0,
  updatedAt: Date.now(),
  ...(status === "running" ? { activity: { kind: "turn" as const, since: Date.now() } } : {}),
  ...(status === "blocked" ? { blocker: { key: "token", reason: `token for ${slug}`, count: 3 } } : {}),
})

async function mount(initial: GoalView | null) {
  const handlers = new Map<string, (event: any) => void>()
  const slots = new Map<string, any>()
  let serverView = initial
  let snapshots = 0
  let onData: (event: any) => void = () => {}
  const rpc = {
    snapshot: async () => { snapshots++; return { view: serverView } },
    list: async () => ({ goals: [] }),
    events: { on: (name: string, cb: (event: any) => void) => {
      handlers.set(name, cb)
      return () => handlers.delete(name)
    } },
  }
  const context = {
    client: { rpc: () => rpc },
    data: {
      session: { get: () => ({ location: { directory: "/project" } }) },
      listen: (cb: (event: any) => void) => { onData = cb; return () => {} },
    },
    theme: { text: { base: "#ffffff", muted: "#888888", feedback: {} } },
    ui: {
      slot: (claim: any) => { slots.set(claim.append, claim); return () => slots.delete(claim.append) },
      router: { current: () => ({ type: "session", sessionID }) },
      toast: { show: () => {} }, dialog: {},
    },
  }
  const stop = await plugin.setup(context as any)
  // Seed the known old view before mounting, exactly like opening the
  // composer in the already-completed goal session.
  if (initial) handlers.get("updated")!({ data: { sessionID, view: initial } })
  const terminal = await testRender(() => slots.get("session.composer.top").render({ sessionID }), {
    width: 160, height: 6,
  })
  await terminal.renderOnce()
  return {
    terminal,
    snapshots: () => snapshots,
    setServer: (next: GoalView | null) => { serverView = next },
    push: (next: GoalView | null) => {
      serverView = next
      handlers.get("updated")!({ data: { sessionID, view: next } })
    },
    reconnect: () => onData({ details: { type: "server.connected" } }),
    stop: () => { stop(); terminal.renderer.destroy() },
  }
}

test("mounted completed-goal banner clears when a new goal starts in the SAME session", async () => {
  const ui = await mount(view("ship-v032-trust-the-card", "complete"))
  try {
    expect(ui.terminal.captureCharFrame()).toContain(".opencode/goals/ship-v032-trust-the-card/")
    ui.push(view("ship-v033-goal-manager-flow", "running"))
    await ui.terminal.renderOnce()
    expect(ui.terminal.captureCharFrame()).not.toContain("loop has stopped")
    expect(ui.terminal.captureCharFrame()).not.toContain("ship-v032-trust-the-card")
  } finally { ui.stop() }
})

test("a composer mounted without a goal later displays the current goal banner", async () => {
  const ui = await mount(null)
  try {
    ui.push(view("new-goal", "blocked"))
    await ui.terminal.renderOnce()
    expect(ui.terminal.captureCharFrame()).toContain("token for new-goal")
  } finally { ui.stop() }
})

test("a missed start update still refreshes a previously TERMINAL snapshot", async () => {
  const ui = await mount(view("previous-goal", "complete"))
  try {
    const before = ui.snapshots()
    ui.setServer(view("next-goal", "blocked")) // no updated event at all
    await Bun.sleep(8300) // two existing 4s polling periods, no wall-time race
    await ui.terminal.renderOnce()
    expect(ui.snapshots()).toBeGreaterThan(before)
    expect(ui.terminal.captureCharFrame()).toContain("token for next-goal")
    expect(ui.terminal.captureCharFrame()).not.toContain("previous-goal")
  } finally { ui.stop() }
}, 15000)

test("reconnect replaces the old terminal banner with the current server view", async () => {
  const ui = await mount(view("previous-goal", "complete"))
  try {
    ui.setServer(view("next-goal", "blocked"))
    ui.reconnect()
    await Bun.sleep(10)
    await ui.terminal.renderOnce()
    expect(ui.terminal.captureCharFrame()).toContain("token for next-goal")
    expect(ui.terminal.captureCharFrame()).not.toContain("previous-goal")
  } finally { ui.stop() }
})
