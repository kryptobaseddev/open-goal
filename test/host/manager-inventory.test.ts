import { expect, test } from "bun:test"
import { GoalRpc } from "../../src/rpc"
import { parseContract } from "../../src/contract/parse"
import { initialRun } from "../../src/engine/state"
import { DEMO_GOAL, goalHost, newSession, script, waitStatus } from "./goal.helpers"

const draft = `schema: goal/v1
id: planned-import
title: Planned reliable import
priority: high
intent: {verbatim: ship an import}
outcome: imported marker exists
non_goals: [other files]
criteria:
  - id: C1
    statement: import marker exists
    check: {kind: file, path: imported.txt}
meta:
  cleo_task: T077
  relates: [demo]
  owner_category: import
`
const archived = DEMO_GOAL.replace("id: demo", "id: old-import").replace("title: Demo file says ok", "title: Archived import history")
const parsed = parseContract(archived, { slug: "old-import" })
const history = initialRun(parsed.contract!, { sessionID: "ses_missing_archived", runId: "run_archived", lock: parsed.lock, now: 1 })
history.status = "complete"
history.activeSince = null
history.criteria.C1 = { status: "pass", by: "host", rejections: 0, detail: "historical proof" }
history.progress = { note: "historical completion", at: 2, turn: 1 }

test("manager inventory includes drafts, stopped/live runs, completed archives and real contract metadata without inventing a task-parent goal", async () => {
  const host = await goalHost(script((_req, turn) => {
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "inventory inspection" } }] }
    return { text: "Waiting for the inventory check." }
  }), {
    ".opencode/goals/planned-import/goal.yaml": draft,
    ".opencode/goals-archive/old-import/goal.yaml": archived,
    ".opencode/goals-archive/old-import/run.json": JSON.stringify(history),
  })
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["running", "waiting"], 30000)
    const rpc: any = (host.client as any).rpc(GoalRpc)
    const live = await rpc.list({})
    expect(live.goals.map((g: any) => g.slug).sort()).toEqual(["demo", "old-import", "planned-import"])
    const planned = live.goals.find((g: any) => g.slug === "planned-import")
    expect(planned).toMatchObject({ title: "Planned reliable import", status: "draft", priority: "high", total: 1, proven: 0, meta: { cleo_task: "T077", relates: ["demo"], owner_category: "import" } })
    expect(planned.sessionID).toBeUndefined()
    expect(planned.agent).toBeUndefined()
    expect(planned.parent).toBeUndefined()
    expect(planned.parentId).toBeUndefined()
    expect(planned.parentGoal).toBeUndefined()
    const running = live.goals.find((g: any) => g.slug === "demo")
    expect(running.sessionID).toBe(sessionID)
    expect(running.agent).toBe("build")
    expect(running.sessionState).toBe("present")
    const old = live.goals.find((g: any) => g.slug === "old-import")
    expect(old).toMatchObject({ title: history.title, archived: true, terminal: true, status: "complete", runId: history.runId, sessionID: history.sessionID, progress: history.progress, proven: 1, total: 3 })
    expect(old.attachable).toBe(false)
    expect(old.agent).toBeUndefined()
    expect(["missing", "unknown"]).toContain(old.sessionState)
    expect(await host.readProject(".opencode/goals-archive/old-import/run.json")).toBe(JSON.stringify(history))
    await host.client.session.command({ sessionID, name: "goal", text: "pause" } as any)
    await waitStatus(host, ["paused"], 10000)
    const stopped = (await rpc.list({})).goals.find((g: any) => g.slug === "demo")
    expect(stopped).toMatchObject({ status: "paused", sessionID, agent: "build", attachable: true })
  } finally { await host.stop() }
}, 60000)
