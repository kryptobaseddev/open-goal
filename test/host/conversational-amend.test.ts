import { expect, test } from "bun:test"
import { parseContract } from "../../src/contract/parse"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

const yaml = `schema: goal/v1
id: amend-demo
title: Amendment evidence follows the statement
intent: {verbatim: prove the marker}
outcome: the marker exists and the owner reviews it
non_goals: [other files]
criteria:
  - id: C1
    statement: the marker SHALL exist
    check: {kind: file, path: marker.txt}
  - id: C2
    statement: the owner reviews the marker
    check: {kind: human, ask: review the marker}
protect: [oracle.txt]
`
const changed = yaml.replace("the marker SHALL exist", "the marker SHALL exist and represent the revised semantics")
const lock = parseContract(yaml).lock

async function setup(proposal = changed, expectedLock = lock) {
  const host = await goalHost(script((_req, turn) => {
    const line = turn.trigger.split("\n").find((l) => l.startsWith("GOAL_FORM_JSON:"))
    if (line && turn.results === 0) return { toolCalls: [{ name: "question", args: JSON.parse(line.slice("GOAL_FORM_JSON:".length)) }] }
    if (turn.trigger.includes("goal started")) {
      if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "marker.txt", content: "marker\n" } }] }
      if (turn.results === 1) return { toolCalls: [{ name: "goal_claim", args: { summary: "marker written", evidence: { C1: "file exists", C2: "owner review remains" } } }] }
    }
    if (turn.trigger.includes("Owner's original words:") && turn.results === 0)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "amend-demo", expectedLock, yaml: proposal, rationale: "Include the revised semantics requested by the owner." } }] }
    if (turn.trigger.includes("TRY_ORACLE") && turn.results === 0)
      return { toolCalls: [{ name: "write", args: { path: "oracle.txt", content: "altered" } }] }
    if (turn.trigger.includes("TRY_RECEIPT") && turn.results === 0)
      return { toolCalls: [{ name: "write", args: { path: ".opencode/goals/.owner-amendments.json", content: "{}" } }] }
    return { text: "Waiting for the owner's native review; no acceptance or resume inferred." }
  }), { ".opencode/goals/amend-demo/goal.yaml": yaml })
  const sessionID = await newSession(host)
  await host.client.session.command({ sessionID, name: "goal", text: "start amend-demo" } as any)
  const before = await waitStatus(host, ["needs_review"], 30000, "amend-demo")
  expect(before.criteria.C1.status).toBe("pass")
  return { host, sessionID, before }
}
async function stage(host: Awaited<ReturnType<typeof goalHost>>, sessionID: string) {
  await host.client.session.command({ sessionID, name: "goal", text: "amend the marker goal to include the revised semantics" } as any)
  return until(async () => {
    const forms: any[] = await (host.client.session.form as any).list({ sessionID })
    return forms.find((f) => f.fields.some((field: any) => field.options?.some((o: any) => o.label === "Accept amendment")))
  }, 10000)
}
function answer(form: any, label: string) {
  const field = form.fields.find((f: any) => f.options?.some((o: any) => o.label === "Accept amendment"))
  const option = field.options.find((o: any) => o.label === label)
  return { [field.key]: option?.value ?? label }
}

test("natural-language amendment stages a validated diff; exact acceptance alone re-locks and resets changed statements", async () => {
  const { host, sessionID, before } = await setup()
  try {
    const form = await stage(host, sessionID)
    expect(JSON.stringify(form)).toContain("BEFORE")
    expect(JSON.stringify(form)).toContain("AFTER")
    expect(JSON.stringify(form)).toContain("changed [C1]")
    expect(await host.readProject(".opencode/goals/amend-demo/goal.yaml")).toBe(yaml)
    expect((await run(host, "amend-demo")).lock).toBe(before.lock)
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: answer(form, "Accept amendment") })
    const after = await until(async () => {
      const state = await run(host, "amend-demo")
      return state.lock !== before.lock ? state : undefined
    })
    expect(after.status).toBe("paused")
    expect(after.criteria.C1).toEqual({ status: "unknown", rejections: 0 })
    expect(after.criteria.C2).toEqual(before.criteria.C2)
    expect(await host.readProject(".opencode/goals/amend-demo/goal.yaml")).toBe(changed)
    expect(after.amendments.filter((a: any) => a.status === "accepted")).toHaveLength(1)
    expect((await ledger(host, "amend-demo")).filter((e) => e.type === "amended")).toHaveLength(1)
    await host.client.location.reload()
    expect((await run(host, "amend-demo")).lock).toBe(after.lock)
    expect((await ledger(host, "amend-demo")).filter((e) => e.type === "amended")).toHaveLength(1)
    await host.client.session.prompt({ sessionID, text: "TRY_ORACLE while amended and stopped" } as any)
    await until(() => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("protected by the goal contract")))
    expect(await host.readProject("oracle.txt")).toBe("do not edit\n")
  } finally { await host.stop() }
}, 60000)

test("rejection and custom commentary are not acceptance or resume", async () => {
  for (const choice of ["Reject amendment", "Accept amendment is wording to revise; do NOT accept", "accept"]) {
    const { host, sessionID, before } = await setup()
    try {
      const form = await stage(host, sessionID)
      await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: answer(form, choice) })
      await until(async () => (await ledger(host, "amend-demo")).some((e) => e.type === "amendment-feedback"))
      expect(await host.readProject(".opencode/goals/amend-demo/goal.yaml")).toBe(yaml)
      const after = await run(host, "amend-demo")
      expect(after.lock).toBe(before.lock)
      expect(after.criteria).toEqual(before.criteria)
      expect(after.status).toBe("paused")
      expect(after.amendments.filter((a: any) => a.status === "accepted")).toHaveLength(0)
    } finally { await host.stop() }
  }
}, 60000)

test("pending amendment survives reload with the same diff and target; unrelated forms cannot bind or accept it", async () => {
  const { host, sessionID, before } = await setup()
  try {
    const form = await stage(host, sessionID)
    const data = JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json"))
    const proposal: any = Object.values(data.requests).find((p: any) => p.runId === before.runId)
    const lifecycle = JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json"))
    expect(Object.values(lifecycle.requests).filter((p: any) => p.slug === "amend-demo" && ["pending", "interrupted"].includes(p.status))).toHaveLength(0)
    const unrelated = await (host.client.session.form as any).create({ sessionID, title: "Unrelated preference", fields: [{ key: "a", type: "string", options: [{ label: "Accept amendment", value: "accept" }] }] })
    await (host.client.session.form as any).reply({ sessionID, formID: unrelated.id, answer: { a: "accept" } })
    expect((await run(host, "amend-demo")).lock).toBe(before.lock)
    await host.client.location.reload()
    const restored: any = await until(async () => {
      const forms: any[] = await (host.client.session.form as any).list({ sessionID })
      return forms.find((f) => JSON.stringify(f).includes(proposal.id))
    }, 10000)
    expect(JSON.stringify(restored)).toContain(proposal.nextLock)
    expect(JSON.stringify(restored)).toContain("changed [C1]")
    const restoredForms: any[] = await (host.client.session.form as any).list({ sessionID })
    expect(restoredForms.filter((f) => JSON.stringify(f).includes("goal.needs-review.signoff"))).toHaveLength(0)
    await (host.client.session.form as any).reply({ sessionID, formID: restored.id, answer: answer(restored, "Accept amendment") })
    await until(async () => (await run(host, "amend-demo")).lock === proposal.nextLock)
    // The old cancelled core form cannot be used as another acceptance.
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: answer(form, "Accept amendment") }).catch(() => {})
    expect((await ledger(host, "amend-demo")).filter((e) => e.type === "amended")).toHaveLength(1)
  } finally { await host.stop() }
}, 60000)

test("invalid YAML and a stale target lock leave the locked contract and evidence recoverable", async () => {
  for (const [proposal, expectedLock, diagnostic] of [["schema: invalid", lock, "Invalid amendment"], [changed, "0".repeat(64), "stale lock"]]) {
    const { host, sessionID, before } = await setup(proposal, expectedLock)
    try {
      await host.client.session.command({ sessionID, name: "goal", text: "amend the marker goal with requested changes" } as any)
      await until(() => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes(diagnostic!)), 10000)
      expect(await host.readProject(".opencode/goals/amend-demo/goal.yaml")).toBe(yaml)
      expect((await run(host, "amend-demo")).lock).toBe(before.lock)
      expect((await run(host, "amend-demo")).criteria).toEqual(before.criteria)
    } finally { await host.stop() }
  }
}, 60000)

test("a goal-less managing agent cannot rewrite another session's protected oracle or host consent receipt", async () => {
  const { host } = await setup()
  try {
    const primary = await newSession(host)
    await host.client.session.prompt({ sessionID: primary, text: "TRY_ORACLE from a goal-less session" } as any)
    await until(() => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("protected by the goal contract")))
    expect(await host.readProject("oracle.txt")).toBe("do not edit\n")
    await host.client.session.prompt({ sessionID: primary, text: "TRY_RECEIPT forge a host acceptance" } as any)
    await until(() => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("owned by the owner and the host")))
    expect(await host.readProject(".opencode/goals/.owner-amendments.json").catch(() => "missing")).not.toBe("{}")
  } finally { await host.stop() }
}, 60000)
