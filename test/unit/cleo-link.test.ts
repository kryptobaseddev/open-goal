import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleoFacts, cleoHealth, cleoHealthReport, cleoLinkEvent, CLEO_INIT_COMMAND, CLEO_INSTALL_COMMAND, type Runner } from "../../src/engine/cleo-link"

// T027 — the CLEO link is optional and CLI-first: the CLI is authoritative
// when it answers in time, the project-context.json config is the fallback,
// a project without .cleo yields nothing (zero behavioural change), and no
// path ever touches .cleo/*.db.

const cliOk: Runner = async () => ({ stdout: JSON.stringify({ data: { projectId: "5f4ab735-ef8e" } }), exit: 0 })
const cliFails: Runner = async () => ({ stdout: "", exit: 1 })
const cliHangs: Runner = () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 50))

function withProject(setup: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "ocgoal-cleo-"))
  setup(root)
  return root
}

describe("CLEO link (T027)", () => {
  const dirs: string[] = []
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

  test("a project without .cleo has no linkage — nothing is recorded", async () => {
    const root = withProject(() => {})
    dirs.push(root)
    expect(await cleoFacts(root, cliOk)).toBeUndefined()
    expect(cleoLinkEvent(undefined)).toBeUndefined()
  })

  test("the CLI is authoritative when it answers", async () => {
    const root = withProject((r) => mkdirSync(join(r, ".cleo"), { recursive: true }))
    dirs.push(root)
    const facts = await cleoFacts(root, cliOk)
    expect(facts).toMatchObject({ source: "cli", projectId: "5f4ab735-ef8e" })
    expect(cleoLinkEvent(facts)).toMatchObject({ type: "cleo-linked", via: "cli", projectId: "5f4ab735-ef8e" })
  })

  test("a failing or hanging CLI degrades to the project-context.json signal", async () => {
    const root = withProject((r) => {
      mkdirSync(join(r, ".cleo"), { recursive: true })
      writeFileSync(join(r, ".cleo", "project-context.json"), JSON.stringify({ schemaVersion: "1.0.0", detectedAt: "2026-10-02T23:22:33.004Z", projectTypes: ["unknown"] }))
    })
    dirs.push(root)
    for (const runner of [cliFails, cliHangs]) {
      const facts = await cleoFacts(root, runner, 100)
      expect(facts).toMatchObject({ source: "config", projectTypes: ["unknown"] })
      expect(cleoLinkEvent(facts)).toMatchObject({ type: "cleo-linked", via: "config", projectTypes: ["unknown"] })
    }
  })

  test("no path reads the CLEO database — only the CLI and the config file", async () => {
    const root = withProject((r) => {
      mkdirSync(join(r, ".cleo"), { recursive: true })
      writeFileSync(join(r, ".cleo", "project-context.json"), "{}")
    })
    dirs.push(root)
    const seen: Array<[string, string[]]> = []
    const recorder: Runner = async (command, args) => {
      seen.push([command, args])
      return { stdout: "", exit: 1 }
    }
    await cleoFacts(root, recorder)
    expect(seen).toEqual([["cleo", ["doctor", "project-identity"]]])
  })
})

// v0.5.0 — the CLEO health surface. Exactly three states, and the install/init
// command is OFFERED but never run: the probe only reads.
describe("CLEO health (v0.5.0)", () => {
  const dirs: string[] = []
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
  const version = async () => ({ stdout: JSON.stringify({ success: true, data: { version: "2026.10.17" } }), exit: 0 })
  const absent: Runner = () => Promise.reject(new Error("spawn cleo ENOENT"))

  test("no CLI: cli-absent, the install command is offered, nothing is run", async () => {
    const root = withProject(() => {})
    dirs.push(root)
    const seen: string[][] = []
    const recorder: Runner = async (_command, args) => {
      seen.push(args)
      return absent("cleo", args)
    }
    const health = await cleoHealth(root, recorder)
    expect(health.state).toBe("cli-absent")
    expect(health.cli.present).toBe(false)
    expect(health.workspace.present).toBe(false)
    expect(health.offer).toEqual({ kind: "install", command: CLEO_INSTALL_COMMAND, why: expect.any(String) })
    // only the version probe ran — no install, no init, no mutation
    expect(seen).toEqual([["--version"]])
    expect(cleoHealthReport(health)).toContain(CLEO_INSTALL_COMMAND)
  })

  test("CLI present, no .cleo workspace: uninitialized, the init command is offered", async () => {
    const root = withProject(() => {})
    dirs.push(root)
    const seen: string[][] = []
    const recorder: Runner = async (_command, args) => {
      seen.push(args)
      return version()
    }
    const health = await cleoHealth(root, recorder)
    expect(health.state).toBe("uninitialized")
    expect(health.cli).toEqual({ present: true, version: "2026.10.17" })
    expect(health.offer).toEqual({ kind: "init", command: CLEO_INIT_COMMAND, why: expect.any(String) })
    expect(seen).toEqual([["--version"]])
    expect(cleoHealthReport(health)).toContain(CLEO_INIT_COMMAND)
  })

  test("CLI present and initialized: initialized with the project id, no offer", async () => {
    const root = withProject((r) => mkdirSync(join(r, ".cleo"), { recursive: true }))
    dirs.push(root)
    const recorder: Runner = async (_command, args) =>
      args[0] === "--version" ? version() : { stdout: JSON.stringify({ success: true, data: { trackedId: "5f4ab735-ef8e-4c8b-8d64-1eb3021ed2ff" } }), exit: 0 }
    const health = await cleoHealth(root, recorder)
    expect(health.state).toBe("initialized")
    expect(health.projectId).toBe("5f4ab735-ef8e-4c8b-8d64-1eb3021ed2ff")
    expect(health.offer).toBeUndefined()
    expect(cleoHealthReport(health)).toContain("initialized")
  })

  test("a project with no .cleo and no CLI keeps today's behaviour: cleoHealth offers only, cleoFacts records nothing", async () => {
    const root = withProject(() => {})
    dirs.push(root)
    expect(await cleoHealth(root, absent)).toMatchObject({ state: "cli-absent", workspace: { present: false } })
    expect(cleoLinkEvent(await cleoFacts(root, absent))).toBeUndefined()
  })

  test("a hanging CLI probe degrades to cli-absent instead of throwing", async () => {
    const root = withProject((r) => mkdirSync(join(r, ".cleo"), { recursive: true }))
    dirs.push(root)
    const hangs: Runner = () => new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 20))
    expect(await cleoHealth(root, hangs)).toMatchObject({ state: "cli-absent", cli: { present: false } })
  })
})
