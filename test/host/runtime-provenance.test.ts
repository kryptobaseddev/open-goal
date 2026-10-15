import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { GoalRpc } from "../../src/rpc"
import { artifactDiscrepancies } from "../../src/verify/artifact"
import { goalHost, isVerifier, newSession, run, turnOf } from "./goal.helpers"
import { until, type Script } from "./harness"

// T115: goal_provenance is a READ-ONLY probe — it writes nothing under
// .opencode/goals, so no read can look like an agent hand-edit. The host records
// the engine-provenance evidence itself during verification, which is where the
// protected check-installed-goal.ts expects to find it. This test binds that
// host-written evidence to the actual serving server and goal session.

const VERIFIER = () => ({
  toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the file states it", evidence: [{ path: "done.txt", quote: "status: ok" }] }] } }],
})

const worker: Script = (req) => {
  if (isVerifier(req)) return VERIFIER()
  const turn = turnOf(req)
  if (turn.trigger.includes("GO")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok\n" } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { note: "wrote done.txt", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence: { C1: "done.txt", C2: "status ok", C3: "the file states it" } } }] }
    return { text: "Claimed." }
  }
  if (turn.results === 0) return { toolCalls: [{ name: "goal_provenance", args: {} }] }
  if (turn.results === 1) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "provenance inspection" } }] }
  return { text: "Holding." }
}

const toolResults = (host: Awaited<ReturnType<typeof goalHost>>) =>
  host.fixture.requests
    .flatMap((r) => (r.messages ?? []).filter((m) => m.role === "tool"))
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))

test("host verification binds the provenance evidence to the serving server; the read-only tool writes nothing", async () => {
  const host = await goalHost(worker)
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as never)
    const state = await until(async () => await run(host).catch(() => undefined))
    const path = `.opencode/goals/demo/evidence/${state.runId}/engine-provenance.json`

    // The read-only probe ran (it returned the serving identity) …
    await until(() => toolResults(host).some((c) => c.includes("serverPID")), 30000)
    // … and wrote nothing under the goal folder.
    expect(existsSync(join(host.project, path)), "goal_provenance must not write on a read").toBe(false)

    // Completing the goal runs host verification, which records the evidence.
    await host.client.session.prompt({ sessionID, text: "GO" } as never)
    const proof: any = await until(async () => {
      try { return JSON.parse(await host.readProject(path)) } catch { return undefined }
    }, 60000)
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
}, 90000)
