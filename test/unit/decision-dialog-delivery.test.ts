import { expect, test } from "bun:test"
import plugin from "../../dist/tui.js"

const question = "Exact reviewed target; decision: qa-review"
const form = { id: "frm_exact", state: { status: "pending" }, fields: [{ key: "q0", title: "Goal", description: question, options: [{ label: "Resume selected goal", value: "resume-exact" }] }] }
async function setup(expiresAt = Date.now() + 60000) {
  const events = new Map<string, any>(), replies: any[] = [], toasts: any[] = []
  let notify!: (event: any) => void
  let forms: any[] = []
  const stop = await plugin.setup({
    client: { rpc: () => ({ events: { on: (name: string, cb: any) => { events.set(name, cb); return () => events.delete(name) } } }) },
    data: { listen: (cb: any) => { notify = cb; return () => {} }, location: { default: () => ({ directory: "/qa" }) },
      session: { get: () => ({ location: { directory: "/qa" } }), form: { sync: async () => {}, list: () => forms,
        reply: async (input: any) => { replies.push(input) } } } },
    ui: { slot: () => () => {}, router: { current: () => ({ type: "session", sessionID: "ses_exact" }) },
      dialog: { select: async () => "0", clear: () => {} }, toast: { show: (value: any) => toasts.push(value) } },
  } as any)
  const choose = () => events.get("decision")({ data: { sessionID: "ses_exact", decisionId: "qa-review", question, expiresAt,
    kind: "owner-operation", message: "Resume exact QA target?", choices: [{ label: "Resume selected goal", act: "resume" }] } })
  return { choose, replies, toasts, stop, setForms: (value: any[]) => { forms = value }, notify: (type: string, data?: any) => notify({ details: { type, data } }), event: (type: string, data: any) => events.get(type)({ data }) }
}
const settle = () => Bun.sleep(30)

test("a popup pick before the form exists delivers exactly once on the real form.created event", async () => {
  const ui = await setup()
  try {
    ui.choose(); await settle()
    expect(ui.replies).toHaveLength(0)
    expect(ui.toasts.some((t) => /not executed|not yet delivered/i.test(t.message))).toBe(true)
    ui.setForms([form]); ui.notify("form.created"); await settle()
    expect(ui.replies).toEqual([{ sessionID: "ses_exact", formID: "frm_exact", answer: { q0: "resume-exact" } }])
    ui.notify("form.created"); ui.notify("server.connected"); await settle()
    expect(ui.replies).toHaveLength(1)
  } finally { ui.stop() }
})

test("an expired popup cannot answer a still-rendered form and reports no operation executed", async () => {
  const ui = await setup(Date.now() - 1)
  try {
    ui.setForms([form]); ui.choose(); await settle()
    expect(ui.replies).toHaveLength(0)
    expect(ui.toasts.some((t) => /expired/i.test(t.message) && /not executed|nothing executed/i.test(t.message))).toBe(true)
  } finally { ui.stop() }
})

test("queued choices never settle unrelated forms; failed engine resolution stays visible", async () => {
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

test("native dismissal withdraws an undelivered pick; a re-presented form requires a new real popup choice", async () => {
  const ui = await setup()
  try {
    ui.choose(); await settle()
    ui.notify("form.cancelled", { sessionID: "ses_exact", id: "frm_dismissed" })
    ui.setForms([{ ...form, id: "frm_reopened" }]); ui.notify("form.created"); await settle()
    expect(ui.replies).toHaveLength(0)
    expect(ui.toasts.some((t) => /withdrawn/i.test(t.message) && /nothing executed/i.test(t.message))).toBe(true)
    ui.choose(); await settle()
    expect(ui.replies).toEqual([{ sessionID: "ses_exact", formID: "frm_reopened", answer: { q0: "resume-exact" } }])
  } finally { ui.stop() }
})
