import { expect, test } from "bun:test"
import { join } from "node:path"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// v0.8.0 C1 — a host restart is not an owner decision.
//
// Clean restart (unchanged lock, intact run): the engine resumes by itself and
// the run keeps moving. A contract changed under the run, and a run.json write
// that was interrupted, still pause and say why.

const DONE = "status: ok - restart continuity\n"

const worker = script((_req, turn) => {
  if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
  if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "park in a wait" } }] }
  if (turn.results === 2) return { toolCalls: [{ name: "goal_wait", args: { seconds: 10, reason: "restart continuity window" } }] }
  return { text: "Holding while the host restarts." }
})

const reload = async (host: Awaited<ReturnType<typeof goalHost>>) => {
  await host.client.location.reload()
  // The plugin's setup (and recover()) runs again; wait until it answers.
  await until(async () => {
    try { await host.client.plugin.list({ location: host.location } as any); return true } catch { return false }
  }, 30000)
}

test("a clean restart resumes the run by itself; a changed contract and an interrupted write still pause", async () => {
  const host = await goalHost(worker)
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const parked = await waitStatus(host, ["waiting"], 20000)
    expect(parked.turn).toBeGreaterThan(0)

    // ── clean restart: unchanged lock + intact run ──
    await reload(host)
    const resumed = await until(async () => (await ledger(host)).find((e) => e.type === "restart-resume"), 15000)
    expect(resumed.runId).toBe(parked.runId)
    expect(resumed.lock).toBe(parked.lock)
    const recovered = (await ledger(host)).findLast((e) => e.type === "recovered")
    expect(recovered?.status).toBe("resumed")
    // no owner decision was created for the restart
    expect((await host.readProject(".opencode/goals/.owner-decisions.json").catch(() => '{"requests":{}}')).includes('"kind":"owner-operation"')).toBe(false)
    const state = await run(host)
    expect(state.status).not.toBe("paused")
    expect(state.runId).toBe(parked.runId)
    // it really continues: the park drains into another admitted turn
    await until(async () => (await ledger(host)).filter((e) => e.type === "admit").length >= 2, 20000)

    // ── the contract changed under the run: pause, naming the divergence ──
    const yaml = await host.readProject(".opencode/goals/demo/goal.yaml")
    await Bun.write(join(host.project, ".opencode/goals/demo/goal.yaml"), yaml.replace("Demo file says ok", "Demo file says something else"))
    await reload(host)
    const paused = await until(async () => {
      const current = await run(host).catch(() => undefined)
      return current?.status === "paused" ? current : undefined
    }, 20000)
    expect(paused.reason).toContain("contract on disk")
    expect(paused.reason).toContain(parked.lock.slice(0, 12))
    expect((await ledger(host)).some((e) => e.type === "recovered" && e.status === "paused" && e.code === "diverged")).toBe(true)

    // ── an interrupted run.json write: repair, then pause ──
    const raw = await host.readProject(".opencode/goals/demo/run.json")
    const broken = raw.replace(/\n\}\s*$/, ',\n  "status": "running"\n}\n') // duplicate key = an interrupted write
    await Bun.write(join(host.project, ".opencode/goals/demo/run.json"), broken)
    await reload(host)
    const repaired = await waitStatus(host, ["paused"], 20000)
    expect(repaired.reason).toMatch(/repaired|corrupt/i)
    expect((await ledger(host)).some((e) => e.type === "run-state-repaired")).toBe(true)
  } finally {
    await host.stop()
  }
}, 180000)
