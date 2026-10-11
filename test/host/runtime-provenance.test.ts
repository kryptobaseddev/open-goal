import { expect, test } from "bun:test"
import { GoalRpc } from "../../src/rpc"
import { artifactDiscrepancies } from "../../src/verify/artifact"
import { goalHost, newSession, run, script } from "./goal.helpers"
import { until } from "./harness"

test("the native provenance tool binds host-written evidence to the actual serving server and goal session", async () => {
  const host = await goalHost(script((_req, turn) => {
    if (turn.results === 0) return { toolCalls: [{ name: "goal_provenance", args: {} }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_wait", args: { seconds: 30, reason: "provenance inspection" } }] }
    return { text: "Recorded actual runtime evidence." }
  }))
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
    const state = await until(async () => await run(host).catch(() => undefined))
    const path = `.opencode/goals/demo/evidence/${state.runId}/engine-provenance.json`
    const proof: any = await until(async () => {
      try { return JSON.parse(await host.readProject(path)) } catch { return undefined }
    })
    const info: any = await host.client.server.info()
    expect(proof.serverPID).toBe(info.pid)
    expect(proof.location).toBe(host.project)
    expect(proof.sessionID).toBe(sessionID)
    expect(proof.runId).toBe(state.runId)
    expect(proof.lock).toBe(state.lock)
    expect(proof.artifacts["src/tui/index.tsx"]).toMatch(/^[a-f0-9]{64}$/)
    const rpc: any = (host.client as any).rpc(GoalRpc)
    const current = await rpc.provenance({ sessionID })
    expect(current.artifacts).toEqual(proof.artifacts)
    expect(current.serverPID).toBe(info.pid)
    // A dev/source-tree host must not be laundered into a deployed release.
    expect(artifactDiscrepancies(current, { revision: "0".repeat(40), artifacts: proof.artifacts })).toContain("the running plugin is not a package install")
  } finally { await host.stop() }
}, 60000)
