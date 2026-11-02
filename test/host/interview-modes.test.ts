import { expect, test } from "bun:test"
import { parseContract } from "../../src/contract/parse"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T168 — one interview engine for new, continue and optimize, driven through the
// real server. The existing goal is the input: continue asks only the decisions
// its contract does not answer, and optimize stages exactly one amendment on the
// existing run without creating a second goal or touching goal.yaml.

const LIVE_GOAL = `schema: goal/v1
id: interview-target
title: Interview target
intent: {verbatim: "keep the interview target alive"}
outcome: marker.txt exists for the interview target
non_goals: [other files, a second goal]
criteria:
  - id: C1
    statement: marker.txt exists
    check: {kind: file, path: marker.txt}
invariants:
  - id: I1
    statement: The project README stays present
    check: {kind: file, path: README.md}
protect: [oracle.txt]
stop: {escalate_when: [the change needs a new dependency]}
verification: {mode: host+verifier}
`
const AMENDED = LIVE_GOAL.replace("title: Interview target", "title: Interview target, reviewed")
const LIVE_LOCK = parseContract(LIVE_GOAL).lock

const PARTIAL = `schema: goal/v1
id: partial
title: Partial draft
intent: {verbatim: "a draft that answers only outcome, criteria and scope"}
outcome: PARTIAL.txt exists
non_goals: [other files]
criteria:
  - id: C1
    statement: PARTIAL.txt exists
    check: {kind: file, path: PARTIAL.txt}
`

const COMPLETE = `schema: goal/v1
id: complete
title: Complete draft
intent: {verbatim: "a draft that already answers every interview decision"}
outcome: COMPLETE.txt exists
non_goals: [other files]
criteria:
  - id: C1
    statement: COMPLETE.txt exists
    check: {kind: file, path: COMPLETE.txt}
invariants:
  - id: I1
    statement: The project README stays present
    check: {kind: file, path: README.md}
protect: [oracle.txt]
stop: {escalate_when: [the change needs a new dependency]}
verification: {mode: host+verifier}
autonomy: {questions: defer, on_user_message: steer, on_interrupt: pause}
budget: {turns: 6}
`

type Message = { role?: string; content?: unknown }
async function toolResults(host: Awaited<ReturnType<typeof goalHost>>) {
  return (host.fixture.requests as Array<{ messages?: Message[] }>).flatMap((request) =>
    (request.messages ?? [])
      .filter((m) => m.role === "tool")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")).replace(/\\"/g, '"')),
  )
}

const requests = async (host: Awaited<ReturnType<typeof goalHost>>, file: string): Promise<any[]> => {
  const data = JSON.parse(await host.readProject(file).catch(() => '{"requests":{}}')) as { requests?: Record<string, any> }
  return Object.values(data.requests ?? {})
}

test("optimize stages exactly one amendment on the existing run and never writes a second goal or edits goal.yaml", async () => {
  const host = await goalHost(script((_req, turn) => {
    if (turn.trigger.startsWith("OPTIMIZE")) {
      if (turn.results === 0)
        return { toolCalls: [{ name: "goal_interview", args: { mode: "optimize", slug: "interview-target", change: { text: "make the title clearer", topics: ["done-when"] } } }] }
      if (turn.results === 1)
        return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "interview-target", expectedLock: LIVE_LOCK, yaml: AMENDED, rationale: "Owner asked for a clearer title" } }] }
      return { text: "Optimize staged; the owner accepts or rejects it." }
    }
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 120, reason: "hold the target for the optimize review" } }] }
    return { text: "Holding." }
  }), { ".opencode/goals/interview-target/goal.yaml": LIVE_GOAL })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start interview-target" } as never)
    const before = await waitStatus(host, ["waiting"], 30000, "interview-target")
    await host.client.session.command({ sessionID: owner, name: "goal", text: "pause" } as never)
    await waitStatus(host, ["paused"], 20000, "interview-target")
    const bytesBefore = await host.readProject(".opencode/goals/interview-target/goal.yaml")

    const author = await newSession(host)
    await host.client.session.prompt({ sessionID: author, text: "OPTIMIZE the title; stage only, do not accept." } as never)
    await host.client.session.wait({ sessionID: author } as never)

    const pending = await until(async () => {
      const all = await requests(host, ".opencode/goals/.owner-amendments.json")
      const mine = all.filter((r: any) => r.slug === "interview-target" && r.status === "pending")
      return mine.length ? mine : undefined
    }, 20000)
    // Exactly one amendment, bound to the existing run and its current lock.
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ slug: "interview-target", runId: before.runId, lock: before.lock, nextLock: parseContract(AMENDED).lock })
    expect(pending[0].nextText).toContain("title: Interview target, reviewed")

    // No second goal, no second run, and no launch review was prepared.
    expect((await run(host, "interview-target")).runId).toBe(before.runId)
    expect((await run(host, "interview-target")).status).toBe("paused")
    expect((await ledger(host, "interview-target")).filter((e) => e.type === "start")).toHaveLength(1)
    expect((await requests(host, ".opencode/goals/.owner-launches.json")).filter((r: any) => r.slug === "interview-target")).toHaveLength(0)

    // The interview never wrote the contract: only acceptance will re-lock it.
    expect(await host.readProject(".opencode/goals/interview-target/goal.yaml")).toBe(bytesBefore)

    // The plan itself proves the shared engine ran in optimize mode and opened
    // only the decision the change touched (the contract answered the rest).
    const plan = (await ledger(host, "interview-target")).find((e) => e.type === "interview-plan")
    expect(plan).toMatchObject({ mode: "optimize", action: "stage-amendment", allowed: true, open: ["done-when"], target: { slug: "interview-target", runId: before.runId, lock: before.lock } })
    const text = (await toolResults(host)).join("\n")
    expect(text).toMatch(/"mode":\s*"optimize"/)
    expect(text).toContain("goal_propose_amendment")
  } finally {
    await host.stop()
  }
}, 90000)

test("continue asks only the decisions an existing goal does not answer, and a complete goal is asked nothing", async () => {
  const host = await goalHost(script((_req, turn) => {
    const line = turn.trigger.split("\n").find((l) => l.startsWith("INTERVIEW:"))
    if (line && turn.results === 0) {
      const [slug, mode] = JSON.parse(line.slice("INTERVIEW:".length))
      return { toolCalls: [{ name: "goal_interview", args: { mode, slug } }] }
    }
    return { text: "Plan received." }
  }), {
    ".opencode/goals/partial/goal.yaml": PARTIAL,
    ".opencode/goals/complete/goal.yaml": COMPLETE,
  })
  try {
    const bytes = await host.readProject(".opencode/goals/partial/goal.yaml")
    const texts = await Promise.all(["partial", "complete"].map(async (slug) => {
      const sessionID = await newSession(host)
      await host.client.session.prompt({ sessionID, text: `INTERVIEW:${JSON.stringify([slug, "continue"])}` } as never)
      await host.client.session.wait({ sessionID } as never)
      return (await until(async () => (await toolResults(host)).findLast((t) => new RegExp(`"slug":\\s*"${slug}"`).test(t)), 10000))
    }))
    const [partialPlan, completePlan] = texts
    // Partial: outcome, criteria and non-goals are already decided; only the
    // missing evidence/oracles/invariants/escalation are asked.
    expect(partialPlan).toMatch(/"mode":\s*"continue"/)
    expect(partialPlan).toMatch(/"action":\s*"resume"/)
    expect(partialPlan).toMatch(/"open":\s*\[\s*\{\s*"topic":\s*"evidence"/)
    expect(partialPlan).toMatch(/"topic":\s*"oracles"/)
    expect(partialPlan).toMatch(/"topic":\s*"invariants"/)
    expect(partialPlan).toMatch(/"topic":\s*"escalation"/)
    expect(partialPlan).toMatch(/"topic":\s*"outcome",\s*"status":\s*"resolved"/)
    // Complete: nothing to ask.
    expect(completePlan).toMatch(/"open":\s*\[\s*\]/)
    expect(completePlan).toMatch(/"mode":\s*"continue"/)

    const events = (await ledger(host, "partial")).filter((e) => e.type === "interview-plan")
    expect(events.at(-1)).toMatchObject({ mode: "continue", action: "resume", open: ["evidence", "oracles", "invariants", "escalation"] })
    // A plan is read-only: continue creates no run and never edits the draft.
    expect(await run(host, "partial").catch(() => undefined)).toBeUndefined()
    expect(await host.readProject(".opencode/goals/partial/goal.yaml")).toBe(bytes)
  } finally {
    await host.stop()
  }
}, 60000)
