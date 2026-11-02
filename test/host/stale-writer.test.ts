import { expect, test } from "bun:test"
import { join } from "node:path"
import { Store } from "../../src/engine/store"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T172 — the reported failure: a dying engine's final run.json write landed
// after the owner had repaired the file, and undid the repair (twice, in a
// sibling project). This reproduces that exact order against a real host:
// the engine holds generation N, the owner writes a newer valid generation,
// the dying writer's final write is refused (receipt names both), and the
// live engine that has observed the repair still persists normally.

const RUN = ".opencode/goals/demo/run.json"

test("T172: a dying engine's final write cannot undo an owner repair, and the live engine still writes", async () => {
  const host = await goalHost(script((_request, turn) =>
    !turn.results
      ? { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold for the stale-writer scenario" } }] }
      : { text: "Holding." },
  ), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    const started = await waitStatus(host, ["waiting"], 15000)
    expect(typeof started.revision).toBe("number")

    // The snapshot a dying engine still holds: the last generation it wrote.
    const stale = JSON.parse(await host.readProject(RUN))
    expect(typeof stale.revision).toBe("number")

    // The owner repairs run.json directly: same run, a newer valid generation,
    // paused, with a marker the engine never wrote.
    const repaired = {
      ...stale,
      revision: stale.revision + 3,
      status: "paused",
      reason: "owner repair: run.json restored by hand",
      progress: { note: "owner repair marker", next: "resume after review", at: Date.now(), turn: stale.turn },
      writtenAt: Date.now(),
      writtenBy: { pid: 999_999, startedAt: 1, sessionID: "owner-repair" },
    }
    const repairedText = `${JSON.stringify(repaired, null, 2)}\n`
    const path = join(host.project, RUN)
    await Bun.write(path, repairedText)

    // The dying engine's final write — the exact Store path persist() uses,
    // with the snapshot it never updated.
    const dying = new Store(host.project, undefined, { log: () => {} })
    const outcome = dying.writeRun(stale)
    expect(outcome.written).toBe(false)
    if (outcome.written) throw new Error("unreachable")
    expect(outcome.reason).toBe("stale")
    expect(outcome.mine).toMatchObject({ revision: stale.revision, runId: started.runId, lock: started.lock })
    expect(outcome.disk).toMatchObject({ revision: repaired.revision, runId: started.runId, lock: started.lock, status: "paused" })

    // The repair survives byte-for-byte.
    expect(await host.readProject(RUN)).toBe(repairedText)

    // One receipt from this writer names BOTH generations and who held each.
    const receipts = async () => (await ledger(host)).filter((e) => e.type === "stale-write") as Array<Record<string, any>>
    const mine = (await receipts()).filter((e) => e.pid === process.pid)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ slug: "demo", runId: started.runId, reason: "stale", action: "disk-left-untouched" })
    expect(mine[0]!.mine).toMatchObject({ revision: stale.revision, lock: started.lock })
    expect(mine[0]!.disk).toMatchObject({ revision: repaired.revision, lock: started.lock, status: "paused", writtenBy: { sessionID: "owner-repair" } })
    expect((await receipts()).every((e) => e.disk.revision === repaired.revision)).toBe(true)

    // A retry from the same stale snapshot journals no second receipt.
    const retry = dying.writeRun(stale)
    expect(retry.written).toBe(false)
    if (retry.written) throw new Error("unreachable")
    expect(retry.journalled).toBe(false)
    expect((await receipts()).filter((e) => e.pid === process.pid)).toHaveLength(1)
    expect(await host.readProject(RUN)).toBe(repairedText)

    // The live engine reloads, observes the repaired generation and persists
    // normally: forward progress is never blocked for a writer that is current.
    await host.client.location.reload()
    await host.client.session.command({ sessionID: owner, name: "goal", text: "resume demo" } as never)
    const live = await until(async () => {
      const now = await run(host)
      return now.revision > repaired.revision && now.status !== "paused" ? now : undefined
    }, 30000)
    // The owner's repair is the base the live engine wrote from.
    expect(live.progress?.note).toBe("owner repair marker")
    expect(["running", "waiting"]).toContain(live.status)
    expect(live.runId).toBe(started.runId)
    // A successful persist never needs a stale-write receipt.
    expect((await receipts()).filter((e) => e.pid === process.pid)).toHaveLength(1)
  } finally { await host.stop() }
}, 120000)
