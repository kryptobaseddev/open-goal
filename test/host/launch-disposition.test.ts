import { expect, test } from "bun:test"
import { join } from "node:path"
import { GoalRpc } from "../../src/rpc"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

function launchHost(files: Record<string, string> = {}) {
  return goalHost(script((_req, turn) => {
    if (turn.results === 0 && turn.trigger.startsWith("PREPARE_LAUNCH"))
      return { toolCalls: [{ name: "goal_prepare_launch", args: { slug: "demo", fresh: false } }] }
    if (turn.results === 0 && turn.trigger.startsWith("RECOVER_LAUNCH")) {
      const id = turn.trigger.split(":")[1]
      return { toolCalls: [{ name: "goal_review", args: id ? { decisionId: id } : {} }] }
    }
    const line = turn.trigger.split("\n").find((l) => l.startsWith("GOAL_FORM_JSON:"))
    if (line && turn.results === 0)
      return { toolCalls: [{ name: "question", args: JSON.parse(line.slice("GOAL_FORM_JSON:".length)) }] }
    return { text: "The host owns launch admission; no goal_start call or inferred consent." }
  }), files)
}

async function launchRequest(host: Awaited<ReturnType<typeof launchHost>>, sessionID: string) {
  const data = JSON.parse(await host.readProject(".opencode/goals/.owner-launches.json"))
  return Object.values(data.requests).filter((p: any) => p.sessionID === sessionID).sort((a: any, b: any) => b.createdAt - a.createdAt)[0] as any
}
async function formFor(host: Awaited<ReturnType<typeof launchHost>>, sessionID: string, decisionId?: string) {
  return until(async () => {
    const forms: any[] = await (host.client.session.form as any).list({ sessionID })
    return forms.find((f) => (!decisionId || JSON.stringify(f).includes(decisionId)) && f.fields.some((field: any) => field.options?.some((o: any) => o.label === "Start goal now (Recommended)")))
  }, 10000)
}
async function prepare(host: Awaited<ReturnType<typeof launchHost>>, sessionID: string) {
  await host.client.session.prompt({ sessionID, text: "PREPARE_LAUNCH" } as any)
  return formFor(host, sessionID)
}
function answer(form: any) {
  const field = form.fields.find((f: any) => f.options?.some((o: any) => o.label === "Start goal now (Recommended)"))
  return { [field.key]: field.options.find((o: any) => o.label === "Start goal now (Recommended)").value }
}
async function feedback(host: Awaited<ReturnType<typeof launchHost>>, sessionID: string) {
  const context = await host.client.session.context({ sessionID } as any)
  const inbox = await (host.client.session as any).inbox.list({ sessionID })
  return JSON.stringify({ context, inbox })
}

test("expired exact native selection is durably visible, and launch review recovery requires new real consent", async () => {
  const host = await launchHost()
  const notices: any[] = []
  let off: (() => void) | undefined
  try {
    const sessionID = await newSession(host)
    const rpc: any = (host.client as any).rpc(GoalRpc)
    off = rpc.events.on("notice", (e: any) => notices.push(e.data))
    const form = await prepare(host, sessionID)
    const request = await launchRequest(host, sessionID)
    const path = join(host.project, ".opencode/goals/.owner-launches.json")
    const data = JSON.parse(await Bun.file(path).text())
    data.requests[request.id].expiresAt = Date.now() - 1
    await Bun.write(path, JSON.stringify(data)) // Isolated host clock fixture, never a worker ability.
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: answer(form) })
    await until(async () => (await ledger(host)).some((e) => e.type === "launch-expired" && e.decisionId === request.id), 10000)
    const expired = await launchRequest(host, sessionID)
    expect(expired).toMatchObject({ status: "expired", lock: request.lock, fresh: false, sessionID })
    expect(expired.result).toBe("Launch review expired. Prepare a fresh review; nothing started.")
    expect(await run(host).catch(() => undefined)).toBeUndefined()
    expect((await rpc.snapshot({ sessionID })).launches.find((p: any) => p.decisionId === request.id).status).toBe("expired")
    await until(() => notices.some((n) => n.sessionID === sessionID && n.text.includes("Launch review expired")))
    await until(async () => (await feedback(host, sessionID)).includes("Launch review expired"))

    const foreign = await newSession(host)
    await host.client.session.prompt({ sessionID: foreign, text: `RECOVER_LAUNCH:${request.id}` } as any)
    await until(() => host.fixture.requests.some((r) => r.messages.some((m) => m.role === "tool" && JSON.stringify(m.content).includes("another authoring session"))))
    expect((await launchRequest(host, sessionID)).id).toBe(request.id)

    // Without an ID, goal_review must find a launch/draft, not only lifecycle decisions.
    await host.client.session.prompt({ sessionID, text: "RECOVER_LAUNCH" } as any)
    const replacement = await until(async () => {
      const p = await launchRequest(host, sessionID)
      return p.id !== request.id ? p : undefined
    }, 10000)
    const freshForm = await formFor(host, sessionID, replacement.id)
    expect(replacement).toMatchObject({ lock: request.lock, sessionID, fresh: false, status: "pending" })
    expect(JSON.stringify(freshForm)).toContain(request.lock)
    expect((await rpc.review({ sessionID, decisionId: replacement.id })).message).toContain("already present in the native composer")
    expect(await run(host).catch(() => undefined)).toBeUndefined()
    expect((await ledger(host)).filter((e) => e.type === "start")).toHaveLength(0)
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: answer(form) }).catch(() => {})
    expect(await run(host).catch(() => undefined)).toBeUndefined()
    await (host.client.session.form as any).reply({ sessionID, formID: freshForm.id, answer: answer(freshForm) })
    await waitStatus(host, ["running"], 30000)
    expect((await ledger(host)).filter((e) => e.type === "start")).toHaveLength(1)
  } finally { off?.(); await host.stop() }
}, 60000)

test("slow approved rehearsal is visible before run creation and two bound approvals cannot duplicate admission", async () => {
  const command = "touch rehearsal-entered; while [ ! -f rehearsal-release ]; do sleep 0.1; done; touch rehearsal-finished"
  const host = await launchHost({ ".opencode/goals/demo/goal.yaml": DEMO_GOAL.replace("grep -q 'status: ok' done.txt", command) })
  try {
    const sessionID = await newSession(host), otherSession = await newSession(host)
    const form = await prepare(host, sessionID), otherForm = await prepare(host, otherSession)
    const request = await launchRequest(host, sessionID)
    const rpc: any = (host.client as any).rpc(GoalRpc)
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: answer(form) })
    await until(() => Bun.file(join(host.project, "rehearsal-entered")).exists(), 10000)
    const snapshot = await rpc.snapshot({ sessionID })
    expect(snapshot.view).toBeNull()
    expect(snapshot.launches.find((p: any) => p.decisionId === request.id)).toMatchObject({ status: "executing", activity: { phase: "check", checkId: "C2", completed: 0, total: 1 } })
    const row = (await rpc.list({})).goals.find((g: any) => g.slug === "demo")
    expect(row.status).toBe("draft")
    expect(row.runId).toBeUndefined()
    expect(row.launch.activity.detail).toContain("Rehearsing C2")
    expect((await rpc.details({ key: row.key })).goal.launch.decisionId).toBe(request.id)
    expect((await ledger(host)).filter((e) => e.type === "launch-reserved")).toHaveLength(1)
    await until(async () => (await feedback(host, sessionID)).includes("owner-approved admission starting"))
    await (host.client.session.form as any).reply({ sessionID: otherSession, formID: otherForm.id, answer: answer(otherForm) })
    const other = await until(async () => {
      const p = await launchRequest(host, otherSession)
      return p.status === "failed" ? p : undefined
    }, 10000)
    expect(other.result).toContain("another admission owns")
    expect((await ledger(host)).filter((e) => e.type === "launch-reservation-refused")).toHaveLength(1)
    expect(await run(host).catch(() => undefined)).toBeUndefined()
    await Bun.write(join(host.project, "rehearsal-release"), "release")
    const started = await waitStatus(host, ["running"], 30000)
    expect(started.sessionID).toBe(sessionID)
    expect((await ledger(host)).filter((e) => e.type === "start")).toHaveLength(1)
    expect((await ledger(host)).filter((e) => e.type === "launch-activity" && e.phase === "check")).toHaveLength(1)
    const settled = await until(async () => {
      const p = await launchRequest(host, sessionID)
      return p.status === "succeeded" ? p : undefined
    })
    expect(settled.activity).toBeUndefined()
    await host.client.location.reload()
    expect((await run(host)).runId).toBe(started.runId)
  } finally { await Bun.write(join(host.project, "rehearsal-release"), "cleanup"); await host.stop() }
}, 60000)

test("changed draft and failed rehearsal leave durable Composer dispositions instead of unexplained drafts", async () => {
  for (const scenario of ["changed", "unrunnable"] as const) {
    const host = await launchHost(scenario === "unrunnable" ? { ".opencode/goals/demo/goal.yaml": DEMO_GOAL.replace("grep -q 'status: ok' done.txt", "ocgoal_missing_rehearsal_command") } : {})
    try {
      const sessionID = await newSession(host)
      const form = await prepare(host, sessionID)
      const request = await launchRequest(host, sessionID)
      if (scenario === "changed") await Bun.write(join(host.project, ".opencode/goals/demo/goal.yaml"), DEMO_GOAL.replace("done.txt SHALL exist", "done.txt SHALL exist with different reviewed bytes"))
      await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: answer(form) })
      await until(async () => (await launchRequest(host, sessionID)).status === "failed", 10000)
      const events = await ledger(host)
      expect(events.some((e) => e.type === (scenario === "changed" ? "launch-changed" : "launch-failed") && e.decisionId === request.id && e.lock === request.lock)).toBe(true)
      expect(await run(host).catch(() => undefined)).toBeUndefined()
      await until(async () => (await feedback(host, sessionID)).includes(scenario === "changed" ? "draft changed since review" : "cannot run"))
    } finally { await host.stop() }
  }
}, 60000)

test("a contract edit or host reload during approved rehearsal cannot finish stale admission", async () => {
  const yaml = DEMO_GOAL.replace("grep -q 'status: ok' done.txt", "touch rehearsal-entered; while [ ! -f rehearsal-release ]; do sleep 0.1; done")
  for (const scenario of ["edit", "reload"] as const) {
    const host = await launchHost({ ".opencode/goals/demo/goal.yaml": yaml })
    try {
      const sessionID = await newSession(host)
      const form = await prepare(host, sessionID)
      const request = await launchRequest(host, sessionID)
      await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: answer(form) })
      await until(() => Bun.file(join(host.project, "rehearsal-entered")).exists(), 10000)
      if (scenario === "edit") await Bun.write(join(host.project, ".opencode/goals/demo/goal.yaml"), yaml.replace("done.txt SHALL exist", "done.txt SHALL exist after a new review"))
      else await host.client.location.reload()
      await Bun.write(join(host.project, "rehearsal-release"), "release")
      await until(async () => (await ledger(host)).some((e) => e.type === "launch-failed" && e.decisionId === request.id), 10000)
      const failed = await launchRequest(host, sessionID)
      expect(failed.status).toBe("failed")
      expect(failed.activity).toBeUndefined()
      expect(failed.result).toContain(scenario === "edit" ? "changed during launch rehearsal" : "interrupted by host reload")
      expect((await ledger(host)).filter((e) => e.type === "start")).toHaveLength(0)
      expect(await run(host).catch(() => undefined)).toBeUndefined()
    } finally { await Bun.write(join(host.project, "rehearsal-release"), "cleanup"); await host.stop() }
  }
}, 60000)
