import { expect, test } from "bun:test"
import { goalHost, ledger, newSession, run, script, text, waitStatus } from "./goal.helpers"
import { until } from "./harness"

test("progress on a stopped goal returns explicit not-recorded state and cannot advance the plan, proof or loop", async () => {
  const host = await goalHost(script((_request, turn) => {
    if (turn.trigger.includes("REPORT_PROGRESS") && turn.results === 0)
      return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "Owner-requested status report while stopped", next: "Inspect actual status, not implicit resume" } }] }
    if (turn.trigger.includes("goal started") && turn.results === 0)
      return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "progress precondition inspection" } }] }
    return { text: "A rejected status report is not a goal resume." }
  }))
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["waiting"], 15000)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "pause" } as any)
    const before = await waitStatus(host, ["paused"], 10000)
    const base = await ledger(host)
    await host.client.session.prompt({ sessionID: sid, text: "REPORT_PROGRESS report only; no permission to resume." } as any)
    await until(() => host.fixture.requests.some((r) => r.messages.some((m) => m.role === "tool" && text(m).includes('"recorded": false'))), 10000)
    const messages: any[] = await host.client.session.context({ sessionID: sid } as any)
    const tool = messages.flatMap((m) => m.content ?? []).findLast((part: any) => part.type === "tool" && part.name === "goal_progress")
    expect(tool.state.status).toBe("completed")
    const result = JSON.parse(tool.state.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n"))
    expect(result).toMatchObject({ ok: false, recorded: false, status: "paused", slug: "demo", runId: before.runId })
    expect(result.nextAction).toContain("do not retry")
    const after = await run(host)
    expect(after.status).toBe("paused")
    expect(after.runId).toBe(before.runId)
    expect(after.steps).toEqual(before.steps)
    expect(after.criteria).toEqual(before.criteria)
    expect(after.progress).toEqual(before.progress)
    const events = await ledger(host)
    expect(events.filter((e) => e.type === "progress")).toHaveLength(base.filter((e) => e.type === "progress").length)
    expect(events.filter((e) => e.type === "resumed")).toHaveLength(0)
    expect(events.filter((e) => e.type === "admit")).toHaveLength(base.filter((e) => e.type === "admit").length)
  } finally { await host.stop() }
}, 45000)
