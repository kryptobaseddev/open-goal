import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  HARNESS_NAMES,
  OPENCODE_ADAPTER,
  TICK_CAPABILITIES,
  adapterFor,
  capabilityList,
  isHarnessAdapter,
  tickAdapter,
  type HarnessAdapter,
} from "../../src/engine/harness"
import { GoalApp } from "../../src/server/app"

// v0.10.0 C1 - one HarnessAdapter interface, implemented by the OpenCode
// in-process path and the CLEO tick. These tests hold the interface and its
// capability model to their own claim: a declared capability must have a surface
// that backs it, and the two paths must be the same shape with honest differences.

const tick = tickAdapter({ CLEO_HOOK_PROVIDER: "claude-code" })

/** Every surface member the interface requires, proven by calling it. */
function surfaces(adapter: HarnessAdapter) {
  return {
    admission: adapter.admission(),
    continuation: adapter.continuation("continue", "keep going"),
    events: adapter.events(),
    forms: adapter.forms,
    verification: adapter.verification,
  }
}

describe("the HarnessAdapter seam (C1)", () => {
  test("both paths are one interface, with identity and capabilities", () => {
    for (const adapter of [OPENCODE_ADAPTER, tick]) {
      expect(isHarnessAdapter(adapter)).toBe(true)
      const identity = adapter.identity()
      expect(HARNESS_NAMES).toContain(identity.name)
      expect(identity.name).toBe(adapter.name)
      expect(typeof adapter.capabilities).toBe("object")
      expect(Object.values(adapter.capabilities).every((value) => typeof value === "boolean")).toBe(true)
    }
  })

  test("the in-process path declares a version and the capability list it can deliver", () => {
    const identity = OPENCODE_ADAPTER.identity({ version: "0.10.0" })
    expect(identity).toEqual({ name: "opencode", version: "0.10.0", capabilities: capabilityList(OPENCODE_ADAPTER.capabilities) })
    // An engine that does not know its version says so rather than inventing one.
    expect(OPENCODE_ADAPTER.identity().version).toBeNull()
    expect(identity.capabilities).toContain("tools")
    expect(identity.capabilities).toContain("forms")
    expect(identity.capabilities).toContain("verifier")
    expect(identity.capabilities).toContain("tui")
  })

  test("the tick declares a name only: no version and no capability list from CLEO", () => {
    // harness-identity A1: the dispatcher knows the provider, not the version or
    // the capability set. Null is the honest answer; an empty array would claim
    // "knows it can do nothing", which is a different statement.
    expect(tick.identity()).toEqual({ name: "claude", version: null, capabilities: null })
  })

  test("the OpenCode continuation is the same note it always sent", () => {
    const surface = OPENCODE_ADAPTER.continuation("continue", "<goal_turn>keep going</goal_turn>")
    expect(surface).toEqual({ kind: "session-prompt", tail: "continue", reason: "<goal_turn>keep going</goal_turn>" })
  })

  test("the tick continuation is CLEO's stop-block payload, built in one place", () => {
    const surface = tick.continuation("continue", "keep going")
    expect(surface.kind).toBe("stop-block")
    if (surface.kind !== "stop-block") throw new Error("unreachable")
    expect(JSON.parse(surface.payload)).toEqual({ decision: "block", reason: "keep going" })
  })

  test("the tick is owner-admitted and host-only; the in-process path starts and verifies", () => {
    expect(OPENCODE_ADAPTER.admission().kind).toBe("in-process")
    expect(OPENCODE_ADAPTER.verification.kind).toBe("verifier-child")
    const owner = tick.admission()
    expect(owner.kind).toBe("owner-only")
    if (owner.kind !== "owner-only") throw new Error("unreachable")
    expect(owner.reason).toContain("CLEO starts the goal")
    expect(tick.verification.kind).toBe("host-only")
  })

  // The invariant that makes the model worth having: a `true` capability always
  // has a surface behind it, and a `false` one never has a surface pretending
  // otherwise. This is what "declares only what it can deliver" means in code.
  test("every declared capability is backed by a surface, for every named harness", () => {
    for (const name of HARNESS_NAMES) {
      const adapter = adapterFor(name)
      const s = surfaces(adapter)
      expect(isHarnessAdapter(adapter)).toBe(true)
      expect(adapter.name).toBe(name)
      expect(adapter.identity().name).toBe(name)
      expect(adapter.capabilities.start).toBe(s.admission.kind === "in-process")
      expect(adapter.capabilities.events).toBe(s.events.kind === "session-events")
      expect(adapter.capabilities.forms).toBe(s.forms !== null)
      expect(adapter.capabilities.verifier).toBe(s.verification.kind === "verifier-child")
      expect(adapter.capabilities.continuation).toBe(true)
      expect(s.continuation.reason).toBe("keep going")
      // Declared differences, not accidental ones.
      expect(adapter.capabilities.tui).toBe(name === "opencode")
      expect(adapter.capabilities.steering).toBe(name === "opencode")
      expect(adapter.capabilities.tools).toBe(name === "opencode")
      expect(adapter.capabilities.version).toBe(name === "opencode")
      expect(adapter.capabilities.transcript).toBe(name !== "opencode")
    }
  })

  test("the constructed engine holds the in-process adapter, and refuses one that cannot admit", async () => {
    // C1 says "when the engine is constructed". The interface tests above prove
    // the shapes; this proves the object the engine actually holds is the seam,
    // and that a tick adapter cannot be smuggled into the in-process engine.
    const root = mkdtempSync(join(tmpdir(), "ocg-adapter-seam-"))
    try {
      const ctx = { location: { directory: root }, options: {} } as any
      const app = new GoalApp(ctx)
      expect(app.adapter).toBe(OPENCODE_ADAPTER)
      expect(isHarnessAdapter(app.adapter)).toBe(true)
      const tickApp = new GoalApp(ctx, tickAdapter({ CLEO_HOOK_PROVIDER: "claude-code" }))
      await expect(tickApp.start()).rejects.toThrow("cannot admit a goal into the in-process engine")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a harness without a surface never claims the capability", () => {
    // Named explicitly: these are the three the tick genuinely cannot do, and the
    // three a future harness must not inherit by accident.
    for (const capability of ["forms", "verifier", "tui"] as const) {
      expect(TICK_CAPABILITIES[capability]).toBe(false)
      for (const name of HARNESS_NAMES.filter((n) => n !== "opencode")) expect(adapterFor(name).capabilities[capability]).toBe(false)
    }
  })
})
