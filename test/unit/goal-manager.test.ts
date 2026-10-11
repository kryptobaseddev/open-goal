import { expect, test } from "bun:test"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import type { GoalSummary } from "../../src/rpc"

ensureSolidTransformPlugin()
const { testRender } = await import("@opentui/solid")
const plugin = (await import("../../src/tui/index")).default

test("the existing Goals tab is a real selectable manager without a current-session goal; selection expands before an explicit jump", async () => {
  const slots = new Map<string, any>()
  const jumps: unknown[] = [], tabs: unknown[] = []
  const goal: GoalSummary = { key: "live:alpha:run_alpha", slug: "alpha", title: "Alpha Managed Goal", status: "paused", sessionID: "ses_alpha", sessionState: "present", agent: "build", runId: "run_alpha", lock: "a".repeat(64), total: 2, proven: 1, terminal: false, attachable: true, outcome: "A verified marker exists", valid: true }
  const rpc = {
    snapshot: async () => ({ view: null }), list: async () => ({ goals: [goal], directory: "/project" }),
    details: async () => ({ goal }),
    events: { on: () => () => {} },
  }
  const stop = await plugin.setup({
    client: { rpc: () => rpc }, data: { session: { get: () => ({ location: { directory: "/project" } }) }, listen: () => () => {} },
    theme: { text: { base: "#ffffff", muted: "#888888", feedback: {} } },
    ui: { slot: (claim: any) => { slots.set(claim.append, claim); return () => slots.delete(claim.append) }, router: { current: () => ({ type: "session", sessionID: "ses_primary" }), navigate: (...args: any[]) => jumps.push(args) },
      tabs: { enabled: () => true, open: (...args: any[]) => { tabs.push(args); return true }, focus: (...args: any[]) => { tabs.push(args); return true } },
      toast: { show: () => {} }, dialog: {}, panel: { open: () => {}, current: () => undefined, close: () => {} } },
  } as any)
  const terminal = await testRender(() => slots.get("session.panel").render({ name: "goal-dashboard", sessionID: "ses_primary", width: 38, focus: () => {} }), { width: 40, height: 24 })
  try {
    await Bun.sleep(25)
    await terminal.renderOnce()
    const list = terminal.renderer.root.findDescendantById("goal-manager-list") as any
    expect(list).toBeDefined() // native Select, not an informational line
    list.focus()
    terminal.mockInput.pressEnter()
    await Bun.sleep(25)
    await terminal.renderOnce()
    expect(terminal.renderer.root.findDescendantById("goal-manager-details")).toBeDefined()
    expect(terminal.captureCharFrame()).toContain("Alpha Managed Goal")
    expect(terminal.captureCharFrame()).toContain("A verified marker exists")
    expect(jumps).toHaveLength(0)
    expect(tabs).toHaveLength(0)
    const actions = terminal.renderer.root.findDescendantById("goal-manager-actions") as any
    expect(actions).toBeDefined()
    const choices = actions.options as Array<{ name: string; value: unknown }>
    expect(choices.map((c) => c.name)).toContain("Open goal session")
    expect(choices.map((c) => c.name)).toContain("Resume selected goal")
    expect(choices.map((c) => c.name)).toContain("Verify selected goal")
    expect(choices.map((c) => c.name)).toContain("Attach selected goal here")
  } finally { stop(); terminal.renderer.destroy() }
})
