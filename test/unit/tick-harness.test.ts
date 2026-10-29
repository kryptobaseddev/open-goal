import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseContract } from "../../src/contract/parse"
import { CLEO_HOOK_PROVIDER, dispatcherIdentity, harnessFromHookProvider, opencodeIdentity, type HarnessIdentity } from "../../src/engine/harness-identity"
import { initialRun, type RunState } from "../../src/engine/state"
import { tick, type TickStore } from "../../src/engine/tick"

// C3 — the Stop-dispatched tick records the harness CLEO declares in
// `CLEO_HOOK_PROVIDER`: claude-code -> claude, codex -> codex, anything else
// (including absent) -> unknown. It never guesses from the transcript and never
// invents a version or a capability set the dispatcher did not supply.

const SLUG = "demo"
const GOAL = `schema: goal/v1\nid: ${SLUG}\ntitle: demo goal\nintent:\n  verbatim: "x"\noutcome: y\nnon_goals: [z]\ncriteria:\n  - id: C1\n    statement: s\n    check: {kind: file, path: proof.txt}\nplan:\n  - {id: S1, title: first, proves: [C1]}\n`
const contract = parseContract(GOAL, { slug: SLUG }).contract!

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "ocg-tick-harness-"))
  dirs.push(root)
  mkdirSync(join(root, ".opencode", "goals", SLUG), { recursive: true })
  return root
}

function run(over: Partial<RunState> = {}): RunState {
  const base = initialRun(contract, { sessionID: "ses_x", runId: "r1", lock: "a".repeat(64), now: 1 })
  return { ...base, turn: 3, status: "running", ...over, counters: { noProgress: 0, failures: 0, ...(over.counters ?? {}) } }
}

function storeOf(state: RunState) {
  const runs = new Map<string, RunState>([[state.slug, state]])
  const events: Array<Record<string, unknown> & { type: string }> = []
  const store: TickStore = {
    slugs: () => [...runs.keys()],
    readRun: (slug) => runs.get(slug),
    writeRun: (s) => void runs.set(s.slug, { ...s }),
    readContract: (slug) => (runs.has(slug) ? { contract, text: GOAL } : undefined),
    ledger: (_slug, event) => void events.push(event),
    evidence: () => "evidence.json",
  }
  return { store, runs, events }
}

const harnessEvent = (events: Array<Record<string, unknown> & { type: string }>) => events.find((e) => e.type === "harness")

describe("the dispatcher names the harness (C3)", () => {
  test("CLEO_HOOK_PROVIDER=claude-code records harness claude, name-only", async () => {
    const state = run()
    const h = storeOf(state)
    const result = await tick({ root: project(), store: h.store, fingerprint: () => undefined, now: 10, env: { CLEO_HOOK_PROVIDER: "claude-code" } })
    expect(h.runs.get(SLUG)!.harness).toEqual({ name: "claude", version: null, capabilities: null })
    expect(harnessEvent(h.events)).toEqual({ type: "harness", name: "claude", version: null, capabilities: null, source: "tick" })
    expect(result.log.join(" ")).toContain("recorded harness claude")
  })

  test("CLEO_HOOK_PROVIDER=codex records harness codex", async () => {
    const h = storeOf(run())
    await tick({ root: project(), store: h.store, fingerprint: () => undefined, now: 10, env: { CLEO_HOOK_PROVIDER: "codex" } })
    expect(h.runs.get(SLUG)!.harness).toEqual({ name: "codex", version: null, capabilities: null })
    expect(harnessEvent(h.events)).toMatchObject({ name: "codex", source: "tick" })
  })

  test("no signal records unknown, and a transcript that says otherwise is not believed", async () => {
    const h = storeOf(run())
    // A Stop payload is harness-written data. It cannot rename the harness.
    const payload = JSON.stringify({ provider: "claude-code", harness: "claude", transcript_path: "/tmp/whatever.jsonl" })
    const result = await tick({ root: project(), store: h.store, payload, fingerprint: () => undefined, now: 10, env: {} })
    expect(h.runs.get(SLUG)!.harness).toEqual({ name: "unknown", version: null, capabilities: null })
    expect(result.log.join(" ")).toContain("no CLEO_HOOK_PROVIDER declared")
  })

  test("an unsupported provider is unknown, never the closest match", async () => {
    for (const value of ["gemini", "claude", "CLAUDE-CODE ", "cursor"]) {
      const h = storeOf(run())
      await tick({ root: project(), store: h.store, fingerprint: () => undefined, now: 10, env: { CLEO_HOOK_PROVIDER: value } })
      expect({ value, name: h.runs.get(SLUG)!.harness?.name }).toEqual({ value, name: "unknown" })
    }
    // the mapping itself, stated once
    expect(harnessFromHookProvider("claude-code")).toBe("claude")
    expect(harnessFromHookProvider("codex")).toBe("codex")
    expect(harnessFromHookProvider(undefined)).toBe("unknown")
    expect(harnessFromHookProvider("")).toBe("unknown")
    expect(harnessFromHookProvider("claude")).toBe("unknown")
  })

  test("a run that already carries its producer is never renamed by a later tick", async () => {
    const state = run({ harness: opencodeIdentity("0.9.5") })
    const h = storeOf(state)
    const result = await tick({ root: project(), store: h.store, fingerprint: () => undefined, now: 10, env: { CLEO_HOOK_PROVIDER: "codex" } })
    expect(h.runs.get(SLUG)!.harness).toEqual(opencodeIdentity("0.9.5"))
    expect(harnessEvent(h.events)).toBeUndefined()
    expect(result.log.join(" ")).toContain("keeping the producer")
  })

  test("the identity helpers describe the two paths, not a guess", () => {
    expect(dispatcherIdentity({})).toEqual({ name: "unknown", version: null, capabilities: null } satisfies HarnessIdentity)
    expect(dispatcherIdentity({ [CLEO_HOOK_PROVIDER]: "codex" })).toEqual({ name: "codex", version: null, capabilities: null })
    expect(opencodeIdentity("1.2.3")).toMatchObject({ name: "opencode", version: "1.2.3" })
  })
})
