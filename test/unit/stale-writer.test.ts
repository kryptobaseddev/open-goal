import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseContract } from "../../src/contract/parse"
import { initialRun } from "../../src/engine/state"
import { Store } from "../../src/engine/store"

// T172 — the run row's write guard. A dying engine's final run.json write
// undid an owner-side repair twice in a sibling project. `revision` is a
// monotonic generation stamped by every accepted write; a writer may only
// replace a row whose valid on-disk generation is not ahead of the snapshot it
// holds. These tests pin the rule at the store, where every writer goes.

const YAML = `schema: goal/v1
id: stale
title: Stale writer demo
intent: {verbatim: prove the write guard}
outcome: the run row is never rolled back to an older generation
non_goals: [other files]
criteria:
  - id: C1
    statement: marker.txt exists
    check: {kind: file, path: marker.txt}
plan:
  - {id: S1, title: Record it, proves: [C1]}
`

function project(name: string) {
  const root = mkdtempSync(join(tmpdir(), `ocgoal-${name}-`))
  // The stderr refusal line is asserted through the ledger instead; keep test
  // output clean.
  const store = new Store(root, undefined, { log: () => {} })
  const contract = parseContract(YAML, { slug: "stale" }).contract!
  mkdirSync(store.dir("stale"), { recursive: true })
  const state = (runId = "run_1") => initialRun(contract, { sessionID: "ses_owner", runId, lock: "a".repeat(64), now: 1000 })
  const path = join(store.dir("stale"), "run.json")
  return { root, store, state, path }
}

const receipt = (store: Store) => store.readLedger("stale").filter((e) => e.type === "stale-write") as Array<Record<string, any>>

describe("T172 run-state generation", () => {
  test("forward writes advance the generation and the same snapshot keeps writing", () => {
    const { root, store, state } = project("stale-forward")
    try {
      const live = state()
      expect(store.writeRun(live)).toEqual({ written: true, revision: 1 })
      expect(live.revision).toBe(1)
      expect(store.writeRun(live)).toEqual({ written: true, revision: 2 })
      const disk = store.readRun("stale")!
      expect(disk.revision).toBe(2)
      expect(disk.writtenBy).toMatchObject({ pid: process.pid, sessionID: "ses_owner" })
      expect(typeof disk.writtenAt).toBe("number")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("an older snapshot may not overwrite a newer valid generation; one receipt names both", () => {
    const { root, store, state, path } = project("stale-refuse")
    try {
      const dying = state()
      store.writeRun(dying) // generation 1 — the snapshot the process now holds
      const disk = store.readRun("stale")!

      // The owner repairs the row while the dying process still holds gen 1.
      const repaired = {
        ...disk, revision: 4, status: "paused",
        reason: "owner repair: run.json restored by hand",
        progress: { note: "owner repair marker", at: 2, turn: 0 },
        writtenAt: 5, writtenBy: { pid: 999_999, startedAt: 1, sessionID: "owner-repair" },
      }
      const repairedText = `${JSON.stringify(repaired, null, 2)}\n`
      writeFileSync(path, repairedText)

      const outcome = store.writeRun(dying)
      expect(outcome.written).toBe(false)
      if (outcome.written) throw new Error("unreachable")
      expect(outcome.reason).toBe("stale")
      expect(outcome.mine).toMatchObject({ revision: 1, runId: "run_1", lock: dying.lock })
      expect(outcome.disk).toMatchObject({ revision: 4, runId: "run_1", lock: dying.lock, status: "paused" })
      // The refusal changed nothing on disk and nothing in the writer's snapshot.
      expect(readFileSync(path, "utf8")).toBe(repairedText)
      expect(dying.revision).toBe(1)

      const events = receipt(store)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ slug: "stale", runId: "run_1", reason: "stale", pid: process.pid, action: "disk-left-untouched" })
      expect(events[0]!.mine).toMatchObject({ revision: 1, runId: "run_1", lock: dying.lock })
      expect(events[0]!.disk).toMatchObject({ revision: 4, status: "paused", writtenBy: { sessionID: "owner-repair" } })

      // A burst of retries from the same stale snapshot journals once.
      const retry = store.writeRun(dying)
      expect(retry.written).toBe(false)
      if (retry.written) throw new Error("unreachable")
      expect(retry.journalled).toBe(false)
      expect(receipt(store)).toHaveLength(1)
      expect(readFileSync(path, "utf8")).toBe(repairedText)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("a malformed or partially written disk file is not newer; the repair still writes", () => {
    const { root, store, state, path } = project("stale-corrupt")
    try {
      const writer = state()
      store.writeRun(writer) // generation 1
      // A torn write that still names a much higher generation.
      writeFileSync(path, '{ "version": 1, "slug": "stale", "revision": 9, "status": ')

      const outcome = store.writeRun(writer)
      // Corruption is the existing repair path, never a refusal…
      expect(outcome.written).toBe(true)
      // …and it must not roll the counter back below what the file named.
      expect(outcome.written && outcome.revision).toBe(10)
      expect(store.readRun("stale")?.revision).toBe(10)
      expect(receipt(store)).toHaveLength(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test("a successor run takes the row over only explicitly; the old run's writer is then refused", () => {
    const { root, store, state } = project("stale-superseded")
    try {
      const old = state()
      store.writeRun(old) // generation 1
      const next = state("run_2")

      const refused = store.writeRun(next)
      expect(refused.written).toBe(false)
      if (refused.written) throw new Error("unreachable")
      expect(refused.reason).toBe("superseded")

      // The host's start path is the one deliberate replacement.
      expect(store.writeRun(next, { replace: true })).toEqual({ written: true, revision: 2 })
      expect(store.readRun("stale")?.runId).toBe("run_2")

      // The superseded run's dying engine arrives late: refused, disk intact.
      const late = store.writeRun(old)
      expect(late.written).toBe(false)
      if (late.written) throw new Error("unreachable")
      expect(late.reason).toBe("superseded")
      expect(store.readRun("stale")?.runId).toBe("run_2")
      expect(store.readRun("stale")?.revision).toBe(2)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
