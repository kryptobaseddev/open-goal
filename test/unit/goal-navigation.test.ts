import { expect, test } from "bun:test"
import { openGoalSession } from "../../src/tui/navigation"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"

test("explicit session jump opens and focuses by actual session ID, never by an invented tab ID", () => {
  const calls: unknown[] = []
  const ui: any = { tabs: { enabled: () => true, open: (id: string) => { calls.push(["open", id]); return true }, focus: (id: string) => { calls.push(["focus", id]); return true } }, router: { navigate: (destination: any) => calls.push(["route", destination]) } }
  expect(openGoalSession(ui, "ses_goal")).toBe("tab")
  expect(calls).toEqual([["open", "ses_goal"], ["focus", "ses_goal"]])
})

test("disabled or failing tab navigation uses the verified router fallback", () => {
  for (const enabled of [false, true]) {
    const calls: unknown[] = []
    const ui: any = { tabs: { enabled: () => enabled, open: () => false, focus: () => { throw new Error("must not focus a failed open") } }, router: { navigate: (destination: any) => calls.push(destination) } }
    expect(openGoalSession(ui, "ses_goal")).toBe("route")
    expect(calls).toEqual([{ type: "session", sessionID: "ses_goal" }])
  }
})

test("the TUI handoff event focuses the fresh tab only for its original authoring session", async () => {
  ensureSolidTransformPlugin()
  const plugin = (await import("../../src/tui/index")).default
  const handlers = new Map<string, any>(), calls: unknown[] = []
  let current = "ses_original"
  const stop = await plugin.setup({
    client: { rpc: () => ({ list: async () => ({ goals: [] }), events: { on: (name: string, handler: any) => { handlers.set(name, handler); return () => handlers.delete(name) } } }) },
    data: { session: { get: () => ({ location: { directory: "/project" } }) }, listen: () => () => {} },
    theme: { text: { base: "#ffffff", muted: "#888888", feedback: {} } },
    ui: { slot: () => () => {}, router: { current: () => ({ type: "session", sessionID: current }), navigate: (...args: any[]) => calls.push(["route", ...args]) },
      tabs: { enabled: () => true, open: (id: string) => { calls.push(["open", id]); return true }, focus: (id: string) => { calls.push(["focus", id]); return true } },
      toast: { show: () => {} }, dialog: {} },
  } as any)
  try {
    handlers.get("handoff")({ data: { fromSessionID: "ses_original", toSessionID: "ses_fresh", slug: "demo", runId: "run_demo" } })
    expect(calls).toEqual([["open", "ses_fresh"], ["focus", "ses_fresh"]])
    current = "ses_unrelated"
    handlers.get("handoff")({ data: { fromSessionID: "ses_original", toSessionID: "ses_other_fresh", slug: "second", runId: "run_second" } })
    expect(calls).toHaveLength(2) // a background handoff must not steal focus
  } finally { stop() }
})
