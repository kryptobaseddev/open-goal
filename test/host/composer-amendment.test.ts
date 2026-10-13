import { expect, test } from "bun:test"
import { parseContract } from "../../src/contract/parse"
import { join } from "node:path"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

const yaml = `schema: goal/v1
id: chat-amend
title: Composer chat reviews an exact amendment
intent: {verbatim: keep the marker and review its meaning}
outcome: the marker exists under the reviewed semantics
non_goals: [other files, self approval]
criteria:
  - id: C1
    statement: marker exists
    check: {kind: file, path: marker.txt}
  - id: C2
    statement: owner inspects marker meaning
    check: {kind: human, ask: inspect marker meaning}
protect: [oracle.txt]
`
const changed = yaml.replace("marker exists\n", "marker exists with revised meaning\n")
const lock = parseContract(yaml).lock

async function setup(action: "accept" | "reject" | "comment" = "accept", continueGoal: boolean | null = false, withForm = false, delayedForm = false) {
  let decisionId = ""
  let runId = "", actorID = ""
  let repeat = false
  const host = await goalHost(script((_req, turn) => {
    const form = turn.trigger.split("\n").find((line) => line.startsWith("GOAL_FORM_JSON:"))
    if (withForm && form && !turn.results) return { toolCalls: [{ name: "question", args: JSON.parse(form.slice("GOAL_FORM_JSON:".length)) }] }
    if (turn.trigger.includes("GOAL_FORM_JSON:") || turn.trigger.includes("GOAL_DECISION_JSON:"))
      return { text: "Exact proposal is reviewed; await actual Composer chat, not a sidebar or manual command." }
    if (turn.trigger.includes("goal started")) {
      if (!turn.results) return { toolCalls: [{ name: "write", args: { path: "marker.txt", content: "marker" } }] }
      if (turn.results === 1) return { toolCalls: [{ name: "goal_claim", args: { summary: "marker written", evidence: { C1: "marker file", C2: "needs owner" } } }] }
    }
    if (turn.trigger === "Stage my requested amendment" && !turn.results)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "chat-amend", expectedLock: lock, yaml: changed, rationale: "Owner requested revised meaning" } }] }
    if (turn.trigger === "Request a resume review" && !turn.results) {
      return { toolCalls: [{ name: "goal_manage", args: { action: "resume", target: { key: `live:chat-amend:${runId}`, lock, runId, sessionID: actorID } } }] }
    }
    if (turn.trigger === "Request a resume review") return { text: "Review staged, not resumed." }
    if (decisionId && !turn.trigger.includes("Owner commentary") && (turn.results === 0 || repeat && turn.results === 1))
      return { toolCalls: [{ name: "goal_resolve_amendment", args: { decisionId, action, ...(continueGoal === null ? {} : { continueGoal }) } }] }
    return { text: "No fabricated acceptance or additional action." }
  }), { ".opencode/goals/chat-amend/goal.yaml": yaml }, { plugin: process.env.OCGOAL_GIT_SPEC,
    ...(delayedForm ? { extraPlugins: [join(import.meta.dir, "../fixtures/delayed-amendment-form")] } : {}) })
  const sessionID = await newSession(host)
  await host.client.session.command({ sessionID, name: "goal", text: "start chat-amend" } as any)
  const before = await waitStatus(host, ["needs_review"], 20000, "chat-amend")
  runId = before.runId; actorID = sessionID
  expect(before.criteria.C1.status).toBe("pass")
  await host.client.session.prompt({ sessionID, text: "Stage my requested amendment" } as any)
  const request: any = await until(async () => {
    const store = JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json").catch(() => '{"requests":{}}'))
    return Object.values(store.requests).find((r: any) => r.slug === "chat-amend" && r.status === "pending")
  }, 15000)
  decisionId = request.id
  if (!withForm) await host.client.session.wait({ sessionID } as any)
  return { host, sessionID, before, request, repeat: () => { repeat = true } }
}

test("actual owner chat arriving before the native form binds is not swallowed by its later creation", async () => {
  const { host, sessionID, request } = await setup("accept", false, true, true)
  try {
    await until(async () => await host.readProject("question-dispatched.json").catch(() => undefined), 15000)
    const forms: any[] = await (host.client.session.form as any).list({ sessionID })
    expect(forms.some((f) => JSON.stringify(f).includes(request.id))).toBe(false)
    await host.client.session.prompt({ sessionID, text: "I accept the amendment" } as any)
    await until(async () => (await run(host, "chat-amend")).lock === request.nextLock, 15000)
    expect((await ledger(host, "chat-amend")).filter((e) => e.type === "amended")).toHaveLength(1)
    expect((await ledger(host, "chat-amend")).filter((e) => e.type === "owner-message-consumed")).toHaveLength(1)
  } catch (error) {
    const evidence = join(import.meta.dir, "../../.tmp/verification/v0311-source/pre-form-failure.json")
    await Bun.write(evidence, JSON.stringify({ preFormFailure: String(error), project: host.project,
      run: await run(host, "chat-amend"), reviews: await host.readProject(".opencode/goals/.owner-amendments.json"),
      events: await ledger(host, "chat-amend"), context: await host.client.session.context({ sessionID } as any), server: host.log() }, null, 2))
    console.error(`Pre-form chat failed; raw evidence retained at ${evidence}`)
    throw error
  } finally { await host.stop() }
}, 60000)

test("explicit Composer revision feedback unholds the delayed native review but never applies or resumes it", async () => {
  const { host, sessionID, before, request } = await setup("comment", false, true, true)
  try {
    await until(async () => await host.readProject("question-dispatched.json").catch(() => undefined), 15000)
    await host.client.session.prompt({ sessionID, text: 'change C1 to "marker is ready" if needed' } as any)
    await until(async () => (await ledger(host, "chat-amend")).some((e) => e.type === "amendment-feedback"), 15000)
    const after = await run(host, "chat-amend")
    expect(after.lock).toBe(before.lock)
    expect(after.criteria).toEqual(before.criteria)
    expect((await ledger(host, "chat-amend")).filter((e) => e.type === "amended" || e.type === "resumed")).toHaveLength(0)
    expect(JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json")).requests[request.id].status).toBe("commented")
  } finally { await host.stop() }
}, 60000)

test("a later owner contradiction clears pre-form unhold intent without spending or applying consent", async () => {
  const { host, sessionID, before, request } = await setup("accept", false, true, true)
  try {
    await until(async () => await host.readProject("question-dispatched.json").catch(() => undefined), 15000)
    await host.client.session.prompt({ sessionID, text: "I accept the amendment" } as any)
    await host.client.session.prompt({ sessionID, text: "Do not accept the amendment" } as any)
    const form: any = await until(async () => {
      const forms: any[] = await (host.client.session.form as any).list({ sessionID })
      return forms.find((f) => JSON.stringify(f).includes(request.id))
    }, 15000)
    expect((await (host.client.session.form as any).get({ sessionID, formID: form.id })).state.status).toBe("pending")
    expect((await run(host, "chat-amend")).lock).toBe(before.lock)
    expect((await ledger(host, "chat-amend")).filter((e) => e.type === "amended" || e.type === "amendment-chat-unheld" || e.type === "owner-message-consumed")).toHaveLength(0)
    const saved = JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json")).requests[request.id]
    expect(saved.chatAdmissionMessageID).toBeUndefined()
    expect(saved.ownerMessageID).toBeUndefined()
  } finally { await host.stop() }
}, 60000)

test("genuine Composer chat resolves while the exact native amendment form is pending, without replying to it", async () => {
  const { host, sessionID, request } = await setup("accept", false, true)
  try {
    const form: any = await until(async () => {
      const forms: any[] = await (host.client.session.form as any).list({ sessionID })
      return forms.find((f) => JSON.stringify(f).includes(request.id))
    }, 15000)
    const details: any = await (host.client.session.form as any).get({ sessionID, formID: form.id })
    expect(details.state.status).toBe("pending")
    await host.client.session.prompt({ sessionID, text: "I accept the amendment" } as any)
    await until(async () => (await run(host, "chat-amend")).lock === request.nextLock, 15000)
    expect((await ledger(host, "chat-amend")).filter((e) => e.type === "amended")).toHaveLength(1)
    const forms: any[] = await (host.client.session.form as any).list({ sessionID })
    expect(forms.some((f) => f.id === form.id)).toBe(false)
  } finally { await host.stop() }
}, 60000)

test("quoted/conditional prompts and unrelated native forms never unhold or accept the engine review", async () => {
  const { host, sessionID, before, request } = await setup("accept", false, true)
  try {
    const form: any = await until(async () => {
      const forms: any[] = await (host.client.session.form as any).list({ sessionID })
      return forms.find((f) => JSON.stringify(f).includes(request.id))
    }, 15000)
    for (const text of ['The agent said "accept the amendment"', "accept the amendment if tests pass"]) {
      await host.client.session.prompt({ sessionID, text } as any)
      expect((await (host.client.session.form as any).get({ sessionID, formID: form.id })).state.status).toBe("pending")
      expect((await run(host, "chat-amend")).lock).toBe(before.lock)
    }
    const unrelated: any = await (host.client.session.form as any).create({ sessionID, title: "Unrelated preference", fields: [{ key: "preference", type: "string", options: [{ label: "Keep preference", value: "keep" }] }] })
    await host.client.session.prompt({ sessionID, text: "I accept the amendment" } as any)
    expect((await (host.client.session.form as any).get({ sessionID, formID: unrelated.id })).state.status).toBe("pending")
    expect((await (host.client.session.form as any).get({ sessionID, formID: form.id })).state.status).toBe("pending")
    expect((await run(host, "chat-amend")).lock).toBe(before.lock)
    expect((await ledger(host, "chat-amend")).filter((e) => e.type === "amended" || e.type === "amendment-chat-unheld" || e.type === "owner-message-consumed")).toHaveLength(0)
  } finally { await host.stop() }
}, 60000)

test("actual Composer acceptance re-locks once, preserves unchanged proof and spends replay after reload", async () => {
  const { host, sessionID, before, request, repeat } = await setup()
  try {
    repeat()
    await host.client.session.prompt({ sessionID, text: "I accept the amendment" } as any)
    await until(async () => (await run(host, "chat-amend")).lock === request.nextLock, 15000)
    await host.client.session.wait({ sessionID } as any)
    const after = await run(host, "chat-amend")
    expect(after.runId).toBe(before.runId)
    expect(after.status).toBe("paused")
    expect(after.criteria.C1).toEqual({ status: "unknown", rejections: 0 })
    expect(after.criteria.C2).toEqual(before.criteria.C2)
    const events = await ledger(host, "chat-amend")
    expect(events.filter((e) => e.type === "amended")).toHaveLength(1)
    const consumed = events.find((e) => e.type === "owner-message-consumed")
    expect(consumed).toMatchObject({ decisionId: request.id, lock, nextLock: request.nextLock, action: "accept" })
    const context: any[] = await host.client.session.context({ sessionID } as any)
    expect(context.find((m) => m.id === consumed.ownerMessageID)).toMatchObject({ type: "user", text: "I accept the amendment" })
    await host.client.location.reload()
    await host.client.session.prompt({ sessionID, text: "I accept the amendment" } as any)
    await host.client.session.wait({ sessionID } as any)
    expect((await ledger(host, "chat-amend")).filter((e) => e.type === "amended")).toHaveLength(1)
    expect(await host.readProject("oracle.txt")).toBe("do not edit\n")
  } finally { await host.stop() }
}, 60000)

test("acceptance plus explicit continuation resumes only the accepted next generation once", async () => {
  const { host, sessionID, request } = await setup("accept", true)
  try {
    await host.client.session.prompt({ sessionID, text: "I accept the amendment get it done" } as any)
    await until(async () => (await ledger(host, "chat-amend")).some((e) => e.type === "amendment-chat-continuation"), 15000)
    const events = await ledger(host, "chat-amend")
    expect(events.filter((e) => e.type === "amended")).toHaveLength(1)
    expect(events.filter((e) => e.type === "amendment-chat-continuation")).toMatchObject([{ decisionId: request.id, lock: request.nextLock, ok: true }])
    expect(events.filter((e) => e.type === "resumed")).toHaveLength(1)
    expect((await run(host, "chat-amend")).lock).toBe(request.nextLock)
  } finally { await host.stop() }
}, 60000)

for (const hint of [false, null]) test(`actual owner continuation is authoritative with ${hint === false ? "a false" : "an omitted"} agent hint`, async () => {
  const { host, sessionID, request } = await setup("accept", hint)
  try {
    await host.client.session.prompt({ sessionID, text: "I accept the amendment get it done" } as any)
    await until(async () => (await ledger(host, "chat-amend")).some((e) => e.type === "amendment-chat-continuation"), 15000)
    const events = await ledger(host, "chat-amend")
    expect(events.filter((e) => e.type === "amendment-chat-continuation")).toMatchObject([{ decisionId: request.id, lock: request.nextLock, ok: true }])
    expect(events.filter((e) => e.type === "owner-message-consumed")).toMatchObject([{ action: "accept", continueGoal: true }])
    expect(events.filter((e) => e.type === "resumed")).toHaveLength(1)
    expect((await run(host, "chat-amend")).lock).toBe(request.nextLock)
  } finally { await host.stop() }
}, 60000)

test("an outstanding resume review cannot hide explicit amendment acceptance; generic approve remains ambiguous", async () => {
  const { host, sessionID, before, request } = await setup()
  try {
    await host.client.session.prompt({ sessionID, text: "Request a resume review" } as any)
    await until(async () => {
      const store = JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json"))
      return Object.values(store.requests).some((r: any) => r.kind === "owner-operation" && r.status === "pending" && r.extra.targetKey === `live:chat-amend:${before.runId}`)
    }, 15000)
    await host.client.session.prompt({ sessionID, text: "approve" } as any)
    await host.client.session.wait({ sessionID } as any)
    expect((await run(host, "chat-amend")).lock).toBe(lock)
    await host.client.session.prompt({ sessionID, text: "I approve the ammendment" } as any)
    await until(async () => (await run(host, "chat-amend")).lock === request.nextLock, 15000)
    expect((await run(host, "chat-amend")).status).toBe("paused")
    expect((await ledger(host, "chat-amend")).filter((e) => e.type === "amended")).toHaveLength(1)
    expect((await ledger(host, "chat-amend")).filter((e) => e.type === "resumed")).toHaveLength(0)
  } finally { await host.stop() }
}, 60000)

test("quoted/conditional/worker consent and unrequested continuation cannot authorize an amendment", async () => {
  const { host, sessionID, before, request } = await setup("accept", true)
  try {
    for (const text of ['The agent says "accept"', "accept if tests pass", "I accept the amendment"]) {
      await host.client.session.prompt({ sessionID, text } as any)
      await host.client.session.wait({ sessionID } as any)
      expect((await run(host, "chat-amend")).lock).toBe(before.lock)
    }
    const unrelated = await newSession(host)
    await host.client.session.prompt({ sessionID: unrelated, text: "I accept the amendment get it done" } as any)
    await host.client.session.wait({ sessionID: unrelated } as any)
    expect((await run(host, "chat-amend")).lock).toBe(before.lock)
    expect((await ledger(host, "chat-amend")).filter((e) => e.type === "amended" || e.type === "owner-message-consumed")).toHaveLength(0)
    expect(JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json")).requests[request.id].status).toBe("pending")
  } finally { await host.stop() }
}, 60000)

test("Composer rejection or revision feedback leaves the existing lock and evidence intact", async () => {
  for (const [action, text] of [["reject", "reject the amendment"], ["comment", "change the meaning again"]] as const) {
    const { host, sessionID, before, request } = await setup(action)
    try {
      await host.client.session.prompt({ sessionID, text } as any)
      await until(async () => (await ledger(host, "chat-amend")).some((e) => e.type === "amendment-feedback"), 15000)
      const after = await run(host, "chat-amend")
      expect(after.lock).toBe(before.lock)
      expect(after.criteria).toEqual(before.criteria)
      expect((await ledger(host, "chat-amend")).filter((e) => e.type === "amended")).toHaveLength(0)
      expect(JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json")).requests[request.id].status).toBe(action === "reject" ? "rejected" : "commented")
    } finally { await host.stop() }
  }
}, 60000)
