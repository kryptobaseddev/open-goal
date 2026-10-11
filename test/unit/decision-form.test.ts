import { expect, test } from "bun:test"
import { decisionFormAnswer } from "../../src/tui/decision-form"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"

test("dialog choices settle only the exact pending native question, using its offered wire value", () => {
  const question = "Abort demo at lock abc?\nDecision: unique"
  const form = (id: string, title: string, status = "pending") => ({ id, state: { status }, fields: [{ key: "q0", title, options: [{ label: "Abort selected goal", value: "native-value" }] }] })
  expect(decisionFormAnswer([form("unrelated", "other question"), form("settled", question, "answered")], question, "Abort selected goal")).toBeUndefined()
  expect(decisionFormAnswer([form("exact", question)], question, "Abort selected goal but do not execute")).toBeUndefined()
  expect(decisionFormAnswer([form("unrelated", "other question"), form("exact", question)], question, "Abort selected goal")).toEqual({ formID: "exact", answer: { q0: "native-value" } })
})

test("the real TUI dialog forwards its choice into the native form, not a second independent RPC action", async () => {
  ensureSolidTransformPlugin()
  const plugin = (await import("../../src/tui/index")).default
  const handlers = new Map<string, any>(), replies: any[] = [], acts: any[] = []
  const question = "Reviewed abort demo\nDecision: exact-id"
  let listen: any, forms: any[] = []
  const stop = await plugin.setup({
    client: { rpc: () => ({ list: async () => ({ goals: [] }), act: async (a: any) => { acts.push(a); return { ok: true, message: "ok" } }, events: { on: (n: string, h: any) => { handlers.set(n, h); return () => handlers.delete(n) } } }) },
    data: { session: { get: () => ({ location: { directory: "/project" } }), form: { sync: async () => {}, list: () => forms, reply: async (input: any) => { replies.push(input) } } }, listen: (h: any) => { listen = h; return () => {} } },
    theme: { text: { base: "#fff", muted: "#888", feedback: {} } },
    ui: { slot: () => () => {}, router: { current: () => ({ type: "session", sessionID: "ses_owner" }) },
      toast: { show: () => {} }, dialog: { select: async () => "0", clear: () => {} } },
  } as any)
  try {
    handlers.get("decision")({ data: { sessionID: "ses_owner", decisionId: "exact-id", question, choices: [{ label: "Abort", act: "abort" }] } })
    await Bun.sleep(10)
    expect(acts).toEqual([])
    expect(replies).toEqual([]) // dialog can arrive before its question
    forms = [{ id: "frm_unrelated", fields: [{ key: "q0", title: "other", options: [{ label: "Abort", value: "Abort" }] }] },
      { id: "frm_exact", fields: [{ key: "q0", title: question, options: [{ label: "Abort", value: "Abort" }] }] }]
    listen({ details: { type: "form.asked" } })
    await Bun.sleep(10)
    expect(replies).toEqual([{ sessionID: "ses_owner", formID: "frm_exact", answer: { q0: "Abort" } }])
    listen({ details: { type: "server.connected" } })
    await Bun.sleep(10)
    expect(replies).toHaveLength(1)
    expect(acts).toEqual([])
  } finally { stop() }
})
