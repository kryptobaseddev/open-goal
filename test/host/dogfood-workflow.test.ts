import { describe, expect, test } from "bun:test"
import {
  FLOWS,
  runDogfood,
  validateExport,
  type FlowId,
  type FlowRecord,
  type FlowRun,
  type ReleaseIdentity,
} from "../../src/engine/dogfood-record"

// v0.5.1 - the consolidated exact-release workflow (CLEO T102).
// One bounded workflow runs the five native flows, records ONE shape and writes
// BOTH halves of the export. These tests drive the orchestration with injected
// runners, so they are deterministic and spend no real-model tokens; the real
// five-flow run is the goal's own completion evidence.

const release: ReleaseIdentity = { version: "0.5.1", ref: "v0.5.1", sha: "a".repeat(40), artifacts: { "server.ts": "h1" } }
const serving = { pid: 4242, location: "/tmp/qa" }
const selections = { model: "deepseek/deepseek-flash", agent: "build" }
const raw = {
  ownerMessages: ["do the thing"],
  forms: [{ id: "f1", question: "ok?", answer: "yes" }],
  toolCalls: [{ name: "write", result: "ok" }],
  results: ["status: ok"],
}
const okRun = (flow: FlowId): FlowRun => ({ exit: 0, ms: 5, requestIds: [`req-${flow}`], readCoordinates: [{ path: "qa-evidence/context.json", offset: 0, limit: 64 }], raw })

function harness(behaviour: Partial<Record<FlowId, FlowRun>> = {}, releaseOverride?: ReleaseIdentity) {
  const store = new Map<FlowId, FlowRecord>()
  const ran: FlowId[] = []
  const emitted = { summary: [] as string[], index: [] as string[] }
  const deps = (force?: boolean) => ({
    identity: async () => ({ release: releaseOverride ?? release, serving, selections }),
    runFlow: async (flow: FlowId) => {
      ran.push(flow)
      return behaviour[flow] ?? okRun(flow)
    },
    store: { read: async (f: FlowId) => store.get(f), write: async (r: FlowRecord) => void store.set(r.flow, r) },
    emit: { summary: async (md: string) => void emitted.summary.push(md), index: async (e: unknown) => void emitted.index.push(JSON.stringify(e)) },
    force,
  })
  return { store, ran, emitted, deps }
}

describe("the exact-release dogfood workflow (v0.5.1)", () => {
  test("runs all five flows once, writes both halves, then REUSES the verified records on a resumed run", async () => {
    const h = harness()
    const first = await runDogfood(h.deps())
    expect(first.results.every((r) => !r.reused)).toBe(true)
    expect(h.ran).toEqual([...FLOWS])
    expect(validateExport(first.export)).toEqual([])
    expect(h.store.size).toBe(5)
    expect(h.emitted.summary).toHaveLength(1)
    expect(h.emitted.index).toHaveLength(1)
    // A resumed run (the completing check) reuses the real records instead of
    // paying for five real-model flows a second time.
    h.ran.length = 0
    const second = await runDogfood(h.deps())
    expect(second.results.every((r) => r.reused)).toBe(true)
    expect(h.ran).toEqual([])
    // --force re-runs them.
    const third = await runDogfood(h.deps(true))
    expect(third.results.every((r) => !r.reused)).toBe(true)
    expect(h.ran).toEqual([...FLOWS])
  })

  test("an honest failure keeps its own label, never a pass, and the export still validates", async () => {
    const h = harness({
      manager: { exit: 0, fixture: true, ms: 1, requestIds: ["r"], readCoordinates: [{ path: "c", offset: 0, limit: 1 }], raw },
      lifecycle: { exit: 0, timedOut: true, ms: 1, requestIds: ["r"], readCoordinates: [{ path: "c", offset: 0, limit: 1 }], raw },
      completion: { exit: 3, ms: 1, requestIds: ["r"], readCoordinates: [{ path: "c", offset: 0, limit: 1 }], raw },
      amendment: { exit: 0, ms: 1, requestIds: ["r"], readCoordinates: [{ path: "c", offset: 0, limit: 1 }], raw: { ownerMessages: [], forms: [], toolCalls: [], results: [] } },
    })
    const result = await runDogfood(h.deps())
    const label = (f: FlowId) => result.export.flows.find((r) => r.flow === f)!.label
    expect(label("interview")).toBe("pass")
    expect(label("manager")).toBe("fixture")
    expect(label("lifecycle")).toBe("timeout")
    expect(label("completion")).toBe("partial")
    expect(label("amendment")).toBe("partial")
    expect(result.export.labels.pass).toBe(1)
    // The assert is on the EXPORT's completeness and honesty, not on every flow passing.
    expect(validateExport(result.export)).toEqual([])
    expect(h.emitted.summary[0]).toContain("timeout")
  })

  test("a changed release or artifact hash invalidates the cache instead of reusing a stale record", async () => {
    const h = harness()
    await runDogfood(h.deps())
    h.ran.length = 0
    await runDogfood({ ...h.deps(), identity: async () => ({ release: { ...release, artifacts: { "server.ts": "CHANGED" } }, serving, selections }) })
    expect(h.ran).toEqual([...FLOWS])
    h.ran.length = 0
    const stale = await runDogfood({ ...h.deps(), identity: async () => ({ release: { ...release, sha: "b".repeat(40) }, serving, selections }) })
    expect(stale.results.every((r) => !r.reused)).toBe(true)
    expect(h.ran).toEqual([...FLOWS])
  })

  test("a DIFFERENT serving engine invalidates the whole cache - a restarted server is not the same engine", async () => {
    const h = harness()
    await runDogfood(h.deps())
    h.ran.length = 0
    const other = await runDogfood({ ...h.deps(), identity: async () => ({ release, serving: { ...serving, pid: 9999 }, selections }) })
    // nothing is reused from the engine that produced the records
    expect(h.ran).toEqual([...FLOWS])
    expect(other.results.every((r) => !r.reused)).toBe(true)
    expect(other.export.flows.every((f) => f.serving.pid === 9999)).toBe(true)
  })

  test("a stale record from another engine with no fresh verdict is labelled stale-cache BY NAME, never a partial or a pass", async () => {
    const h = harness()
    await runDogfood(h.deps())
    const empty = { ownerMessages: [], forms: [], toolCalls: [], results: [] }
    const result = await runDogfood({
      ...h.deps(),
      runFlow: async (): Promise<FlowRun> => ({ exit: 1, ms: 1, requestIds: [], readCoordinates: [], raw: empty }),
      identity: async () => ({ release, serving: { ...serving, pid: 9999 }, selections }),
    })
    expect(result.export.flows.every((f) => f.label === "stale-cache")).toBe(true)
    expect(result.export.flows[0]!.labelReason).toContain("serving pid")
    expect(result.export.labels["stale-cache"]).toBe(5)
  })
})
