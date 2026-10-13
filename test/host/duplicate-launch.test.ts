import { expect, test } from "bun:test"
import { GoalRpc } from "../../src/rpc"
import { launchChoices } from "../../src/engine/launches"
import { goalHost, newSession, run, ledger, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

test("a late launch review fails honestly without recommending abort of the exact existing run", async () => {
  const host = await goalHost(script((_req, turn) => {
    if (turn.trigger === "PREPARE_LAUNCH" && !turn.results) return { toolCalls: [{ name: "goal_prepare_launch", args: { slug: "demo", fresh: false } }] }
    if (turn.trigger.includes("goal started") && !turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "duplicate-launch inspection" } }] }
    return { text: "No second launch or fabricated approval." }
  }), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const sid = await newSession(host)
    await host.client.session.prompt({ sessionID: sid, text: "PREPARE_LAUNCH" } as any)
    const review: any = await until(async () => {
      const data = JSON.parse(await host.readProject(".opencode/goals/.owner-launches.json").catch(() => '{"requests":{}}'))
      return Object.values(data.requests).find((p: any) => p.sessionID === sid && p.status === "pending")
    }, 15000)
    await host.client.session.wait({ sessionID: sid } as any)
    // The fixture owner starts the unchanged draft before answering the older
    // launch review. This is an actual native reply, never worker consent.
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const before = await waitStatus(host, ["waiting"], 15000)
    const form: any = await (host.client.session.form as any).create({ sessionID: sid, title: "Exact pending launch review", fields: [{ key: "action", title: review.question, type: "string", options: launchChoices }] })
    await until(async () => JSON.parse(await host.readProject(".opencode/goals/.owner-launches.json")).requests[review.id].formID === form.id, 10000)
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { action: "launch" } })
    const failed: any = await until(async () => {
      const p = JSON.parse(await host.readProject(".opencode/goals/.owner-launches.json")).requests[review.id]
      return p.status === "failed" ? p : undefined
    }, 10000)
    expect(failed.result).toContain("existing run")
    expect(failed.result).not.toContain("Abort it first")
    const after = await run(host)
    expect(after.runId).toBe(before.runId)
    expect(after.lock).toBe(before.lock)
    expect(after.status).toBe("waiting")
    expect((await ledger(host)).filter((e) => e.type === "start")).toHaveLength(1)
    const snapshot: any = await (host.client as any).rpc(GoalRpc).snapshot({ sessionID: sid })
    expect(snapshot.view).toMatchObject({ sessionID: sid, lock: before.lock, runId: before.runId, status: "waiting" })
    expect(snapshot.launches.find((p: any) => p.decisionId === review.id).status).toBe("failed")
  } finally { await host.stop() }
}, 60000)
