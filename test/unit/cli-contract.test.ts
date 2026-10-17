import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { identity, InstallError, installProject } from "../../src/cli/install"
import { goalStatus } from "../../src/cli/status"
import { parseContract } from "../../src/contract/parse"
import { initialRun } from "../../src/engine/state"
import { Store } from "../../src/engine/store"

// The CLI contract CLEO parses (`cleo-goal status --json`, `install --project
// --json`, schemaVersion 1) and the published bin running on plain Node.

const scratch = mkdtempSync(join(tmpdir(), "ocgoal-cli-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const project = (name: string) => {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  return dir
}
const CONTRACT = `schema: goal/v1\nid: demo\ntitle: Demo goal\nintent:\n  verbatim: "x"\noutcome: y\nnon_goals: [z]\ncriteria:\n  - id: C1\n    statement: the file exists\n    check: {kind: file, path: f}\nbudget: {turns: 10}\n`

describe("cleo-goal status --json", () => {
  test("no goal: status none with every field present", () => {
    const status = goalStatus(new Store(project("empty")))
    expect(status).toMatchObject({ schemaVersion: 1, goal: null, runId: null, status: "none", criteria: [], proven: 0, total: 0, verdict: null, blocker: null })
  })

  test("a live run reports its criteria, budget and progress from the locked contract", () => {
    const root = project("live")
    const store = new Store(root)
    mkdirSync(store.dir("demo"), { recursive: true })
    writeFileSync(store.contractPath("demo"), CONTRACT)
    const parsed = parseContract(CONTRACT, { slug: "demo" })
    const run = initialRun(parsed.contract!, { sessionID: "ses_x", runId: "r1", lock: parsed.lock, now: 1000 })
    run.turn = 3
    run.criteria.C1 = { status: "pass", by: "host", detail: "exists", rejections: 0 }
    run.blocker = { key: "k", count: 2, reason: "stuck", lastTurn: 3 }
    store.writeRun(run)
    const status = goalStatus(store, 2000)
    expect(status).toMatchObject({
      schemaVersion: 1,
      goal: "demo",
      runId: "r1",
      title: "Demo goal",
      status: "running",
      turn: 3,
      reason: null,
      criteria: [{ id: "C1", statement: "the file exists", status: "pass", essential: true, invariant: false, by: "host", detail: "exists" }],
      proven: 1,
      total: 1,
      budget: { ratio: 0.3, parts: [{ name: "turns", used: 3, limit: 10 }] },
      verdict: null,
      blocker: { key: "k", count: 2, reason: "stuck" },
    })
  })
})

describe("cleo-goal install --project", () => {
  const read = (root: string) => JSON.parse(readFileSync(join(root, ".opencode/opencode.json"), "utf8"))

  test("installs, then is idempotent, and a dry run writes nothing", () => {
    const root = project("install")
    expect(installProject(root, "@cleocode/goal@0.9.0", { dryRun: true, home: scratch + "-home" }).action).toBe("dry-run")
    expect(existsSync(join(root, ".opencode"))).toBe(false)
    expect(installProject(root, "@cleocode/goal@0.9.0", { home: scratch + "-home" })).toMatchObject({ schemaVersion: 1, action: "installed", file: ".opencode/opencode.json", plugins: ["@cleocode/goal@0.9.0"] })
    expect(installProject(root, "@cleocode/goal@0.9.0", { home: scratch + "-home" }).action).toBe("already-present")
    expect(read(root)).toEqual({ plugins: ["@cleocode/goal@0.9.0"] })
  })

  test("replaces a git or older spec of this plugin in place, keeping its options and other keys", () => {
    const root = project("update")
    mkdirSync(join(root, ".opencode"))
    writeFileSync(join(root, ".opencode/opencode.json"), JSON.stringify({ theme: "x", plugins: ["other", ["github:kryptobaseddev/opencode-goal#v0.8.0", { a: 1 }], "@cleocode/goal@0.8.0"] }))
    expect(installProject(root, "@cleocode/goal@0.9.0", { home: scratch + "-home" }).action).toBe("updated")
    expect(read(root)).toEqual({ theme: "x", plugins: ["other", ["@cleocode/goal@0.9.0", { a: 1 }]] })
  })

  test("refuses the home directory, invalid JSON and a JSONC config, writing nothing", () => {
    const home = project("home")
    expect(() => installProject(home, "@cleocode/goal@0.9.0", { home })).toThrow(InstallError)
    expect(existsSync(join(home, ".opencode"))).toBe(false)
    const bad = project("bad")
    mkdirSync(join(bad, ".opencode"))
    writeFileSync(join(bad, ".opencode/opencode.json"), "{bad")
    expect(() => installProject(bad, "@cleocode/goal@0.9.0", { home })).toThrow(/not valid JSON/)
    expect(readFileSync(join(bad, ".opencode/opencode.json"), "utf8")).toBe("{bad")
    const jsonc = project("jsonc")
    mkdirSync(join(jsonc, ".opencode"))
    writeFileSync(join(jsonc, ".opencode/opencode.jsonc"), "{}")
    expect(() => installProject(jsonc, "@cleocode/goal@0.9.0", { home })).toThrow(/by hand/)
  })

  test("identity drops the version or ref", () => {
    expect(identity("@cleocode/goal@0.9.0")).toBe("@cleocode/goal")
    expect(identity("@cleocode/goal")).toBe("@cleocode/goal")
    expect(identity("github:kryptobaseddev/opencode-goal#v0.8.0")).toBe("github:kryptobaseddev/opencode-goal")
  })
})

describe.skipIf(!Bun.which("node"))("the published bin on plain Node", () => {
  const bin = join(import.meta.dir, "../../dist/cli.js")
  const node = (args: string[], cwd: string) => spawnSync("node", [bin, ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, HOME: scratch } })

  test("--version, status --json, install --project --json --dry-run and a usage error", () => {
    const root = project("bin")
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8"))
    expect(node(["--version"], root)).toMatchObject({ status: 0, stdout: `cleo-goal ${pkg.version}\n` })
    const status = node(["status", "--json"], root)
    expect(status.status).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({ schemaVersion: 1, status: "none" })
    const install = node(["install", "--project", "--json", "--dry-run"], root)
    expect(install.status).toBe(0)
    expect(JSON.parse(install.stdout)).toMatchObject({ schemaVersion: 1, action: "dry-run", spec: `@cleocode/goal@${pkg.version}` })
    expect(node(["install"], root).status).toBe(2)
  })
})
