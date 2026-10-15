import { expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { goalHost, newSession, run, script, waitStatus } from "./goal.helpers"
import { until, type ChatRequest } from "./harness"

// T115 (from the VidaPeps repro): a read-only call looked like an agent hand-edit
// because goal_provenance wrote evidence under the live goal folder. goal_status,
// goal_provenance and goal_inventory must create and modify NO file under
// .opencode/goals for a live run; the host records its own provenance evidence
// during verification instead.

const READS = [
  { name: "goal_status", args: {} },
  { name: "goal_provenance", args: {} },
  { name: "goal_inventory", args: {} },
]

const worker = (_request: ChatRequest, turn: { trigger: string; results: number }) => {
  if (turn.trigger.includes("PROBE")) {
    if (turn.results === 0) return { toolCalls: READS }
    return { text: "Probe done." }
  }
  if (turn.trigger.includes("goal started") && turn.results === 0)
    return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold before the read-only probe" } }] }
  return { text: "Holding." }
}

const toolResults = (host: Awaited<ReturnType<typeof goalHost>>) =>
  host.fixture.requests
    .flatMap((r) => (r.messages ?? []).filter((m) => m.role === "tool"))
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))

test("goal_status, goal_provenance and goal_inventory write nothing under .opencode/goals", async () => {
  const host = await goalHost(script(worker as never), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as never)
    const state = await waitStatus(host, ["waiting"], 60000)

    const evidenceDir = join(host.project, ".opencode/goals/demo/evidence", state.runId)
    const before = existsSync(evidenceDir) ? readdirSync(evidenceDir).sort() : []

    // Run a turn whose only tools are the three read-only calls.
    await host.client.session.prompt({ sessionID, text: "PROBE" } as never)
    // goal_provenance returned the serving identity — it really ran.
    await until(() => toolResults(host).some((c) => c.includes("serverPID")), 30000)

    const after = existsSync(evidenceDir) ? readdirSync(evidenceDir).sort() : []
    expect(after, "a read-only call creates no file under the goal folder").toEqual(before)
    expect(after).not.toContain("engine-provenance.json")
    // the run is still the same live run, unmodified by the reads
    expect((await run(host)).runId).toBe(state.runId)
  } finally { await host.stop() }
}, 90000)
