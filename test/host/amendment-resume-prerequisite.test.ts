import { expect, test } from "bun:test"
import { join } from "node:path"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

test("an unresolved amendment blocks resume before another impossible owner question is offered", async () => {
  let target: Record<string, string> = {}, lock = ""
  let heldResumedRun = false
  const host = await goalHost(script((_request, turn) => {
    if (turn.all.includes("owner resumed the goal") && !heldResumedRun) {
      heldResumedRun = true
      return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "inspect actual resumed generation" } }] }
    }
    const form = turn.trigger.split("\n").find((line) => line.startsWith("GOAL_FORM_JSON:") || line.startsWith("GOAL_DECISION_JSON:"))
    if (form && !turn.results) return { toolCalls: [{ name: "question", args: JSON.parse(form.slice(form.indexOf(":") + 1)) }] }
    if (turn.trigger === "STAGE" && !turn.results)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "demo", expectedLock: lock, yaml: DEMO_GOAL.replace("Demo file says ok", "Reviewed title"), rationale: "fresh exact owner review" } }] }
    if (turn.trigger === "RESUME_THIS" && !turn.results)
      return { toolCalls: [{ name: "goal_manage", args: { action: "resume", target } }] }
    if (turn.trigger === "STAGE" || turn.trigger === "RESUME_THIS") return { text: "No permission was inferred." }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "inspect amendment prerequisite" } }] }
    return { text: "Holding." }
  }), {}, { extraPlugins: [join(import.meta.dir, "../fixtures/lab-tool-boundary")] })
  try {
    const owner = await newSession(host), actor = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    const initial = await waitStatus(host, ["waiting"], 15000)
    lock = initial.lock
    target = { key: `live:demo:${initial.runId}`, runId: initial.runId, sessionID: owner, lock }
    await host.client.session.prompt({ sessionID: owner, text: "STAGE" } as never)
    const originalForm = await until(async () => (await host.client.session.form.list({ sessionID: owner }))[0], 10000)
    const original = Object.values((await Bun.file(join(host.project, ".opencode/goals/.owner-amendments.json")).json()).requests)[0] as { id: string }
    for (let i = 0; i < 3; i++) {
      await host.client.session.prompt({ sessionID: actor, text: "RESUME_THIS" } as never)
      const output = await until(async () => {
        const rows = (await host.readProject("tool-boundary.jsonl")).trim().split("\n").map((line) => JSON.parse(line))
        const results = rows.filter((row) => row.phase === "after" && row.tool === "goal_manage")
        return results.length === i + 1 ? results.at(-1).result.metadata : undefined
      }, 10000)
      expect(output).toMatchObject({ ok: false, actionExecuted: false, requiredReview: { id: original.id, sessionID: owner, kind: "amendment" } })
    }
    expect((await ledger(host)).filter((event) => event.type === "decision" && event.kind === "owner-operation")).toHaveLength(0)
    expect(await host.client.session.form.list({ sessionID: actor })).toHaveLength(0)
    expect((await run(host)).lock).toBe(lock)
    expect((await host.client.session.form.get({ sessionID: owner, formID: originalForm.id })).state.status).toBe("pending")
    // The old author is held by its unanswered review, not an active goal
    // worker. A live actor may offer the same diff for NEW owner consent.
    await host.client.session.prompt({ sessionID: actor, text: "STAGE" } as never)
    const replacementForm = await until(async () => (await host.client.session.form.list({ sessionID: actor }))[0], 10000)
    const path = join(host.project, ".opencode/goals/.owner-amendments.json")
    const beforeAcceptance = await Bun.file(path).json()
    expect(beforeAcceptance.requests[original.id].status).toBe("pending")
    const replacement = Object.values(beforeAcceptance.requests).find((p) => (p as { sessionID: string }).sessionID === actor) as { id: string; nextLock: string }
    expect(replacement.id).not.toBe(original.id)
    const field = replacementForm.fields[0]!
    if (field.type !== "string") throw new Error("Expected exact amendment choice")
    const choice = field.options!.find((option) => option.label === "Accept amendment")!
    await host.client.session.form.reply({ sessionID: actor, formID: replacementForm.id, answer: { [field.key]: choice.value } })
    await until(async () => (await run(host)).lock === replacement.nextLock, 10000)
    expect((await Bun.file(path).json()).requests[original.id].status).toBe("cancelled")
    expect((await ledger(host)).filter((event) => event.type === "amended")).toHaveLength(1)
    expect((await ledger(host)).filter((event) => event.type === "resumed")).toHaveLength(0)
    target = { ...target, lock: replacement.nextLock }
    await host.client.session.prompt({ sessionID: actor, text: "RESUME_THIS" } as never)
    const resumeForm = await until(async () => (await host.client.session.form.list({ sessionID: actor })).find((form) => JSON.stringify(form).includes("Resume selected goal")), 10000)
    const resumeField = resumeForm.fields[0]!
    if (resumeField.type !== "string") throw new Error("Expected exact resume choice")
    const resumeChoice = resumeField.options!.find((option) => option.label === "Resume selected goal")!
    await host.client.session.form.reply({ sessionID: actor, formID: resumeForm.id, answer: { [resumeField.key]: resumeChoice.value } })
    await waitStatus(host, ["waiting"], 10000)
    expect((await ledger(host)).filter((event) => event.type === "resumed")).toHaveLength(1)
    const events = await ledger(host), resumed = events.find((event) => event.type === "resumed")!
    expect(events.some((event) => event.type === "admit" && event.t >= resumed.t)).toBe(true)
    expect((await run(host)).runId).toBe(initial.runId)
  } catch (error) {
    await Bun.write(join(import.meta.dir, "../../.tmp/verification/t105-prerequisite-failure.json"), JSON.stringify({
      error: String(error), run: await run(host), ledger: await ledger(host),
      decisions: await host.readProject(".opencode/goals/.owner-decisions.json").catch(() => null),
      amendments: await host.readProject(".opencode/goals/.owner-amendments.json"),
      boundary: await host.readProject("tool-boundary.jsonl"), modelRequests: host.fixture.requests,
    }, null, 2))
    throw error
  } finally { await host.stop() }
}, 45000)

test("an owned dismissed prerequisite can restore its exact diff, but restoration never accepts or resumes", async () => {
  let target: Record<string, string> = {}, lock = ""
  const host = await goalHost(script((_request, turn) => {
    const form = turn.trigger.split("\n").find((line) => line.startsWith("GOAL_FORM_JSON:") || line.startsWith("GOAL_DECISION_JSON:"))
    if (form && !turn.results) return { toolCalls: [{ name: "question", args: JSON.parse(form.slice(form.indexOf(":") + 1)) }] }
    if (turn.trigger === "STAGE" && !turn.results)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "demo", expectedLock: lock, yaml: DEMO_GOAL.replace("Demo file says ok", "Reviewed title"), rationale: "restore exact prerequisite" } }] }
    if (turn.trigger === "RESUME_THIS" && !turn.results) return { toolCalls: [{ name: "goal_manage", args: { action: "resume", target } }] }
    if (turn.trigger === "STAGE" || turn.trigger === "RESUME_THIS") return { text: "No implicit acceptance." }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "inspect prerequisite restoration" } }] }
    return { text: "Holding." }
  }))
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    const initial = await waitStatus(host, ["waiting"], 15000)
    lock = initial.lock; target = { key: `live:demo:${initial.runId}`, runId: initial.runId, sessionID: owner, lock }
    await host.client.session.prompt({ sessionID: owner, text: "STAGE" } as never)
    const originalForm = await until(async () => (await host.client.session.form.list({ sessionID: owner }))[0], 10000)
    const path = join(host.project, ".opencode/goals/.owner-amendments.json")
    const original = Object.values((await Bun.file(path).json()).requests)[0] as { id: string }
    await host.client.session.form.cancel({ sessionID: owner, formID: originalForm.id })
    await host.client.session.wait({ sessionID: owner })
    await host.client.session.prompt({ sessionID: owner, text: "RESUME_THIS" } as never)
    const prerequisite = await until(async () => (await host.client.session.form.list({ sessionID: owner })).find((form) => JSON.stringify(form).includes("Review pending amendment")), 10000)
    const field = prerequisite.fields[0]!
    if (field.type !== "string") throw new Error("Expected prerequisite restoration choice")
    const choice = field.options!.find((option) => option.label === "Review pending amendment")!
    expect(field.options!.some((option) => option.label === "Resume selected goal")).toBe(false)
    await host.client.session.form.reply({ sessionID: owner, formID: prerequisite.id, answer: { [field.key]: choice.value } })
    await until(async () => (await host.client.session.form.list({ sessionID: owner })).some((form) => JSON.stringify(form).includes(original.id)), 10000)
    expect((await run(host)).lock).toBe(lock)
    expect((await run(host)).status).toBe("paused")
    expect((await ledger(host)).filter((event) => event.type === "amended" || event.type === "resumed")).toHaveLength(0)
  } finally { await host.stop() }
}, 45000)
