// Follow-up to v0.8.0 C3 — a still-pending decision is not stale, but it must
// not be re-asked on every turn end. The owner gets ONE native ask; silence
// follows until an explicit goal_review or a reload.
import { test, expect } from "bun:test"
import { goalHost, ledger, newSession, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"
import { GoalRpc } from "../../src/rpc"

const GOAL = `schema: goal/v1
id: askonce
title: Ask once
intent:
  verbatim: v
outcome: done.txt exists
non_goals: [x]
criteria:
  - id: C1
    statement: done.txt SHALL exist
    check: {kind: file, path: done.txt}
plan:
  - {id: S1, title: Write done.txt, proves: [C1]}
`

test("a pending completion decision is asked once, then stays silent until an explicit review", async () => {
  const host = await goalHost(
    script((_req: any, turn: { trigger: string; results: number }) => {
      if (turn.trigger.includes("goal started") || turn.trigger.includes("goal turn")) {
        if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok\n" } }] }
        if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
        if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence: { C1: "wrote done.txt" } } }] }
      }
      return { text: "Nothing else to do." }
    }),
    { ".opencode/goals/askonce/goal.yaml": GOAL },
  )
  try {
    const rpc: any = (host.client as any).rpc(GoalRpc)
    const decisions: any[] = []
    rpc.events.on("decision", (event: any) => decisions.push(event.data))
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start askonce" } as any)
    await waitStatus(host, ["complete"], 90000, "askonce")

    const complete = await until(() => decisions.find((d) => d.kind === "complete"), 15000)
    const asks = async () => (await ledger(host, "askonce")).filter((e) => e.type === "decision-form-asked" && e.decision === complete.decisionId).length
    await until(async () => (await asks()) >= 1, 15000)
    const first = await asks()

    // two ordinary turn ends must not produce another ask
    for (let i = 0; i < 2; i++) {
      await host.client.session.prompt({ sessionID, text: `just checking in ${i}` } as any).catch(() => {})
      await Bun.sleep(600)
    }
    expect(await asks()).toBe(first)

    // an explicit review is the supported way to present it again
    const review = await rpc.review({ sessionID, decisionId: complete.decisionId })
    expect(review.ok).toBe(true)
    await until(async () => (await asks()) === first + 1, 15000)
  } finally {
    await host.stop()
  }
}, 150000)
