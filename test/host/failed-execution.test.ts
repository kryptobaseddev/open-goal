import { expect, test } from "bun:test"
import { join } from "node:path"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"

const yaml = `schema: goal/v1
id: demo
title: Bounded execution failure inspection
intent: {verbatim: wait for a host execution signal}
outcome: marker exists
non_goals: [provider configuration changes]
criteria:
  - id: C1
    statement: marker exists
    check: {kind: file, path: marker.txt}
`

async function setup(mode: string) {
  const host = await goalHost(script(() => ({ text: "An actual model execution ended; the test host controls its reported result." })),
    { "failure-mode.txt": mode, ".opencode/goals/demo/goal.yaml": yaml },
    { plugin: join(import.meta.dir, "../fixtures/failed-execution") })
  const sessionID = await newSession(host)
  await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
  return host
}

test("unavailable model stops on its first failed execution instead of producing continue notices forever", async () => {
  const host = await setup("unavailable")
  try {
    const stopped = await waitStatus(host, ["paused"], 15000)
    expect(stopped.reason).toContain("Model unavailable")
    expect(stopped.turn).toBe(1)
    const before = await ledger(host)
    expect(before.filter((e) => e.type === "turn-failed")).toHaveLength(1)
    await Bun.sleep(11000) // beyond the former repeated ten-second retry
    expect((await run(host)).turn).toBe(1)
    expect((await ledger(host)).filter((e) => e.type === "admit")).toHaveLength(1)
  } finally { await host.stop() }
}, 45000)

test("prompt acknowledgement cannot erase execution failures; only a completed execution resets the bounded streak", async () => {
  const host = await setup("recover")
  try {
    const stopped = await waitStatus(host, ["paused"], 45000)
    expect(stopped.reason).toContain("repeated errors")
    expect(stopped.turn).toBe(4)
    const events = await ledger(host)
    expect(events.filter((e) => e.type === "turn-failed").map((e) => e.failures)).toEqual([1, 1, 2])
    expect(events.filter((e) => e.type === "turn")).toHaveLength(1)
    await Bun.sleep(1000)
    expect((await run(host)).status).toBe("paused")
    expect((await run(host)).pending).toBeUndefined()
  } finally { await host.stop() }
}, 60000)
