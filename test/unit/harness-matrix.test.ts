import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tick, type TickStore } from "../../src/engine/tick"
import { initialRun, type RunState } from "../../src/engine/state"
import { parseContract } from "../../src/contract/parse"
import { verifyClaim } from "../../src/verify/pipeline"
import {
  CLEO_HOOK_PROVIDER,
  HARNESS_NAMES,
  TICK_CAPABILITIES,
  adapterFor,
  harnessFromHookProvider,
  tickAdapter,
  type HarnessCapabilities,
  type HarnessName,
} from "../../src/engine/harness"

// v0.10.0 C5 - the capability matrix and the dispatcher signal. The table below
// is the same table as docs/research/harness-adapter.md; if the note and the code
// ever disagree, this file fails. Codex/Hermes/Kimi are install-and-tick smoke
// cases (assumption A3): they get the tick's capabilities and no parity claim.

const MATRIX: Record<HarnessName, HarnessCapabilities> = {
  opencode: { start: true, continuation: true, events: true, tools: true, forms: true, verifier: true, tui: true, steering: true, transcript: false, version: true },
  claude: { start: false, continuation: true, events: false, tools: false, forms: false, verifier: false, tui: false, steering: false, transcript: true, version: false },
  codex: { start: false, continuation: true, events: false, tools: false, forms: false, verifier: false, tui: false, steering: false, transcript: true, version: false },
  hermes: { start: false, continuation: true, events: false, tools: false, forms: false, verifier: false, tui: false, steering: false, transcript: true, version: false },
  kimi: { start: false, continuation: true, events: false, tools: false, forms: false, verifier: false, tui: false, steering: false, transcript: true, version: false },
  unknown: { start: false, continuation: true, events: false, tools: false, forms: false, verifier: false, tui: false, steering: false, transcript: true, version: false },
}

describe("the harness capability matrix (C5)", () => {
  test("every named harness matches the documented table exactly", () => {
    for (const name of HARNESS_NAMES) expect({ name, capabilities: adapterFor(name).capabilities }).toEqual({ name, capabilities: MATRIX[name] })
  })

  test("only OpenCode gets tools, forms, the verifier child, steering and the TUI", () => {
    for (const name of HARNESS_NAMES) {
      const caps = adapterFor(name).capabilities
      expect(caps.forms).toBe(name === "opencode")
      expect(caps.verifier).toBe(name === "opencode")
      expect(caps.tui).toBe(name === "opencode")
      expect(caps.tools).toBe(name === "opencode")
      expect(caps.steering).toBe(name === "opencode")
    }
  })

  test("CLEO_HOOK_PROVIDER is the only signal, and an unknown value stays unknown", () => {
    expect(harnessFromHookProvider("claude-code")).toBe("claude")
    expect(harnessFromHookProvider("codex")).toBe("codex")
    expect(harnessFromHookProvider(undefined)).toBe("unknown")
    expect(harnessFromHookProvider("")).toBe("unknown")
    // Hermes and Kimi have no dispatcher value today (CLEO T13884 sets only the
    // two above). Naming them here would be a guess, so they stay unknown.
    expect(harnessFromHookProvider("hermes")).toBe("unknown")
    expect(harnessFromHookProvider("kimi")).toBe("unknown")
    expect(harnessFromHookProvider("claude")).toBe("unknown")
    expect(harnessFromHookProvider("some-harness")).toBe("unknown")
  })

  test("the tick records the declared harness and marks forms/verifier absent", async () => {
    const seen: Array<{ provider: string | undefined; name: HarnessName }> = []
    for (const [provider, expected] of [
      [undefined, "unknown"],
      ["claude-code", "claude"],
      ["codex", "codex"],
      ["other", "unknown"],
    ] as const) {
      if (provider === undefined) delete process.env[CLEO_HOOK_PROVIDER]
      else process.env[CLEO_HOOK_PROVIDER] = provider
      try {
        const { store, runs } = storeOf(liveRun())
        const run = await tick({ root: project(), store })
        expect(run.harness).toBe(expected)
        expect(run.log.join(" ")).toContain(`harness ${expected}`)
        // The run SHALL record it: the identity on run.json is the declaration,
        // name-only (CLEO tells the dispatcher nothing else) — never inferred.
        expect(runs.get(SLUG)!.harness).toEqual({ name: expected, version: null, capabilities: null })
        seen.push({ provider, name: run.harness })
      } finally {
        delete process.env[CLEO_HOOK_PROVIDER]
      }
    }
    expect(seen).toEqual([
      { provider: undefined, name: "unknown" },
      { provider: "claude-code", name: "claude" },
      { provider: "codex", name: "codex" },
      { provider: "other", name: "unknown" },
    ])
    // The capability set the tick declares alongside that identity.
    expect(TICK_CAPABILITIES.forms).toBe(false)
    expect(TICK_CAPABILITIES.verifier).toBe(false)
  })

  test("the tick fails a verifier criterion closed instead of pretending to verify (T147)", async () => {
    // The matrix says the tick has no verifier child. A goal that asks for one
    // must therefore fail closed with a stated reason — never a pass invented
    // from the host checks, and never a silently skipped criterion.
    const root = project()
    writeFileSync(join(root, "proof.txt"), "status: ok\n")
    const parsed = parseContract(VERIFIER_GOAL, { slug: VERIFIER_SLUG })
    const state: RunState = {
      ...initialRun(parsed.contract!, { sessionID: "ses_x", runId: "r1", lock: parsed.lock, now: 1 }),
      turn: 1,
      status: "running",
      claim: { at: 1, turn: 1, summary: "wrote proof.txt", evidence: { C1: "proof.txt exists" } },
    }
    const { store, runs } = storeOf(state, parsed.contract!, VERIFIER_GOAL)
    const result = await tick({
      root,
      store,
      harness: tickAdapter({ [CLEO_HOOK_PROVIDER]: "claude-code" }),
      verify: (run, contract, text) => verifyClaim(contract, run, { root, contractText: text }),
      now: 2,
    })
    // A host verdict, not a completion: the session continues so the agent can fix it.
    expect(JSON.parse(result.stdout).decision).toBe("block")
    const live = runs.get(VERIFIER_SLUG)!
    expect(live.status).toBe("running")
    expect(live.criteria.C1?.status).toBe("pass")
    expect(live.criteria.C2?.status).toBe("fail")
    expect(live.criteria.C2?.detail).toContain("verifier unavailable")
    expect(live.verdict?.passed).toBe(false)
  })
})

// ── fixtures: a real temp goal project, driven through the injected store

const SLUG = "demo"
const GOAL = `schema: goal/v1\nid: ${SLUG}\ntitle: demo goal\nintent:\n  verbatim: "x"\noutcome: y\nnon_goals: [z]\ncriteria:\n  - id: C1\n    statement: s\n    check: {kind: file, path: proof.txt}\nplan:\n  - {id: S1, title: first, proves: [C1]}\n`
const contract = parseContract(GOAL, { slug: SLUG }).contract!
// A goal whose second criterion needs the independent verifier child the tick
// does not have.
const VERIFIER_SLUG = "tick-verifier"
const VERIFIER_GOAL = `schema: goal/v1\nid: ${VERIFIER_SLUG}\ntitle: a goal that asks for the verifier\nintent:\n  verbatim: "x"\noutcome: y\nnon_goals: [z]\ncriteria:\n  - id: C1\n    statement: proof.txt SHALL exist\n    check: {kind: file, path: proof.txt}\n  - id: C2\n    statement: the work SHALL be independently confirmed\n    check: {kind: verifier, ask: "Does proof.txt prove the work?"}\n`
const dirs: string[] = []
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "ocg-harness-matrix-"))
  dirs.push(root)
  mkdirSync(join(root, ".opencode", "goals", SLUG), { recursive: true })
  return root
}

function liveRun(): RunState {
  return { ...initialRun(contract, { sessionID: "ses_x", runId: "r1", lock: "a".repeat(64), now: 1 }), turn: 3, status: "running" }
}

function storeOf(state: RunState, runContract = contract, text = GOAL) {
  const runs = new Map([[state.slug, state]])
  const store: TickStore = {
    slugs: () => [...runs.keys()],
    readRun: (slug) => runs.get(slug),
    writeRun: (next) => void runs.set(next.slug, { ...next }),
    readContract: () => ({ contract: runContract, text }),
    ledger: () => {},
    evidence: () => "evidence.json",
  }
  return { store, runs }
}
