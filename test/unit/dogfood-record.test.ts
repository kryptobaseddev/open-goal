import { describe, expect, test } from "bun:test"
import {
  cacheKey,
  classify,
  exportPaths,
  FLOWS,
  renderMarkdown,
  summarize,
  validateExport,
  type DogfoodExport,
  type FlowId,
  type FlowRecord,
  type ReleaseIdentity,
} from "../../src/engine/dogfood-record"

// v0.5.1 - the exact-release dogfood record and its readable export (CLEO T102).
// The point of these tests is the HONESTY rule: a flow that was a fixture, a
// timeout, a stale cache or a partial success is never presented as a pass.

const release: ReleaseIdentity = { version: "0.5.1", ref: "v0.5.1", sha: "a".repeat(40), artifacts: { "server.ts": "h1", "tui.tsx": "h2" } }
const serving = { pid: 4242, location: "/tmp/qa" }
const selections = { model: "deepseek/deepseek-flash", agent: "build" }
const raw = {
  ownerMessages: ["do the thing"],
  forms: [{ id: "f1", question: "ok?", answer: "yes" }],
  toolCalls: [{ name: "write", result: "ok" }],
  results: ["status: ok"],
}
const record = (flow: FlowId, label: FlowRecord["label"] = "pass"): FlowRecord => ({
  flow,
  release,
  serving,
  selections,
  requestIds: ["req-1"],
  readCoordinates: [{ path: "qa-evidence/context.json", offset: 0, limit: 64 }],
  label,
  labelReason: "r",
  ms: 10,
  startedAt: "2026-10-16T00:00:00.000Z",
  raw,
})
const exp = (flows: FlowRecord[]): DogfoodExport => ({ schema: "dogfood-export/v1", release, serving, selections, generatedAt: "2026-10-16T00:00:00.000Z", flows, labels: summarize(flows) })

describe("dogfood record and export (v0.5.1)", () => {
  test("classify labels what actually happened, worst case first", () => {
    expect(classify({ exit: 0, raw }).label).toBe("pass")
    expect(classify({ exit: 0, timedOut: true, raw }).label).toBe("timeout")
    expect(classify({ exit: 0, providerError: true, raw }).label).toBe("timeout")
    expect(classify({ exit: 1, raw }).label).toBe("partial")
    expect(classify({ exit: 0, fixture: true, raw }).label).toBe("fixture")
    expect(classify({ exit: 0, staleCache: true, raw }).label).toBe("stale-cache")
    const empty = classify({ exit: 0, raw: { ownerMessages: [], forms: [], toolCalls: [], results: ["ok"] } })
    expect(empty.label).toBe("partial")
    expect(empty.reason).toContain("ownerMessages")
  })

  test("a pass is never claimed for a fixture, a timeout or an empty interaction", () => {
    for (const input of [
      { exit: 0, fixture: true, raw },
      { exit: 0, timedOut: true, raw },
      { exit: 0, raw: { ...raw, forms: [] } },
      { exit: 2, raw },
    ])
      expect(classify(input).label).not.toBe("pass")
  })

  test("validateExport names every required field and every missing flow", () => {
    expect(validateExport(exp(FLOWS.map((f) => record(f))))).toEqual([])
    expect(validateExport(exp([record("interview")]))).toContain("flow manager has no record")
    expect(validateExport(exp(FLOWS.map((f) => ({ ...record(f), requestIds: [] }))))).toContain("flow interview is labelled pass but has no request id")
    expect(validateExport(exp(FLOWS.map((f) => ({ ...record(f), readCoordinates: [] }))))).toContain("flow interview is labelled pass but has no bounded read coordinate")
    expect(validateExport(exp(FLOWS.map((f) => ({ ...record(f), release: { ...release, sha: "b".repeat(40) } })))).some((p) => p.includes("was recorded against"))).toBe(true)
    expect(validateExport({ ...exp([]), selections: { model: "", agent: "" } })).toContain("selections.model is empty")
    // An honest failure with nothing recorded is a VALID export entry: its label says what happened.
    expect(validateExport(exp(FLOWS.map((f) => ({ ...record(f, "timeout"), requestIds: [], readCoordinates: [] }))))).toEqual([])
    // ...but a PASS with no evidence is not.
    expect(validateExport(exp(FLOWS.map((f) => ({ ...record(f, "pass"), requestIds: [] }))))).toContain("flow interview is labelled pass but has no request id")
  })

  test("renderMarkdown carries the release, the serving identity, the labels and the artifact hashes", () => {
    const md = renderMarkdown(exp(FLOWS.map((f) => record(f, f === "manager" ? "timeout" : "pass"))))
    expect(md).toContain("v0.5.1")
    expect(md).toContain(release.sha)
    expect(md).toContain("pid 4242")
    expect(md).toContain("timeout 1")
    expect(md).toContain("server.ts")
    expect(md).toContain("does NOT claim")
    expect(md).toContain("agent `build`")
  })

  test("the export lives in both places, and the cache key binds the release sha and the artifact hashes", () => {
    const paths = exportPaths("0.5.1", "a".repeat(40))
    expect(paths.summary).toBe("docs/research/real-model-dogfood/0.5.1.md")
    expect(paths.index).toBe("docs/research/real-model-dogfood/0.5.1.json")
    expect(paths.rawDir.startsWith(".opencode/dogfood/")).toBe(true)
    expect(cacheKey(release)).toBe(cacheKey({ ...release }))
    expect(cacheKey(release)).not.toBe(cacheKey({ ...release, sha: "b".repeat(40) }))
    expect(cacheKey(release)).not.toBe(cacheKey({ ...release, artifacts: { "server.ts": "CHANGED" } }))
  })
})
