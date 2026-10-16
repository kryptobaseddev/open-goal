import { describe, expect, test } from "bun:test"
import { until } from "./harness"
import { goalHost, newSession, script } from "./goal.helpers"
import { GoalRpc } from "../../src/rpc"

// v0.5.0 — the optional CLEO linkage block and the on-demand bridge, end to end.
// A contract may name the CLEO tasks it serves; a contract without the block
// behaves exactly as before; and the bridge refuses honestly (never fakes a
// closure) when CLEO cannot bind a task.

const idle = script(() => ({ text: "ok" }))

const base = (id: string, cleo: string) => `schema: goal/v1
id: ${id}
title: ${id} goal
intent:
  verbatim: "make done.txt say ok"
outcome: done.txt exists
non_goals:
  - Touching any other file
criteria:
  - id: C1
    statement: done.txt SHALL exist
    check: {kind: file, path: done.txt}
${cleo}`

async function command(host: Awaited<ReturnType<typeof goalHost>>, sessionID: string, text: string, match: RegExp): Promise<string> {
  const goalRpc = (host.client as any).rpc(GoalRpc)
  const notices: string[] = []
  const off = goalRpc.events.on("notice", (e: any) => notices.push(String(e?.data?.text ?? e?.text ?? "")))
  await host.client.session.command({ sessionID, name: "goal", text } as any)
  const found = await until(async () => notices.find((n) => match.test(n)) ?? undefined, 30000)
  off?.()
  return found ?? notices.join("\n")
}

describe("the CLEO linkage block and the on-demand bridge (v0.5.0)", () => {
  test("a contract WITH cleo.tasks validates; a contract WITHOUT the block is unchanged", async () => {
    const host = await goalHost(idle, {
      ".opencode/goals/linked/goal.yaml": base("linked", "cleo:\n  tasks: [T080, T082]\n"),
      ".opencode/goals/plain/goal.yaml": base("plain", ""),
    })
    try {
      const sessionID = await newSession(host)
      const linked = await command(host, sessionID, "validate linked", /goal\.yaml/)
      expect(linked).toContain("valid")
      const plain = await command(host, sessionID, "validate plain", /goal\.yaml/)
      expect(plain).toContain("valid")
      expect(plain).not.toContain("cleo")
    } finally {
      await host.stop()
    }
  }, 120000)

  test("the bridge reports the exact blocker for a task CLEO cannot bind — it never fakes a closure", async () => {
    const host = await goalHost(idle, { ".opencode/goals/linked/goal.yaml": base("linked", "cleo:\n  tasks: [T080]\n") })
    try {
      const sessionID = await newSession(host)
      const text = await command(host, sessionID, "cleo sync linked T000000", /not completed|blocker/)
      expect(text).toContain("T000000")
      expect(text).toContain("not completed")
      expect(text).toContain("blocker")
    } finally {
      await host.stop()
    }
  }, 180000)
})
