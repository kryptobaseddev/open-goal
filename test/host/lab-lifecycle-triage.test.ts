import { expect, test } from "bun:test"
import { join } from "node:path"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, text, waitStatus } from "./goal.helpers"
import { until } from "./harness"
import { GoalRpc } from "../../src/rpc"

const observer = join(import.meta.dir, "../fixtures/lab-tool-boundary")
const slugs = ["release-lane-completion", "lab-panel-click-review-release", "mq-r1-approvals"]
const contracts = Object.fromEntries(slugs.map((slug) => [`.opencode/goals/${slug}/goal.yaml`, DEMO_GOAL.replace("id: demo", `id: ${slug}`)]))
type Trace = { phase: string; tool: string; id?: string; input: { slug?: string }; status?: string; error?: unknown; result?: unknown }
async function traces(host: Awaited<ReturnType<typeof goalHost>>) {
  return (await host.readProject("tool-boundary.jsonl")).trim().split("\n").map((line) => JSON.parse(line) as Trace)
}

test("lab triage: three already-live parallel refusals each name their own slug, matching sequential refusals", async () => {
  const order = [slugs[2]!, slugs[0]!, slugs[1]!]
  const host = await goalHost(script((_request, turn) => {
    if (turn.trigger === "PARALLEL_ALL_LIVE" && !turn.results)
      return { toolCalls: order.map((slug) => ({ name: "goal_prepare_launch", args: { slug } })) }
    if (turn.trigger.startsWith("SEQUENTIAL_SLUG:") && !turn.results)
      return { toolCalls: [{ name: "goal_prepare_launch", args: { slug: turn.trigger.slice("SEQUENTIAL_SLUG:".length) } }] }
    if (turn.trigger === "PARALLEL_ALL_LIVE" || turn.trigger.startsWith("SEQUENTIAL_SLUG:")) return { text: "Refused, not retried." }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold live triage goal" } }] }
    return { text: "No consent supplied." }
  }), contracts, { plugin: process.env.OCGOAL_GIT_SPEC, extraPlugins: [observer] })
  try {
    for (const slug of order) {
      const owner = await newSession(host)
      await host.client.session.command({ sessionID: owner, name: "goal", text: `start ${slug}` } as never)
      await waitStatus(host, ["waiting"], 15000, slug)
    }
    const actor = await newSession(host)
    await host.client.session.prompt({ sessionID: actor, text: "PARALLEL_ALL_LIVE" } as never)
    await host.client.session.wait({ sessionID: actor })
    for (const slug of order) {
      await host.client.session.prompt({ sessionID: actor, text: `SEQUENTIAL_SLUG:${slug}` } as never)
      await host.client.session.wait({ sessionID: actor })
    }
    const entries = await traces(host)
    for (const phase of ["before", "plugin-entry", "after"])
      expect(entries.filter((row) => row.phase === phase).map((row) => row.input.slug).sort()).toEqual([...order, ...order].sort())
    const visible = host.fixture.requests.at(-1)!.messages.filter((message) => message.role === "tool")
    for (const entry of entries.filter((row) => row.phase === "after")) {
      expect(entry.status).toBe("error")
      expect(JSON.stringify(entry.error)).toContain(`Goal ${entry.input.slug} is already live`)
      expect(text(visible.find((message) => message.tool_call_id === entry.id))).toContain(`Goal ${entry.input.slug} is already live`)
    }
    for (const slug of order) expect((await ledger(host, slug)).filter((e) => e.type === "start")).toHaveLength(1)
  } finally {
    if (process.env.OCGOAL_TRIAGE_EVIDENCE) await Bun.write(join(process.env.OCGOAL_TRIAGE_EVIDENCE, "parallel-all-live.json"), JSON.stringify({
      project: host.project, provenance: await host.client.rpc(GoalRpc).provenance({}), entries: await traces(host).catch(() => []),
      inventory: await host.client.rpc(GoalRpc).list({}), modelRequests: host.fixture.requests,
    }, null, 2))
    await host.stop()
  }
}, 45000)

test("lab triage: parallel launch slugs survive model calls, host hooks and plugin entry independently", async () => {
  const host = await goalHost(script((_request, turn) => {
    if (turn.trigger === "PARALLEL_LAUNCH" && !turn.results)
      return { toolCalls: slugs.map((slug) => ({ name: "goal_prepare_launch", args: { slug, fresh: true } })) }
    if (turn.trigger.includes("GOAL_FORM_JSON:")) return { text: "No owner choice; preparation only." }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold exact fixture run" } }] }
    return { text: "No consent supplied." }
  }), contracts, { plugin: process.env.OCGOAL_GIT_SPEC, extraPlugins: [observer] })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start mq-r1-approvals" } as never)
    const original = await waitStatus(host, ["waiting"], 15000, "mq-r1-approvals")
    const actor = await newSession(host)
    await host.client.session.prompt({ sessionID: actor, text: "PARALLEL_LAUNCH" } as never)
    const entries = await until(async () => {
      const rows = await traces(host).catch(() => [])
      return rows.filter((row) => row.phase === "after").length === 3 ? rows : undefined
    }, 15000)
    for (const phase of ["before", "plugin-entry", "after"])
      expect(entries.filter((row) => row.phase === phase).map((row) => row.input.slug).sort()).toEqual([...slugs].sort())
    expect(new Set(entries.filter((row) => row.phase === "before").map((row) => row.id)).size).toBe(3)
    const live = entries.find((row) => row.phase === "after" && row.input.slug === "mq-r1-approvals")!
    expect(live.status).toBe("error")
    expect(JSON.stringify(live.error)).toContain("Goal mq-r1-approvals is already live")
    const store = JSON.parse(await host.readProject(".opencode/goals/.owner-launches.json"))
    expect(Object.values(store.requests).map((request) => (request as { slug: string }).slug).sort()).toEqual(slugs.slice(0, 2).sort())
    expect((await run(host, "mq-r1-approvals")).runId).toBe(original.runId)
    for (const slug of slugs.slice(0, 2)) expect(await run(host, slug).catch(() => undefined)).toBeUndefined()
  } finally {
    if (process.env.OCGOAL_TRIAGE_EVIDENCE) await Bun.write(join(process.env.OCGOAL_TRIAGE_EVIDENCE, "parallel-launch.json"), JSON.stringify({
      project: host.project, binary: process.env.OPENCODE_BINARY ?? "default",
      provenance: await host.client.rpc(GoalRpc).provenance({}), entries: await traces(host).catch(() => []),
      contracts: Object.fromEntries(slugs.map((slug) => [slug, Bun.YAML.parse(contracts[`.opencode/goals/${slug}/goal.yaml`]!)])),
      requests: await host.readProject(".opencode/goals/.owner-launches.json").catch(() => null),
      original: await run(host, "mq-r1-approvals").catch(() => null), modelRequests: host.fixture.requests,
    }, null, 2))
    await host.stop()
  }
}, 45000)

test("lab triage: form-applied amendment is never replayed by a subsequent resolve", async () => {
  let lock = "", decisionId = ""
  const host = await goalHost(script((_request, turn) => {
    const form = turn.trigger.split("\n").find((line) => line.startsWith("GOAL_FORM_JSON:"))
    if (form && !turn.results) return { toolCalls: [{ name: "question", args: JSON.parse(form.slice("GOAL_FORM_JSON:".length)) }] }
    if (turn.trigger === "PROPOSE_EXACT" && !turn.results)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "demo", expectedLock: lock,
        yaml: DEMO_GOAL.replace("Demo file says ok", "Demo file has reviewed title"), rationale: "isolated owner title review" } }] }
    if (turn.trigger === "INSPECT_COMPLETED" && !turn.results)
      return { toolCalls: [{ name: "goal_resolve_amendment", args: { decisionId, action: "accept" } }] }
    if (turn.trigger === "PROPOSE_EXACT" || turn.trigger === "INSPECT_COMPLETED") return { text: "No new consent supplied." }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold amendment target" } }] }
    return { text: "No consent supplied." }
  }), {}, { plugin: process.env.OCGOAL_GIT_SPEC, extraPlugins: [observer] })
  let evidence: Record<string, unknown> = {}
  try {
    const owner = await newSession(host), actor = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    const initial = await waitStatus(host, ["waiting"], 15000)
    lock = initial.lock
    await host.client.session.command({ sessionID: owner, name: "goal", text: "pause" } as never)
    await waitStatus(host, ["paused"], 10000)
    await host.client.session.prompt({ sessionID: actor, text: "PROPOSE_EXACT" } as never)
    const proposal = await until(async () => {
      const store = JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json").catch(() => '{"requests":{}}'))
      return Object.values(store.requests).find((p) => (p as { status: string }).status === "pending") as { id: string; nextLock: string } | undefined
    }, 15000)
    decisionId = proposal.id
    const form = await until(async () => (await host.client.session.form.list({ sessionID: actor })).find((f) => JSON.stringify(f).includes(decisionId)), 10000)
    const field = form.fields[0]!
    if (field.type !== "string") throw new Error("Expected the real amendment choice field")
    const choice = field.options!.find((o) => o.label.startsWith("Accept"))!
    await host.client.session.form.reply({ sessionID: actor, formID: form.id, answer: { [field.key]: choice.value } })
    await until(async () => (await run(host)).lock === proposal.nextLock, 15000)
    await host.client.session.wait({ sessionID: actor })
    const before = await run(host), beforeEvents = await ledger(host)
    await host.client.session.prompt({ sessionID: actor, text: "INSPECT_COMPLETED" } as never)
    const result = await until(async () => (await traces(host)).findLast((e) => e.phase === "after" && e.tool === "goal_resolve_amendment"), 10000)
    expect(result.input).toMatchObject({ decisionId, action: "accept" })
    if (process.env.OCGOAL_REPORTING_ORACLE === "1") {
      expect(result.status).toBe("completed")
      expect(result.result).toMatchObject({ metadata: { ok: false, actionExecuted: false, alreadyResolved: true, decisionId, status: "succeeded" } })
    }
    const rpc = host.client.rpc(GoalRpc)
    const review = await rpc.review({ sessionID: actor, decisionId })
    expect(review).toMatchObject({ ok: false, message: "Amendment review is succeeded; old approval cannot be replayed." })
    const after = await run(host), afterEvents = await ledger(host)
    expect(after.runId).toBe(initial.runId)
    expect(after.lock).toBe(proposal.nextLock)
    expect(after.status).toBe("paused")
    expect(after.criteria).toEqual(before.criteria)
    expect(afterEvents.filter((e) => e.type === "amended")).toHaveLength(1)
    expect(afterEvents.filter((e) => e.type === "amended" || e.type === "resumed" || e.type === "owner-message-consumed"))
      .toEqual(beforeEvents.filter((e) => e.type === "amended" || e.type === "resumed" || e.type === "owner-message-consumed"))
    evidence = { initial, proposal, form, result, review, before, after, beforeEvents, afterEvents,
      inventory: await rpc.list({}), receipt: JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json")).requests[decisionId] }
  } finally {
    if (process.env.OCGOAL_TRIAGE_EVIDENCE) await Bun.write(join(process.env.OCGOAL_TRIAGE_EVIDENCE, "applied-amendment.json"), JSON.stringify({
      project: host.project, provenance: await host.client.rpc(GoalRpc).provenance({}), evidence,
      entries: await traces(host).catch(() => []), modelRequests: host.fixture.requests,
    }, null, 2))
    await host.stop()
  }
}, 45000)

test("lab triage: omitted identity is refused; a genuine resume resolves once and later review cannot replay it", async () => {
  let target: Record<string, string> = {}
  const asked = new Set<string>()
  const host = await goalHost(script((request, turn) => {
    const lines = request.messages.map(text).join("\n").split("\n")
    const payload = lines.findLast((line) => line.startsWith("GOAL_DECISION_JSON:"))
    const presentation = lines.findLast((line) => line.startsWith("GOAL_DECISION_ASK:"))
    if (payload && !asked.has(presentation ?? payload)) {
      asked.add(presentation ?? payload)
      return { toolCalls: [{ name: "question", args: JSON.parse(payload.slice("GOAL_DECISION_JSON:".length)) }] }
    }
    if (turn.trigger === "MANAGE_EXACT" && !turn.results)
      return { toolCalls: [{ name: "goal_manage", args: { action: "resume", target } }] }
    if (turn.trigger === "MANAGE_EXACT") return { text: "No consent supplied." }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold triage target" } }] }
    return { text: "No consent supplied." }
  }), {}, { plugin: process.env.OCGOAL_GIT_SPEC, extraPlugins: [observer] })
  let evidence: Record<string, unknown> = {}
  try {
    const owner = await newSession(host), actor = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    const initial = await waitStatus(host, ["waiting"], 15000)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "pause" } as never)
    await waitStatus(host, ["paused"], 10000)
    const rpc = host.client.rpc(GoalRpc)
    const identity = { key: `live:demo:${initial.runId}`, runId: initial.runId, lock: initial.lock }
    const inventory = await rpc.list({})
    const missingSession = await rpc.manage({ sessionID: actor, action: "resume", target: identity })
    const missingRun = await rpc.manage({ sessionID: actor, action: "resume", target: { key: identity.key, lock: identity.lock } })
    expect(missingSession).toMatchObject({ ok: false })
    expect(missingRun).toMatchObject({ ok: false })
    if (process.env.OCGOAL_REPORTING_ORACLE === "1") {
      expect(JSON.stringify(missingSession)).toContain("Missing target identity")
      expect(JSON.stringify(missingSession)).toContain("sessionID")
      expect(JSON.stringify(missingRun)).toContain("runId")
      expect(JSON.stringify(missingRun)).toContain("sessionID")
    }
    const changedIdentity = await rpc.manage({ sessionID: actor, action: "resume", target: { ...identity, sessionID: owner, lock: "0".repeat(64) } })
    expect(changedIdentity).toMatchObject({ ok: false })
    expect((await run(host)).status).toBe("paused")
    target = { ...identity, sessionID: owner }
    await host.client.session.prompt({ sessionID: actor, text: "MANAGE_EXACT" } as never)
    const decision = await until(async () => (await ledger(host)).findLast((e) => e.type === "decision" && e.kind === "owner-operation"), 10000)
    const form = await until(async () => (await host.client.session.form.list({ sessionID: actor })).find((f) => JSON.stringify(f).includes(decision.decisionId)), 10000)
    const field = form.fields[0]!
    if (field.type !== "string") throw new Error("Expected the real lifecycle choice field")
    const choice = field.options!.find((o) => o.label === "Resume selected goal")!
    await host.client.session.form.reply({ sessionID: actor, formID: form.id, answer: { [field.key]: choice.value } })
    await waitStatus(host, ["waiting"], 15000)
    await until(async () => (await ledger(host)).some((e) => e.type === "decision-resolved" && e.decision === decision.decisionId && e.ok === true), 10000)
    const review = await rpc.review({ sessionID: actor, decisionId: decision.decisionId })
    expect(review).toMatchObject({ ok: false, actionExecuted: false })
    if (process.env.OCGOAL_REPORTING_ORACLE === "1") {
      expect(JSON.stringify(review)).toContain("succeeded")
      expect(JSON.stringify(review)).toContain("replayed")
      expect(JSON.stringify(review)).not.toContain("target changed")
    }
    const after = await run(host), events = await ledger(host)
    expect(after.lock).toBe(initial.lock)
    expect(after.runId).toBe(initial.runId)
    expect(events.filter((e) => e.type === "resumed")).toHaveLength(1)
    const foreign = await rpc.review({ sessionID: owner, decisionId: decision.decisionId })
    expect(foreign).toMatchObject({ ok: false, actionExecuted: false })
    evidence = { inventory, identity, missingSession, missingRun, changedIdentity, exactTarget: target, decision, form, review, foreign, after, events,
      receipt: JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json")).requests[decision.decisionId] }
  } finally {
    if (process.env.OCGOAL_TRIAGE_EVIDENCE) await Bun.write(join(process.env.OCGOAL_TRIAGE_EVIDENCE, "identity-and-review.json"), JSON.stringify({
      project: host.project, provenance: await host.client.rpc(GoalRpc).provenance({}), evidence,
      entries: await traces(host).catch(() => []), modelRequests: host.fixture.requests,
    }, null, 2))
    await host.stop()
  }
}, 45000)
