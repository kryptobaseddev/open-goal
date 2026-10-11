import { expect, test } from "bun:test"
import { join } from "node:path"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

function launchingHost(fresh: boolean) {
  return goalHost(script((_req, turn) => {
    if (turn.trigger.includes("REQUEST_LAUNCH") && turn.results === 0)
      return { toolCalls: [{ name: "goal_prepare_launch", args: { slug: "demo", fresh } }] }
    // A host-staged native form may use the existing question tool fallback
    // when the installed plugin context has no direct form creation API.
    const line = turn.trigger.split("\n").find((l) => l.startsWith("GOAL_FORM_JSON:"))
    if (line && turn.results === 0)
      return { toolCalls: [{ name: "question", args: JSON.parse(line.slice("GOAL_FORM_JSON:".length)) }] }
    // This fixture NEVER calls goal_start after the answer. The host must
    // execute the chosen, bound launch despite a lost/interrupted tool reply.
    return { text: "Awaiting or executing the approved host launch." }
  }))
}

async function prepare(host: Awaited<ReturnType<typeof goalHost>>, sessionID: string) {
  await host.client.session.prompt({ sessionID, text: "REQUEST_LAUNCH the validated demo goal" } as any)
  return until(async () => {
    const forms: any[] = await (host.client.session.form as any).list({ sessionID })
    return forms.find((f) => f.fields.some((field: any) => field.options?.some((o: any) => o.label.startsWith("Start goal now"))))
  }, 8000)
}
function startAnswer(form: any) {
  const field = form.fields.find((f: any) => f.options?.some((o: any) => o.label.startsWith("Start goal now")))
  const option = field.options.find((o: any) => o.label.startsWith("Start goal now"))
  return { [field.key]: option.value }
}

test("native review/launch answer starts in this session even when no subsequent goal_start tool call arrives", async () => {
  const host = await launchingHost(false)
  try {
    const sessionID = await newSession(host)
    const form = await prepare(host, sessionID)
    expect(JSON.stringify(form)).toContain("Demo file says ok")
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: startAnswer(form) })
    const started = await waitStatus(host, ["running"], 30000)
    expect(started.sessionID).toBe(sessionID)
  } finally { await host.stop() }
}, 60000)

test("an unanswered launch decision survives reload and its fresh-session mode remains bound", async () => {
  const host = await launchingHost(true)
  try {
    const original = await newSession(host)
    const form = await prepare(host, original)
    const before = JSON.parse(await host.readProject(".opencode/goals/.owner-launches.json"))
    const request: any = Object.values(before.requests).find((p: any) => p.sessionID === original)
    await host.client.location.reload()
    // Core question-form IDs are ephemeral on reload. Require a real
    // re-presented form for the SAME persisted review nonce/hash/mode, not
    // a fabricated reply to a form the core no longer has.
    const restored: any = await until(async () => {
      const forms: any[] = await (host.client.session.form as any).list({ sessionID: original })
      return forms.find((f) => JSON.stringify(f).includes(request.id))
    }, 10000).catch(async (error) => {
      const data = JSON.parse(await host.readProject(".opencode/goals/.owner-launches.json"))
      console.error("LAUNCH-RECOVERY-DIAG", JSON.stringify(Object.values(data.requests).map((p: any) => ({ id: p.id, status: p.status, formID: p.formID, fieldKey: p.fieldKey, result: p.result }))))
      console.error("LAUNCH-REQUEST-DIAG", JSON.stringify(host.fixture.requests.filter((r) => r.tools?.length).map((r) => ({ trigger: JSON.stringify(r.messages.filter((m) => m.role === "user").at(-1)?.content).slice(0, 110), tools: r.messages.filter((m) => m.role === "tool").length }))))
      throw error
    })
    expect(JSON.stringify(restored)).toContain(request.lock)
    expect(JSON.stringify(restored)).toContain("original session and history are NOT cleared")
    await (host.client.session.form as any).reply({ sessionID: original, formID: restored.id, answer: startAnswer(restored) })
    const started = await waitStatus(host, ["running"], 30000)
    expect(started.sessionID).not.toBe(original)
  } finally { await host.stop() }
}, 60000)

test("unoffered custom commentary beginning with Start goal now is NOT launch consent", async () => {
  const host = await goalHost(script((_req, turn) => {
    if (turn.trigger.includes("TRY_START") && turn.results === 0)
      return { toolCalls: [{ name: "goal_start", args: { slug: "demo" } }] }
    return { text: "No approval is implied by commentary." }
  }))
  try {
    const sessionID = await newSession(host)
    const form = await (host.client.session.form as any).create({
      sessionID, title: "Comment, do not launch",
      fields: [{ key: "q0", type: "string", custom: true, options: [{ value: "Save for later", label: "Save for later" }] }],
    })
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: { q0: "Start goal now (Recommended) is wording to change; do not start" } })
    await host.client.session.prompt({ sessionID, text: "TRY_START without genuine approval" } as any)
    await until(() => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("TRY_START") && r.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("Launching a goal needs the owner's approval"))), 10000)
    expect(await run(host).catch(() => undefined)).toBeUndefined()
  } finally { await host.stop() }
}, 30000)

test("internal launch aliases written as custom commentary are not values offered by the native question", async () => {
  const host = await launchingHost(false)
  try {
    const sessionID = await newSession(host)
    const form = await prepare(host, sessionID)
    const field = form.fields.find((f: any) => f.options?.some((o: any) => o.label.startsWith("Start goal now")))
    expect(field.options.some((o: any) => o.value === "launch")).toBe(false)
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: { [field.key]: "launch" } })
    await until(async () => {
      const data = JSON.parse(await host.readProject(".opencode/goals/.owner-launches.json"))
      return Object.values(data.requests).some((p: any) => p.sessionID === sessionID && p.status === "commented")
    })
    expect(await run(host).catch(() => undefined)).toBeUndefined()
  } finally { await host.stop() }
}, 30000)

test("a launch choice cannot approve contract bytes changed after the displayed review", async () => {
  const host = await launchingHost(false)
  try {
    const sessionID = await newSession(host)
    const form = await prepare(host, sessionID)
    await Bun.write(join(host.project, ".opencode/goals/demo/goal.yaml"), DEMO_GOAL.replace("done.txt SHALL exist", "done.txt SHALL exist with a different reviewed statement"))
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: startAnswer(form) })
    const failed: any = await until(async () => {
      const data = JSON.parse(await host.readProject(".opencode/goals/.owner-launches.json"))
      return Object.values(data.requests).find((p: any) => p.sessionID === sessionID && p.status === "failed")
    }, 10000)
    expect(failed.result).toContain("draft changed since review")
    expect(await run(host).catch(() => undefined)).toBeUndefined()
  } finally { await host.stop() }
}, 30000)

test("expired reviews remain expired across reload and cannot mint a launch", async () => {
  const host = await launchingHost(false)
  try {
    const sessionID = await newSession(host)
    const form = await prepare(host, sessionID)
    // Test fixture controls time in the host-owned receipt; the worker
    // tools themselves never have a timestamp or consent-write parameter.
    const path = join(host.project, ".opencode/goals/.owner-launches.json")
    const data = JSON.parse(await Bun.file(path).text())
    const pending: any = Object.values(data.requests).find((p: any) => p.sessionID === sessionID)
    pending.expiresAt = Date.now() - 1
    await Bun.write(path, JSON.stringify(data))
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: startAnswer(form) })
    await until(async () => JSON.parse(await host.readProject(".opencode/goals/.owner-launches.json")).requests[pending.id]?.status === "expired", 10000)
    await host.client.location.reload()
    expect(await run(host).catch(() => undefined)).toBeUndefined()
  } finally { await host.stop() }
}, 30000)

test("completed launch consent is not executed again after replay or reload", async () => {
  const host = await launchingHost(true)
  try {
    const sessionID = await newSession(host)
    const form = await prepare(host, sessionID)
    const answer = startAnswer(form)
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer })
    const started = await waitStatus(host, ["running"], 30000)
    const request: any = await until(async () => {
      const data = JSON.parse(await host.readProject(".opencode/goals/.owner-launches.json"))
      return Object.values(data.requests).find((p: any) => p.sessionID === sessionID && p.status === "succeeded")
    })
    expect(request.fresh).toBe(true)
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer }).catch(() => {})
    await host.client.location.reload()
    const after = await run(host)
    expect(after.runId).toBe(started.runId)
    expect(after.sessionID).toBe(started.sessionID)
    expect((await ledger(host)).filter((e) => e.type === "start")).toHaveLength(1)
  } finally { await host.stop() }
}, 60000)
