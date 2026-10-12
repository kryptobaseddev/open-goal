import { expect, test } from "bun:test"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
ensureSolidTransformPlugin()
const plugin = (await import("../../dist/tui.js")).default

const question = "Exact reviewed target; decision: qa-review"
const form = { id: "frm_exact", state: { status: "pending" }, fields: [{ key: "q0", title: "Goal", description: question, options: [{ label: "Resume selected goal", value: "resume-exact" }] }] }
async function setup(expiresAt = Date.now() + 60000) {
  const events = new Map<string, any>(), replies: any[] = [], toasts: any[] = [], dialogs: any[] = []
  let notify!: (event: any) => void
  let forms: any[] = []
  const stop = await plugin.setup({
    client: { rpc: () => ({ events: { on: (name: string, cb: any) => { events.set(name, cb); return () => events.delete(name) } } }) },
    data: { listen: (cb: any) => { notify = cb; return () => {} }, location: { default: () => ({ directory: "/qa" }) },
      session: { get: () => ({ location: { directory: "/qa" } }), form: { sync: async () => {}, list: () => forms,
        reply: async (input: any) => { replies.push(input) } } } },
    ui: { slot: () => () => {}, router: { current: () => ({ type: "session", sessionID: "ses_exact" }) },
      dialog: { select: async () => { dialogs.push("select"); return "0" }, clear: () => dialogs.push("clear") }, toast: { show: (value: any) => toasts.push(value) } },
  } as any)
  const choose = () => events.get("decision")({ data: { sessionID: "ses_exact", decisionId: "qa-review", question, expiresAt,
    kind: "owner-operation", message: "Resume exact QA target?", choices: [{ label: "Resume selected goal", act: "resume" }] } })
  return { choose, replies, toasts, dialogs, stop, setForms: (value: any[]) => { forms = value }, notify: (type: string, data?: any) => notify({ details: { type, data } }), event: (type: string, data: any) => events.get(type)({ data }) }
}
const settle = () => Bun.sleep(30)

test("Composer-only policy removes the competing popup; early form/reconnect events cannot authorize any reply", async () => {
  const ui = await setup()
  try {
    ui.choose(); await settle()
    expect(ui.replies).toHaveLength(0)
    expect(ui.toasts.some((t) => /composer/i.test(t.message) && /no operation executed/i.test(t.message))).toBe(true)
    ui.setForms([form]); ui.notify("form.created"); await settle()
    expect(ui.replies).toEqual([])
    expect(ui.dialogs).toEqual([])
    ui.notify("form.created"); ui.notify("server.connected"); await settle()
    expect(ui.replies).toHaveLength(0)
  } finally { ui.stop() }
})

test("legacy timed review notifications cannot answer a still-rendered native form", async () => {
  const ui = await setup(Date.now() - 1)
  try {
    ui.setForms([form]); ui.choose(); await settle()
    expect(ui.replies).toHaveLength(0)
    expect(ui.toasts.some((t) => /composer/i.test(t.message) && /no operation executed/i.test(t.message))).toBe(true)
    expect(ui.dialogs).toEqual([])
  } finally { ui.stop() }
})

test("notifications never settle unrelated forms; failed engine resolution stays visible", async () => {
  const ui = await setup()
  try {
    ui.choose(); await settle()
    ui.setForms([{ ...form, fields: [{ ...form.fields[0], description: "An unrelated owner review" }] }]); ui.notify("form.created"); await settle()
    expect(ui.replies).toHaveLength(0)
    ui.event("decision.failed", { sessionID: "ses_exact", decisionId: "qa-review", message: "Review expired; nothing executed." }); await settle()
    expect(ui.toasts.some((t) => t.variant === "warning" && /nothing executed/i.test(t.message))).toBe(true)
    ui.setForms([form]); ui.notify("form.created"); await settle()
    expect(ui.replies).toHaveLength(0)
  } finally { ui.stop() }
})

test("native dismissal/re-presentation never reuses a hidden popup pick or synthesizes new consent", async () => {
  const ui = await setup()
  try {
    ui.choose(); await settle()
    ui.notify("form.cancelled", { sessionID: "ses_exact", id: "frm_dismissed" })
    ui.setForms([{ ...form, id: "frm_reopened" }]); ui.notify("form.created"); await settle()
    expect(ui.replies).toHaveLength(0)
    expect(ui.dialogs).toEqual([])
    ui.choose(); await settle()
    expect(ui.replies).toEqual([])
    expect(ui.dialogs).toEqual([])
  } finally { ui.stop() }
})
