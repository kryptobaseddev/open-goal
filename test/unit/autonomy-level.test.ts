import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { parseContract } from "../../src/contract/parse"
import { renderSystemBlock } from "../../src/contract/render"
import { AUTONOMY_LEVELS, AUTONOMY_LEVEL_POLICY, type Autonomy } from "../../src/contract/types"
import { continuationContractYaml } from "../../src/engine/continue-work"
import { loopStop } from "../../src/engine/loop-stop"
import { nextWork } from "../../src/engine/next-work"
import { policyAllows, classifyChange } from "../../src/engine/policy"

// T170 — the owner-set autonomy level is a CEILING, never a grant.
//
// `standard` removes the routine pauses named in T170#AC2 (a stalled-but-active
// run continues; the rest of AC2 is already unconditional in the host) while
// every safety stop in T170#AC3 remains. An explicit flag may narrow a level;
// it can never widen it, and no level changes the legacy (absent) behaviour.

const valid = await Bun.file(join(import.meta.dir, "..", "fixtures", "valid.goal.yaml")).text()
const withAutonomy = (line: string) => `${valid}\n${line}\n`
const autonomyOf = (line: string) => parseContract(withAutonomy(line)).contract!.autonomy
const errors = (line: string) => parseContract(withAutonomy(line)).issues.filter((i) => i.level === "error").map((i) => `${i.path}: ${i.message}`)
const warnings = (line: string) => parseContract(withAutonomy(line)).issues.filter((i) => i.level === "warning").map((i) => `${i.path}: ${i.message}`)

const LEGACY: Autonomy = { questions: "defer", on_user_message: "steer", on_interrupt: "pause", amend: [], on_stall: "pause" }

describe("T170 autonomy.level", () => {
  test("absent keeps today's behaviour byte-for-byte (no level key, stall pauses, no self-amendment)", () => {
    expect(autonomyOf("")).toEqual(LEGACY)
    expect("level" in autonomyOf("")).toBe(false)
  })

  test("standard is the documented no-routine-pause default", () => {
    expect(autonomyOf("autonomy: {level: standard}")).toEqual({
      ...LEGACY, level: "standard", on_stall: "continue", amend: ["timeout", "recover"],
    })
    expect(AUTONOMY_LEVEL_POLICY.standard).toEqual({ on_stall: "continue", amend: ["timeout", "recover"] })
  })

  test("conservative is exactly today's defaults, named", () => {
    expect(autonomyOf("autonomy: {level: conservative}")).toEqual({ ...LEGACY, level: "conservative" })
  })

  test("full adds only the reversible budget/plan classes; it still cannot touch criteria, checks or the policy", () => {
    expect(autonomyOf("autonomy: {level: full}")).toEqual({
      ...LEGACY, level: "full", on_stall: "continue", amend: ["timeout", "budget", "plan", "recover"],
    })
  })

  test("an explicit flag may narrow a level", () => {
    expect(autonomyOf("autonomy: {level: standard, on_stall: pause}").on_stall).toBe("pause")
    expect(autonomyOf("autonomy: {level: standard, amend: [timeout]}").amend).toEqual(["timeout"])
    expect(autonomyOf("autonomy: {level: full, amend: [timeout, recover]}").amend).toEqual(["timeout", "recover"])
  })

  test("an explicit flag can never widen a level, and the narrowing is named as a warning", () => {
    const conservative = autonomyOf("autonomy: {level: conservative, on_stall: continue, amend: [timeout]}")
    expect(conservative.on_stall).toBe("pause")
    expect(conservative.amend).toEqual([])
    const w = warnings("autonomy: {level: conservative, on_stall: continue, amend: [timeout]}").join("\n")
    expect(w).toContain(`"timeout" is outside autonomy.level conservative`)
    expect(w).toContain(`autonomy.level conservative keeps the stall pause`)

    // A level never adds a class the code does not know is safe (criteria/checks/policy are not classes at all).
    expect(autonomyOf("autonomy: {level: full, amend: [plan]}").amend).toEqual(["plan"])
  })

  test("an unknown level is an error, not a silent fallback", () => {
    expect(errors("autonomy: {level: wild}")).toEqual([`autonomy.level: must be one of ${AUTONOMY_LEVELS.join(", ")}`])
  })

  test("changing the level is a policy change: blocked and never agent-applicable", () => {
    const prior = parseContract(valid).contract!
    const next = parseContract(withAutonomy("autonomy: {level: full}")).contract!
    const change = classifyChange(prior, next)
    expect(change.blocked.join()).toContain("autonomy policy")
    expect(policyAllows(["timeout", "budget", "plan", "recover"], change).ok).toBe(false)
  })

  test("every level leaves the AC3 safety stops in force", () => {
    for (const level of AUTONOMY_LEVELS) {
      const autonomy = autonomyOf(`autonomy: {level: ${level}}`)
      // The level is data for the run loop; the safety stops read no policy.
      expect(autonomy.level).toBe(level)
      expect(loopStop({ currentProject: "/p", humanCriterionPending: true })).toMatchObject({ stop: true, code: "human" })
      expect(loopStop({ currentProject: "/p", blocker: "missing key" })).toMatchObject({ stop: true, code: "blocker" })
      expect(loopStop({ currentProject: "/p", outwardActRequired: true })).toMatchObject({ stop: true, code: "outward" })
      expect(nextWork({ candidates: [{ source: "cleo", project: "/p", taskId: "T1", title: "work" }], currentProject: "/p", outwardActRequired: true, announce: {}, now: 0, cooldownMs: 1 }))
        .toMatchObject({ kind: "stop", code: "outward" })
    }
  })

  test("the level is rendered for the worker; a legacy contract renders exactly as before", () => {
    const legacy = parseContract(valid).contract!
    const standard = parseContract(withAutonomy("autonomy: {level: standard}")).contract!
    const lock = "a".repeat(64)
    expect(renderSystemBlock(legacy, lock)).not.toContain("Autonomy level")
    const rendered = renderSystemBlock(standard, lock)
    expect(rendered).toContain("Autonomy level (owner-set): standard")
    expect(rendered).toContain("Human criteria, outward/destructive acts, real blockers and contract or oracle changes still stop and ask")
    expect(rendered).toBe(renderSystemBlock(standard, lock)) // byte-stable within a run
  })

  test("a continuation contract carries the level and re-parses to the same ceiling", () => {
    const autonomy = autonomyOf("autonomy: {level: standard}")
    const yaml = continuationContractYaml({
      slug: "cleo-t170", sourceSlug: "demo", autonomy,
      task: { id: "T170", title: "Autonomy defaults", description: "", acceptance: ["no routine pause"] },
    })
    expect(yaml).toContain("\n  level: standard\n")
    const parsed = parseContract(yaml, { slug: "cleo-t170" })
    expect(parsed.issues.filter((i) => i.level === "error")).toEqual([])
    expect(parsed.contract!.autonomy.level).toBe("standard")
    expect(parsed.contract!.autonomy.on_stall).toBe("continue")
    expect(parsed.contract!.autonomy.amend).toEqual(["timeout", "recover"])
  })
})
