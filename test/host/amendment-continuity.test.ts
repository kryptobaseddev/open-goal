import { expect, test } from "bun:test"
import { parseContract } from "../../src/contract/parse"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// v0.8.0 C2 — an accepted amendment resumes the run in the same act, and no
// second owner decision is created for it.

const goal = `schema: goal/v1
id: amend-continuity
title: Amendment continuity
intent: {verbatim: keep the marker and clarify the title}
outcome: marker.txt exists under the reviewed title
non_goals: [other files, self approval]
criteria:
  - id: C1
    statement: marker.txt exists
    check: {kind: file, path: marker.txt}
protect: [oracle.txt]
`
const amended = goal.replace("title: Amendment continuity", "title: Amendment continuity, reviewed")
const lock = parseContract(goal).lock

test("accepting a staged amendment resumes the same run and creates no second owner decision", async () => {
  const host = await goalHost(script((_req, turn) => {
    const formLine = turn.trigger.split("\n").find((l) => l.startsWith("GOAL_FORM_JSON:"))
    if (formLine && turn.results === 0)
      return { toolCalls: [{ name: "question", args: JSON.parse(formLine.slice("GOAL_FORM_JSON:".length)) }] }
    if (turn.trigger.includes("PROPOSE") && turn.results === 0)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "amend-continuity", expectedLock: lock, yaml: amended, rationale: "Owner asked for a clearer title" } }] }
    if (turn.trigger.includes("goal started") || turn.trigger.includes("goal turn") || turn.trigger.includes("resumed")) {
      if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "marker.txt", content: "marker\n" } }] }
      if (turn.results === 1) return { toolCalls: [{ name: "goal_wait", args: { seconds: 10, reason: "amendment continuity window" } }] }
    }
    return { text: "Continuing after the accepted amendment." }
  }), { ".opencode/goals/amend-continuity/goal.yaml": goal })
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start amend-continuity" } as any)
    const before = await waitStatus(host, ["waiting"], 20000, "amend-continuity")

    await host.client.session.prompt({ sessionID: sid, text: "PROPOSE a clearer title; no acceptance yet." } as any)
    const request = await until(async () => {
      const store = JSON.parse(await host.readProject(".opencode/goals/.owner-amendments.json"))
      return Object.values(store.requests).find((r: any) => r.slug === "amend-continuity" && r.status === "pending") as any
    }, 15000)
    const form = await until(async () => {
      const forms: any[] = await (host.client.session.form as any).list({ sessionID: sid })
      return forms.find((f: any) => JSON.stringify(f).includes(request.id))
    }, 10000)

    // The acceptance is the owner decision. The host applies it and resumes.
    const field = form.fields[0]
    const choice = field.options.find((o: any) => o.label === "Accept amendment")
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { [field.key]: choice.value } })

    const after = await until(async () => {
      const current = await run(host, "amend-continuity")
      return current.lock === request.nextLock ? current : undefined
    }, 15000)
    expect(after.runId).toBe(before.runId)
    const events = await ledger(host, "amend-continuity")
    expect(events.filter((e) => e.type === "amended")).toHaveLength(1)
    expect(events.filter((e) => e.type === "amendment-resumed")).toHaveLength(1)
    expect(events.filter((e) => e.type === "resumed")).toHaveLength(1)
    // resumed in the same act: a continuation was admitted after the amendment
    const amendedAt = events.find((e) => e.type === "amended")!.t as number
    expect(events.some((e) => e.type === "admit" && (e.t as number) >= amendedAt)).toBe(true)
    // and the run is live, not waiting for another click
    expect(["running", "waiting"]).toContain((await run(host, "amend-continuity")).status)

    // no second owner decision was created for the acceptance
    const decisions = JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json").catch(() => '{"requests":{}}'))
    const afterAmend = Object.values(decisions.requests ?? {}).filter((d: any) => d.slug === "amend-continuity" && (d.createdAt as number) >= amendedAt)
    expect(afterAmend).toHaveLength(0)
    // and no pending form remains from the accepted review
    const forms: any[] = await (host.client.session.form as any).list({ sessionID: sid })
    expect(forms.some((f: any) => JSON.stringify(f).includes(request.id))).toBe(false)
  } finally {
    await host.stop()
  }
}, 90000)
