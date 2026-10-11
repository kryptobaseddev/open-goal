import { expect, test } from "bun:test"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import type { GoalSummary } from "../../src/rpc"
import { fitColumns, sidebarCards } from "../../src/tui/manager"

ensureSolidTransformPlugin()
const { testRender } = await import("@opentui/solid")
const plugin = (await import("../../src/tui/index")).default

const goals: GoalSummary[] = [
  { key: "live:alpha:run_alpha", slug: "alpha", title: "Alpha Goal", status: "running", runId: "run_alpha", lock: "a".repeat(64), sessionID: "ses_alpha", agent: "build", priority: "high", terminal: false, proven: 0, total: 2 },
  { key: "live:beta:run_beta", slug: "beta", title: "Beta Goal", status: "paused", runId: "run_beta", lock: "b".repeat(64), sessionID: "ses_beta", agent: "build", terminal: false, proven: 1, total: 2 },
  { key: "archive:old:run_old", slug: "old", title: "Archived history", status: "complete", archived: true, terminal: true, proven: 2, total: 2 },
]

test("a goal-less primary session renders two real cross-session card controls; selecting a card expands before any session jump", async () => {
  const slots = new Map<string, any>(), handlers = new Map<string, any>()
  const panels: string[] = [], jumps: unknown[] = []
  let listReads = 0
  const rpc = {
    snapshot: async () => ({ view: null }),
    list: async () => { listReads++; return { goals: goals.map((g) => ({ ...g })), directory: "/project" } },
    events: { on: (name: string, handler: any) => { handlers.set(name, handler); return () => handlers.delete(name) } },
  }
  const context = {
    client: { rpc: () => rpc },
    data: { session: { get: () => ({ location: { directory: "/project" } }) }, listen: () => () => {} },
    theme: { text: { base: "#ffffff", muted: "#888888", feedback: {} } },
    ui: {
      slot: (claim: any) => { slots.set(claim.append, claim); return () => slots.delete(claim.append) },
      router: { current: () => ({ type: "session", sessionID: "ses_primary" }), navigate: (...args: any[]) => jumps.push(args) },
      panel: { open: (name: string) => panels.push(name), current: () => undefined, close: () => {} },
      toast: { show: () => {} }, dialog: {},
    },
  }
  const stop = await plugin.setup(context as any)
  const terminal = await testRender(() => slots.get("sidebar.content").render({ sessionID: "ses_primary", width: 28 }), { width: 28, height: 14 })
  try {
    await Bun.sleep(25)
    await terminal.renderOnce()
    // The actual OpenTUI nodes must exist. Labels in a transcript or a
    // formatting helper are NOT selectable card controls.
    const alpha = terminal.renderer.root.findDescendantById("goal-card:live:alpha:run_alpha") as any
    const beta = terminal.renderer.root.findDescendantById("goal-card:live:beta:run_beta") as any
    expect(alpha).toBeDefined()
    expect(beta).toBeDefined()
    expect(terminal.renderer.root.findDescendantById("goal-card:archive:old:run_old")).toBeUndefined()
    expect(listReads).toBeGreaterThan(0)
    const frame = terminal.captureCharFrame()
    expect(frame).toContain("Alpha Goal")
    expect(frame).toContain("Beta Goal")
    expect(frame).toContain("elsewhere")
    expect(frame).not.toContain("Archived history")
    await terminal.mockMouse.click(alpha.x + 1, alpha.y + 1)
    await terminal.renderOnce()
    expect(panels).toContain("goal-dashboard")
    expect(jumps).toHaveLength(0)
    alpha.focus()
    handlers.get("updated")({ data: { sessionID: "ses_alpha", view: null } })
    await Bun.sleep(25)
    await terminal.renderOnce()
    const refreshed = terminal.renderer.root.findDescendantById("goal-card:live:alpha:run_alpha") as any
    expect(refreshed).toBe(alpha) // periodic collection updates cannot reset focus
    expect(refreshed.focused).toBe(true)
    const before = panels.length
    terminal.mockInput.pressEnter()
    await terminal.renderOnce()
    expect(panels.length).toBeGreaterThan(before)
    expect(jumps).toHaveLength(0)
  } finally { stop(); terminal.renderer.destroy() }
})

test("stacked cards keep the current goal first, bound height, and preserve a manager overflow pointer", () => {
  const all = [...goals, ...Array.from({ length: 6 }, (_, i): GoalSummary => ({ slug: `draft-${i}`, title: `Draft ${i}`, status: "draft", proven: 0, total: 1 }))]
  const model = sidebarCards(all, "ses_beta", 28, 12)
  expect(model.cards[0]!.goal.slug).toBe("beta")
  expect(model.cards[0]!.description).toContain("here")
  expect(model.cards[1]!.description).toContain("elsewhere")
  expect(model.total).toBe(8)
  expect(model.cards).toHaveLength(2)
  expect(model.hidden).toBe(6)
  expect(model.pointer).toContain("F9 manager")
  expect(1 + model.cards.length * 4 + 1).toBeLessThanOrEqual(12)
})

test("narrow card labels are fitted by terminal columns without splitting Unicode graphemes", () => {
  const title = "工具👩‍💻 e\u0301 — a long goal title"
  for (const width of [4, 8, 14, 22, 40]) {
    const fitted = fitColumns(title, width)
    expect(Bun.stringWidth(fitted, { ambiguousIsNarrow: false })).toBeLessThanOrEqual(width)
    expect(fitted.endsWith("\u200d")).toBe(false)
    const model = sidebarCards([{ ...goals[0]!, title }], "ses_primary", width)
    for (const value of [model.cards[0]!.title, model.cards[0]!.description, model.cards[0]!.progress, model.pointer])
      expect(Bun.stringWidth(value, { ambiguousIsNarrow: false })).toBeLessThanOrEqual(width)
  }
})
