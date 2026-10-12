import { expect, test } from "bun:test"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
// Match the real host runtime BEFORE importing shipped code; a static
// import can cache Solid's SSR entry first and poison later native tests.
ensureSolidTransformPlugin()
const plugin = (await import("../../dist/tui.js")).default

// Load the shipped compiled artifact; do not transform source TSX for this proof.
const sid = "ses_owner", lock = "a".repeat(64)
const goal = { key: "live:demo:run_demo", slug: "demo", title: "Demo", status: "paused", sessionID: sid, runId: "run_demo", lock, valid: true, terminal: false, proven: 0, total: 1 }
async function setup() {
  const events = new Map<string, any>(), slots = new Map<string, any>(), calls: any[] = [], dialogs: string[] = [], replies: any[] = [], toasts: any[] = []
  let commands: any[] = [], notify!: (event: any) => void, panelOpen = false, panelCloses = 0
  const location = { directory: "/qa" }
  const rpc = { snapshot: async () => ({ view: goal }), list: async () => ({ goals: [goal], directory: location.directory }),
    review: async (input: any, options: any) => { calls.push({ method: "review", input, options }); return { ok: true, message: "Review shown in Composer" } },
    manage: async (input: any, options: any) => { calls.push({ method: "manage", input, options }); return { ok: true, pending: true, message: "Native confirmation prepared" } },
    act: async (input: any) => { calls.push({ method: "act", input }); return { ok: true, message: "Owner action" } },
    events: { on: (name: string, cb: any) => { events.set(name, cb); return () => events.delete(name) } } }
  const stop = await plugin.setup({ client: { rpc: () => rpc }, location,
    data: { listen: (cb: any) => { notify = cb; return () => {} }, location: { default: () => location }, session: { get: () => ({ location }),
      form: { sync: async () => {}, list: () => [], reply: async (input: any) => replies.push(input) } } },
    keymap: { layer: (factory: any) => { commands = factory().commands; return () => {} } },
    ui: { slot: (claim: any) => { slots.set(claim.append, claim); return () => slots.delete(claim.append) },
      router: { current: () => ({ type: "session", sessionID: sid }) },
      panel: { current: () => panelOpen ? { name: "goal-dashboard" } : undefined, close: () => { panelOpen = false; panelCloses += 1 } },
      dialog: { select: async () => { dialogs.push("select"); return "0" }, confirm: async () => { dialogs.push("confirm"); return true }, alert: async () => dialogs.push("alert"), clear: () => dialogs.push("clear") },
      toast: { show: (value: any) => toasts.push(value) } },
  } as any)
  return { stop, calls, dialogs, replies, toasts, location, openPanel: () => { panelOpen = true }, panelCloses: () => panelCloses,
    event: (type: string, data: any) => events.get(type)({ data }),
    notify: (type: string, data?: any) => notify({ details: { type, data } }),
    command: (id: string) => { slots.get("app").render(); return commands.find((c) => c.id === id) } }
}

test("engine decisions use only Composer; early creation/reconnect/cancellation never synthesizes an owner reply", async () => {
  const ui = await setup()
  try {
    ui.event("decision", { sessionID: sid, kind: "owner-operation", decisionId: "review", question: "Exact review", expiresAt: 1,
      message: "Resume exact goal?", choices: [{ label: "Resume selected goal", act: "resume" }] })
    ui.notify("form.created"); ui.notify("server.connected"); ui.notify("form.cancelled", { sessionID: sid })
    await Bun.sleep(30)
    expect(ui.dialogs).toEqual([])
    expect(ui.replies).toEqual([])
    expect(ui.calls).toEqual([])
    expect(ui.toasts.some((t) => /composer/i.test(t.message))).toBe(true)
  } finally { ui.stop() }
})

test("a current native question reveals Composer instead of keeping Enter on manager actions; elsewhere decisions do not hijack it", async () => {
  const ui = await setup()
  try {
    ui.openPanel()
    const decision = { kind: "owner-operation", decisionId: "review", choices: [{ label: "Abort selected goal", act: "abort" }] }
    ui.event("decision", { ...decision, sessionID: "ses_elsewhere" })
    expect(ui.panelCloses()).toBe(0)
    ui.event("decision", { ...decision, sessionID: sid })
    expect(ui.panelCloses()).toBe(1)
    expect(ui.dialogs).toEqual([])
    expect(ui.replies).toEqual([])
  } finally { ui.stop() }
})

test("native operation results remain explicit without closing an unrelated host dialog", async () => {
  const ui = await setup()
  try {
    ui.event("decision.failed", { sessionID: sid, decisionId: "review", message: "Target changed; nothing executed." })
    ui.event("decision.resolved", { sessionID: sid, decisionId: "review", message: "Goal resumed." })
    expect(ui.toasts.some((t) => t.variant === "warning" && /nothing executed/i.test(t.message))).toBe(true)
    expect(ui.toasts.some((t) => t.variant === "success" && t.message === "Goal resumed.")).toBe(true)
    expect(ui.dialogs).toEqual([])
    expect(ui.replies).toEqual([])
  } finally { ui.stop() }
})

test("palette review and abort route to exact native review instead of a second approval or confirm popup", async () => {
  const ui = await setup()
  try {
    ui.event("updated", { sessionID: sid, view: goal })
    const review = ui.command("goal.approve")
    expect(review.title).toMatch(/native review|composer/i)
    await review.run()
    await ui.command("goal.abort").run()
    expect(ui.dialogs).toEqual([])
    expect(ui.replies).toEqual([])
    expect(ui.calls).toEqual([
      { method: "review", input: { sessionID: sid }, options: { location: ui.location } },
      { method: "manage", input: { sessionID: sid, action: "abort", target: { key: goal.key, runId: goal.runId, lock, sessionID: sid } }, options: { location: ui.location } },
    ])
  } finally { ui.stop() }
})
