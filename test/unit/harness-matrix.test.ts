import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tick, type TickStore } from "../../src/engine/tick"
import { initialRun, type RunState } from "../../src/engine/state"
import { parseContract } from "../../src/contract/parse"
import {
  CLEO_HOOK_PROVIDER,
  HARNESS_NAMES,
  TICK_CAPABILITIES,
  adapterFor,
  harnessFromHookProvider,
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
        const run = await tick({ root: project(), store: storeOf(liveRun()).store })
        expect(run.harness).toBe(expected)
        expect(run.log.join(" ")).toContain(`harness ${expected}`)
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
})

// ── fixtures: a real temp goal project, driven through the injected store

const SLUG = "demo"
const GOAL = `schema: goal/v1\nid: ${SLUG}\ntitle: demo goal\nintent:\n  verbatim: "x"\noutcome: y\nnon_goals: [z]\ncriteria:\n  - id: C1\n    statement: s\n    check: {kind: file, path: proof.txt}\nplan:\n  - {id: S1, title: first, proves: [C1]}\n`
const contract = parseContract(GOAL, { slug: SLUG }).contract!
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

function storeOf(state: RunState) {
  const runs = new Map([[state.slug, state]])
  const store: TickStore = {
    slugs: () => [...runs.keys()],
    readRun: (slug) => runs.get(slug),
    writeRun: (next) => void runs.set(next.slug, { ...next }),
    readContract: () => ({ contract, text: GOAL }),
    ledger: () => {},
    evidence: () => "evidence.json",
  }
  return { store, runs }
}
