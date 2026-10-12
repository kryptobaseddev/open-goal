import { expect, test } from "bun:test"
import { join } from "node:path"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

const yaml = `schema: goal/v1
id: semantic-amend
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
`

test("changing only a criterion STATEMENT invalidates its proof even when the check is identical", async () => {
  const host = await goalHost(script((_req, turn) => {
    if (turn.trigger.includes("goal started")) {
      if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "marker.txt", content: "marker\n" } }] }
      if (turn.results === 1) return { toolCalls: [{ name: "goal_claim", args: { summary: "marker written", evidence: { C1: "file exists", C2: "owner review remains" } } }] }
    }
    return { text: "Waiting for the owner's review." }
  }), { ".opencode/goals/semantic-amend/goal.yaml": yaml })
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start semantic-amend" } as any)
    const before = await waitStatus(host, ["needs_review"], 30000, "semantic-amend")
    expect(before.criteria.C1).toMatchObject({ status: "pass", by: "host" })
    // Compatibility-path fixture: the owner edits, not a worker. The new
    // conversational path must use the SAME semantic invalidation rule.
    await Bun.write(join(host.project, ".opencode/goals/semantic-amend/goal.yaml"), yaml.replace("the marker SHALL exist", "the marker SHALL exist and represent the new requested outcome"))
    await host.client.session.command({ sessionID, name: "goal", text: "amend confirm" } as any)
    // The command API acknowledges deferred admission, not completion of
    // the still-finishing needs-review turn. Require the actual host commit
    // receipt before reading its state; all invalidation assertions remain.
    await until(async () => (await ledger(host, "semantic-amend")).some((e) => e.type === "amended" && e.oldLock === before.lock), 10000)
    const after = await run(host, "semantic-amend")
    expect(after.lock).not.toBe(before.lock)
    expect(after.criteria.C1.status).toBe("unknown")
    expect(after.criteria.C1.by).toBeUndefined()
    expect(after.criteria.C2).toEqual(before.criteria.C2)
  } finally { await host.stop() }
}, 60000)
