import { describe, expect, test } from "bun:test"
import {
  cacheKey,
  cacheMismatch,
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
    const empty = classify({ exit: 0, raw: { ownerMessages: [], forms: [], toolCalls: [], results: [] } })
    expect(empty.label).toBe("partial")
    expect(empty.reason).toContain("no raw interaction")
  })

  test("a pass is never claimed for a fixture, a timeout or an empty interaction", () => {
    for (const input of [
      { exit: 0, fixture: true, raw },
      { exit: 0, timedOut: true, raw },
      { exit: 0, raw: { ownerMessages: [], forms: [], toolCalls: [], results: [] } },
      { exit: 2, raw },
    ])
      expect(classify(input).label).not.toBe("pass")
    // ...but a flow that legitimately asked no form and preserved tool calls still passes
    expect(classify({ exit: 0, raw: { ...raw, forms: [] } }).label).toBe("pass")
  })

  test("a start-up crash is an incomplete flow with its cause, never a provider timeout", () => {
    const crash = classify({ exit: 1, raw, note: "Error: realpathSync ENOENT: no such file or directory" })
    expect(crash.label).toBe("partial")
    expect(crash.reason).toContain("realpathSync ENOENT")
    const provider = classify({ exit: 1, providerError: true, raw, note: "ECONNRESET" })
    expect(provider.label).toBe("timeout")
    expect(provider.reason).toContain("ECONNRESET")
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
    // The export explains its own engine attribution and label rules, so a
    // read-only verifier can quote the EXPORT rather than reverse-engineer code.
    expect(md).toContain("Which serving engine each flow ran against")
    expect(md).toContain("How each label is assigned")
    expect(md).toContain(`manager: ran against serving engine pid 4242 at location \`/tmp/qa\``)
  })

  test("the export lives in both places, and the cache key binds the release, the artifact hashes AND the serving engine", () => {
    const paths = exportPaths("0.5.1", "a".repeat(40))
    expect(paths.summary).toBe("docs/research/real-model-dogfood/0.5.1.md")
    expect(paths.index).toBe("docs/research/real-model-dogfood/0.5.1.json")
    expect(paths.rawDir.startsWith(".opencode/dogfood/")).toBe(true)
    expect(cacheKey(release, serving)).toBe(cacheKey({ ...release }, { ...serving }))
    expect(cacheKey(release, serving)).not.toBe(cacheKey({ ...release, sha: "b".repeat(40) }, serving))
    expect(cacheKey(release, serving)).not.toBe(cacheKey({ ...release, artifacts: { "server.ts": "CHANGED" } }, serving))
    // the engine is part of the key: a restarted or replaced server is a different key
    expect(cacheKey(release, serving)).not.toBe(cacheKey(release, { ...serving, pid: 9999 }))
    expect(cacheKey(release, serving)).not.toBe(cacheKey(release, { ...serving, location: "/elsewhere" }))
    expect(cacheKey(release, serving)).not.toBe(cacheKey(release, { ...serving, endpoint: "http://other:1" }))
  })

  test("cacheMismatch names the exact reason a stored record cannot be reused", () => {
    const rec = record("interview")
    expect(cacheMismatch(rec, release, serving)).toBeUndefined()
    expect(cacheMismatch(rec, release, { ...serving, pid: 9999 })).toContain("serving pid 4242")
    expect(cacheMismatch(rec, release, { ...serving, pid: 9999 })).toContain("this engine is 9999")
    expect(cacheMismatch(rec, release, { ...serving, location: "/elsewhere" })).toContain("/elsewhere")
    expect(cacheMismatch(rec, release, { ...serving, endpoint: "http://other:1" })).toContain("endpoint")
    expect(cacheMismatch(rec, { ...release, sha: "b".repeat(40) }, serving)).toContain("not")
    expect(cacheMismatch(rec, { ...release, artifacts: { "server.ts": "C" } }, serving)).toContain("artifact hashes changed")
  })
})
