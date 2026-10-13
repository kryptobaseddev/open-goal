import { expect, test } from "bun:test"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import type { GoalView, LaunchView } from "../../src/rpc"
ensureSolidTransformPlugin()
const { testRender } = await import("@opentui/solid")
const plugin = (await import("../../dist/tui.js")).default

const sid = "ses_existing", lock = "1".repeat(64)
const launch: LaunchView = { decisionId: "late-review", sessionID: sid, slug: "demo", lock, fresh: false, status: "failed", expiresAt: Date.now() + 60000,
  result: 'This session already has goal "demo" (running). Abort it first with /goal abort.' }

test("the actual compiled Composer banner distinguishes a failed attempt from the exact live run", async () => {
  const slots = new Map<string, any>(), handlers = new Map<string, any>()
  const view: GoalView = { slug: "demo", title: "Existing goal", outcome: "marker ready", sessionID: sid, lock, runId: "run_existing", status: "running", turn: 4,
    timeline: [], activeMs: 0, activeSince: Date.now(), usage: { tokens: 0, cost: 0 }, budget: [], budgetRatio: 0, criteria: [], steps: [], awaitingUser: false, amendments: 0, flags: 0, updatedAt: Date.now() }
  const stop = await plugin.setup({ client: { rpc: () => ({ snapshot: async () => ({ view, launches: [launch] }), list: async () => ({ goals: [], directory: "/fixture" }), events: { on: (name: string, handler: any) => { handlers.set(name, handler); return () => {} } } }) },
    location: { directory: "/fixture" }, data: { session: { get: () => ({ location: { directory: "/fixture" } }) }, listen: () => () => {} },
    theme: { text: { base: "#ffffff", muted: "#888888", feedback: {} } }, ui: { slot: (claim: any) => { slots.set(claim.append, claim); return () => {} }, router: { current: () => ({ type: "session", sessionID: sid }) }, panel: { current: () => undefined } } } as any)
  const terminal = await testRender(() => slots.get("session.composer.top").render({ sessionID: sid }), { width: 120, height: 12 })
  try {
    await Bun.sleep(25); await terminal.renderOnce()
    const control: any = terminal.renderer.root.findDescendantById("goal-launch-admission")
    expect(control).toBeDefined()
    const row = terminal.captureCharFrame().split("\n")[control.y]!
    expect(row).toContain("Goal demo · running")
    expect(row).toContain("attempt failed")
    expect(row).not.toContain("Abort it first")
    handlers.get("updated")({ data: { sessionID: sid, view: { ...view, status: "paused" } } })
    await terminal.renderOnce()
    expect(terminal.captureCharFrame().split("\n")[control.y]).toContain("Goal demo · paused")
    // A changed generation cannot be inferred as the target of an old review.
    handlers.get("updated")({ data: { sessionID: sid, view: { ...view, lock: "2".repeat(64) } } })
    await terminal.renderOnce()
    expect(terminal.captureCharFrame().split("\n")[control.y]).toContain("Launch demo · failed")
  } finally { stop(); terminal.renderer.destroy() }
})
