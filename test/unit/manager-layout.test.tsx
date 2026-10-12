/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { EventEmitter } from "node:events"
ensureSolidTransformPlugin()
const { testRender, useRenderer } = await import("@opentui/solid")
const { TextRenderable } = await import("@opentui/core")
const { createComponent, createSignal, Show } = await import("solid-js")
const plugin = (await import("../../dist/tui.js")).default

test("long real-shaped details reflow while actions/Close stay visible; keyboard and pointer operate exact controls", async () => {
  const slots = new Map<string, any>(), calls: any[] = [], jumps: string[] = []
  const resizeEvents = new EventEmitter()
  let commands: any[] = [], closes = 0, terminal: any
  const [width, setWidth] = createSignal(90), [focused, setFocused] = createSignal(false), [open, setOpen] = createSignal(true)
  const goal: any = { key: "live:long-goal:run_exact", slug: "long-goal", title: "A deployed goal manager and natural-language lifecycle", status: "paused", sessionID: "ses_goal", sessionState: "present",
    runId: "run_exact", lock: "a".repeat(64), total: 17, proven: 1, valid: true, terminal: false, agent: "build", sessionTitle: "Original goal session",
    outcome: "An immutable release is installed and its exact Git revision and UI artifacts are verified in the owner's running OpenCode location. Agents handle supported lifecycle requests through natural language and guarded typed operations. The original history remains intact. ".repeat(5),
    steps: [{ id: "S1", title: "Capture evidence", status: "done" }, { id: "S2", title: "Finish deployed proof", status: "active" }],
    details: { criteria: Array.from({ length: 17 }, (_, i) => ({ id: `C${i + 1}`, statement: `Criterion ${i + 1} requires host evidence and exact selected-run binding, not a version label.`, status: "unknown" })) } }
  const location = { directory: "/qa" }
  const stop = await plugin.setup({
    renderer: resizeEvents,
    client: { rpc: () => ({ snapshot: async () => ({ view: null, launches: [] }), list: async () => ({ goals: [goal], directory: location.directory }),
      details: async () => ({ goal }), manage: async (input: any) => { calls.push(input); return { ok: true, pending: true, message: "Native review required" } },
      events: { on: () => () => {} } }) }, location,
    data: { listen: () => () => {}, location: { default: () => location }, session: { get: () => ({ location }) } },
    theme: { text: { base: "#ffffff", muted: "#aaaaaa", feedback: {} } },
    keymap: { layer: (factory: any) => { commands = factory().commands; return () => {} } },
    ui: { slot: (claim: any) => { slots.set(claim.append, claim); return () => slots.delete(claim.append) },
      router: { current: () => ({ type: "session", sessionID: "ses_primary" }) },
      tabs: { enabled: () => true, open: (id: string) => { jumps.push(`open:${id}`); return true }, focus: (id: string) => { jumps.push(`focus:${id}`); return true } },
      // Match actual 2.0.26: the fullscreen slot can be mounted even though
      // ui.panel.current returns null; the slot's own close remains valid.
      panel: { current: () => null, open: () => { setOpen(true); setFocused(true) }, close: () => { closes += 1; setOpen(false) } },
      dialog: {}, toast: { show: () => {} } },
  } as any)
  try {
    const input = { name: "goal-dashboard", sessionID: "ses_primary", presentation: "fullscreen", get width() { return width() }, get focused() { return focused() },
      focus: () => setFocused(true), close: () => { closes += 1; setOpen(false) } } // real PanelInput has no height
    terminal = await testRender(() => {
      // A native host sidebar, not orphan text at the renderer root.
      const renderer = useRenderer()
      return [slots.get("app").render(), createComponent(Show, {
        keyed: true as const, get when() { return open() },
        // Solid's generic Show declaration names DOM Element; this test
        // uses the installed OpenTUI universal renderer's native node type.
        get fallback() { return new TextRenderable(renderer, { id: "basic-sidebar", content: "Basic sidebar", height: 1 }) as any },
        get children() { return slots.get("session.panel").render(input) },
      })]
    }, { width: 90, height: 28 })
    terminal.renderer.on("resize", (...args: any[]) => resizeEvents.emit("resize", ...args))
    const render = async () => { await Bun.sleep(30); await terminal.renderOnce() }
    const control = (id: string) => terminal.renderer.root.findDescendantById(id) as any
    await render(); setFocused(true); await render()
    const list = control("goal-manager-list")
    expect(list.focused).toBe(true)
    terminal.mockInput.pressEnter(); await render()
    expect(control("goal-manager-details")).toBeDefined()
    const actions = control("goal-manager-actions"), close = control("goal-manager-close"), details = control("goal-manager-detail-text")
    expect(actions.focused).toBe(true)
    expect(terminal.captureCharFrame()).toContain("F9: return to sidebar")
    expect(terminal.captureCharFrame()).toContain("1/17 host-proven")
    expect(terminal.captureCharFrame()).toContain("Plan: 1/2 done")
    expect(details.scrollHeight).toBeGreaterThan(details.viewport.height)
    for (const size of [[48, 22], [110, 30]]) {
      actions.blur(); setFocused(false) // reproduce host reflow losing scope/input ownership
      terminal.renderer.resize(size[0], size[1]); setWidth(size[0]); await render()
      expect(control("goal-manager-actions").focused).toBe(true)
      for (const id of ["goal-manager-close", "goal-manager-actions", "goal-manager-list", "goal-manager-detail-text"]) {
        const c = control(id)
        expect(c.x).toBeGreaterThanOrEqual(0)
        expect(c.x + c.width).toBeLessThanOrEqual(size[0])
        expect(c.y + c.height).toBeLessThanOrEqual(size[1])
      }
      expect(control("goal-manager-actions").getSelectedOption().name).toBe("Open goal session")
    }
    actions.focus(); terminal.mockInput.pressEnter(); await render()
    expect(jumps).toEqual(["open:ses_goal", "focus:ses_goal"])
    await terminal.mockMouse.click(actions.x + 2, actions.y + 1); await render()
    expect(calls).toEqual([{ sessionID: "ses_primary", action: "resume", target: { key: goal.key, lock: goal.lock, runId: goal.runId, sessionID: goal.sessionID } }])
    commands.find((c) => c.id === "goal.dashboard.tab").run(); await render()
    expect(control("goal-manager-close").focused).toBe(true)
    terminal.mockInput.pressEnter(); await render()
    expect(closes).toBe(1)
    expect(terminal.captureCharFrame()).toContain("Basic sidebar")
    commands.find((c) => c.id === "goal.panel").run(); await render()
    expect(control("goal-manager-actions").focused).toBe(true)
    commands.find((c) => c.id === "goal.panel").run(); await render()
    expect(closes).toBe(2)
    expect(control("goal-manager")).toBeUndefined()
    expect(control("basic-sidebar")).toBeDefined()
    expect(terminal.captureCharFrame()).toContain("Basic sidebar")
  } finally { stop(); terminal?.renderer.destroy() }
})
