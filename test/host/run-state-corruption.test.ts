import { expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// The reported file was a hand merge: duplicate "updatedAt", "tokens", "tools"
// and "lastUsageEmit" keys. JSON.parse accepts that silently (last value wins),
// so the engine kept running on a state nobody wrote on purpose. It must see
// the corruption, repair only what the run's own evidence proves, and refuse
// and stop when it cannot prove it.

const duplicated = (text: string) => text.replace(/(\n  "updatedAt": \d+,)/, `$1\n  "updatedAt": 1792084316181,`).replace(/(\n  "turn": \d+,)/, `$1\n  "turn": 99,`)

test("a hand-merged run.json with duplicate keys is detected, repaired from provable evidence and never read as last-wins", async () => {
  const host = await goalHost(script((_request, turn) => (!turn.results ? { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold" } }] } : { text: "Holding." })), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    const started = await waitStatus(host, ["waiting"], 15000)
    const path = join(host.project, ".opencode/goals/demo/run.json")
    const honest = await host.readProject(".opencode/goals/demo/run.json")
    await Bun.write(path, duplicated(honest))

    await host.client.location.reload()

    await until(async () => (await ledger(host)).some((e) => e.type === "run-state-corruption"), 15000)
    const event = (await ledger(host)).find((e) => e.type === "run-state-corruption")!
    expect(String(event.duplicateKeys ?? "")).toMatch(/updatedAt/)
    expect(String(event.duplicateKeys ?? "")).toMatch(/turn/)

    // Repaired: clean JSON, and the injected duplicate never became the state.
    const repaired = JSON.parse(await host.readProject(".opencode/goals/demo/run.json"))
    expect(repaired.turn).not.toBe(99)
    expect(repaired.runId).toBe(started.runId)
    expect(repaired.lock).toBe(started.lock)
    expect(repaired.sessionID).toBe(owner)

    // The raw corrupt bytes are kept beside the run, not silently dropped.
    const kept = readdirSync(join(host.project, ".opencode/goals/demo")).filter((f) => f.startsWith("run.json.corrupt-"))
    expect(kept.length).toBeGreaterThan(0)
    expect(await Bun.file(join(host.project, ".opencode/goals/demo", kept[0]!)).text()).toContain('"updatedAt": 1792084316181')
    expect((await ledger(host)).some((e) => e.type === "run-state-repaired")).toBe(true)

    // The goal keeps working on the repaired generation.
    expect((await run(host)).status).toBe("paused")
  } finally { await host.stop() }
}, 90000)

test("a malformed run.json the evidence cannot prove is refused and the goal stops for the owner", async () => {
  const host = await goalHost(script((_request, turn) => (!turn.results ? { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold" } }] } : { text: "Holding." })), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    await waitStatus(host, ["waiting"], 15000)
    // Malformed beyond repair AND no evidence to reconstruct from.
    await Bun.write(join(host.project, ".opencode/goals/demo/run.json"), '{ "version": 1, "slug": "demo", "status": ')
    for (const entry of readdirSync(join(host.project, ".opencode/goals/demo/evidence"))) {
      await Bun.spawn(["rm", "-rf", join(host.project, ".opencode/goals/demo/evidence", entry)]).exited
    }

    await host.client.location.reload()

    await until(async () => (await ledger(host)).some((e) => e.type === "run-state-unprovable"), 15000)
    // Not registered as a live run, and the owner is told rather than guessed at.
    const status = await host.client.rpc((await import("../../src/rpc")).GoalRpc).snapshot({ sessionID: owner }).catch(() => undefined) as any
    expect(status?.view?.slug ?? null).not.toBe("demo")
    expect(existsSync(join(host.project, ".opencode/goals/demo/run.json"))).toBe(true)
  } finally { await host.stop() }
}, 90000)
