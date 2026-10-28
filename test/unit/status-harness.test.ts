import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { goalStatus } from "../../src/cli/status"
import { parseContract } from "../../src/contract/parse"
import { opencodeIdentity } from "../../src/engine/harness-identity"
import { initialRun } from "../../src/engine/state"
import { Store } from "../../src/engine/store"

// C2 — `cleo-goal status --json` reports the harness when the run recorded one,
// and a run written before the field existed still parses as schemaVersion 1.
// The field is additive: no schema bump, no required key, no change to any
// existing field.

const scratch = mkdtempSync(join(tmpdir(), "ocgoal-status-harness-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const CONTRACT = `schema: goal/v1\nid: demo\ntitle: Demo goal\nintent:\n  verbatim: "x"\noutcome: y\nnon_goals: [z]\ncriteria:\n  - id: C1\n    statement: the file exists\n    check: {kind: file, path: f}\n`

/** A project with a live run; `harness` absent writes the pre-0.9.5 shape. */
function project(name: string, harness: "present" | "absent") {
  const root = join(scratch, name)
  const store = new Store(root)
  mkdirSync(store.dir("demo"), { recursive: true })
  writeFileSync(store.contractPath("demo"), CONTRACT)
  const parsed = parseContract(CONTRACT, { slug: "demo" })
  const run = initialRun(parsed.contract!, {
    sessionID: "ses_x", runId: "r1", lock: parsed.lock, now: 1000,
    ...(harness === "present" ? { harness: opencodeIdentity("0.9.5") } : {}),
  })
  store.writeRun(run)
  return { root, store, runPath: join(store.dir("demo"), "run.json") }
}

describe("cleo-goal status --json reports the recorded harness (C2)", () => {
  test("a run with a harness exposes {name, version, capabilities[]} without a schema bump", () => {
    const { store } = project("present", "present")
    const status = goalStatus(store, 2000)
    expect(status.schemaVersion).toBe(1)
    expect(status.harness).toEqual({ name: "opencode", version: "0.9.5", capabilities: ["start", "continuation", "events", "tools", "forms", "verifier", "tui", "steering", "version"] })
    // the pre-existing contract is untouched
    expect(status).toMatchObject({ goal: "demo", runId: "r1", status: "running", title: "Demo goal" })
  })

  test("a run written before the field existed still parses as schemaVersion 1 and omits it", () => {
    const { store, runPath } = project("absent", "absent")
    // The exact old shape: no `harness` key at all, not `null`.
    const old = JSON.parse(readFileSync(runPath, "utf8"))
    expect("harness" in old).toBe(false)
    const status = goalStatus(store, 2000)
    expect(status.schemaVersion).toBe(1)
    expect("harness" in status).toBe(false)
    expect(status).toMatchObject({ goal: "demo", runId: "r1", status: "running", proven: 0, total: 1 })
  })

  test("both shapes round-trip through the published bin on plain Node", () => {
    if (!Bun.which("node")) return
    const bin = join(import.meta.dir, "../../dist/cli.js")
    for (const [name, expected] of [["present", true], ["absent", false]] as const) {
      const { root } = project(`bin-${name}`, name)
      const result = spawnSync("node", [bin, "status", "--json"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: scratch } })
      expect(result.status).toBe(0)
      const parsed = JSON.parse(result.stdout)
      expect(parsed.schemaVersion).toBe(1)
      expect("harness" in parsed).toBe(expected)
      if (expected) expect(parsed.harness).toMatchObject({ name: "opencode", version: "0.9.5" })
    }
  })
})
