import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { until } from "./harness"
import { goalHost, newSession, script } from "./goal.helpers"
import { GoalRpc } from "../../src/rpc"

// T171 — the criterion → task map, one evidence write per (task, gate), the
// read-only saga/epic rollup, and the refusal to close without proof, end to end
// through the real plugin. `cleo` is a fixture bin on PATH: it records every
// argv and answers with the exact LAFS shapes the real CLI returns, so the
// assertions are about OUR behaviour, not about a CLEO install.

const idle = script(() => ({ text: "ok" }))

const FAKE_CLEO = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const argv = process.argv.slice(2)
appendFileSync(process.env.CLEO_LOG, argv.join(" ") + String.fromCharCode(10))
const state = process.env.CLEO_STATE
mkdirSync(state, { recursive: true })
const write = (value, exit = 0) => { console.log(JSON.stringify(value)); process.exit(exit) }
const ok = (data) => write({ success: true, data })
const fail = (message, exit = 1) => write({ success: false, error: { message } }, exit)
const marker = (task, part) => join(state, task + "." + part)
const has = (task, part) => existsSync(marker(task, part))
const GATES = ["implemented", "testsPassed", "qaPassed"]
const acsOf = (task) => {
  try { return readFileSync(marker(task, "acs"), "utf8").split(",").map((s) => s.trim()).filter(Boolean) } catch { return ["AC1"] }
}
const gateOf = (alias) => GATES[Number(String(alias).replace(/[^0-9]/g, "")) - 1] ?? "implemented"
const proof = (id, title, status) => {
  const passed = GATES.map((g) => has(id, g))
  const aliases = acsOf(id)
  return {
    id, title, status, acceptance: aliases.map((a) => "criterion " + a),
    verification: {
      passed: passed.every(Boolean),
      gates: Object.fromEntries(GATES.map((g, i) => [g, passed[i]])),
      evidence: Object.fromEntries(GATES.map((g, i) => [g, passed[i] ? { atoms: [
        { kind: "commit", sha: "abc" },
        ...(g === "implemented" ? aliases.map((a) => ({ kind: "satisfies", targetTaskId: id, targetAcAlias: a })) : []),
      ] } : {}])),
    },
  }
}
const [cmd, ...rest] = argv
if (cmd === "--version") ok({ version: "test" })
if (cmd === "doctor") ok({ projectId: "test-project" })
if (cmd === "done") {
  const task = rest[0]
  if (process.env.CLEO_MODE === "no-evidence") ok({ taskId: task, gates: GATES.map((gate) => ({ gate, required: true, passed: false })), acMapping: [], typedGates: [] })
  const aliases = acsOf(task)
  ok({
    taskId: task,
    gates: GATES.map((gate) => ({ gate, required: true, passed: has(task, gate) })),
    acMapping: aliases.map((alias) => ({ alias, mapped: has(task, gateOf(alias)) })),
    typedGates: [],
  })
}
if (cmd === "verify") {
  const task = rest[0]
  if (rest[1] === "--gate") writeFileSync(marker(task, rest[2]), "1")
  ok({})
}
if (cmd === "complete") { writeFileSync(marker(rest[0], "closed"), "1"); ok({}) }
if (cmd === "saga" && rest[0] === "members") ok({ sagaId: rest[1], members: [{ epicId: "T910" }], total: 1 })
if (cmd === "saga" && rest[0] === "rollup") ok({ sagaId: rest[1], total: 1, done: 0, active: 1, blocked: 0, pending: 0, completionPct: 0 })
if (cmd === "show") {
  const meta = (id) => ({ id, title: id === "T900" ? "Evidence saga" : id === "T910" ? "Rollup epic" : "Task " + id, status: "pending" })
  const ids = rest.filter((arg) => !arg.startsWith("--"))
  ok(ids.length > 1 ? { tasks: ids.map((id) => proof(id, meta(id).title, meta(id).status)), count: ids.length } : { task: meta(ids[0]) })
}
if (cmd === "list") {
  const parent = rest[rest.indexOf("--parent") + 1]
  if (parent === "T910") ok({ tasks: [proof("T911", "Write the rollup", "done"), proof("T912", "Show it in status", "pending")], total: 2 })
  ok({ tasks: [], total: 0 })
}
fail("unexpected cleo " + argv.join(" "))
`

const CONTRACT = (overrides = "") => `schema: goal/v1
id: demo
title: CLEO rollup fixture
intent:
  verbatim: "prove the CLEO rollup end to end"
outcome: proven and unproven work is visible without a manual note
non_goals:
  - inventing a task status
criteria:
  - id: C1
    statement: src/engine/cleo-rollup.ts exists
    check: {kind: file, path: src/engine/cleo-rollup.ts}
    proves: ["T911#AC1"]
  - id: C2
    statement: the rollup unit tests pass
    check: {kind: command, run: "bun test test/unit/cleo-rollup.test.ts"}
    proves: ["T911#AC2"]
  - id: C3
    statement: src/cli/status.ts exists
    check: {kind: file, path: src/cli/status.ts}
    proves: ["T912#AC1"]
cleo:
  saga: T900
  epics: [T910]
  tasks: [T911, T912]
${overrides}`

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

/** A fixture `cleo` bin + state dir; returns the env the host server must inherit. */
function fixture(acs: Record<string, string>, mode?: "no-evidence") {
  const bin = mkdtempSync(join(tmpdir(), "ocgoal-cleobin-"))
  const state = mkdtempSync(join(tmpdir(), "ocgoal-cleostate-"))
  scratch.push(bin, state)
  writeFileSync(join(bin, "cleo"), FAKE_CLEO)
  chmodSync(join(bin, "cleo"), 0o755)
  for (const [task, aliases] of Object.entries(acs)) writeFileSync(join(state, `${task}.acs`), aliases)
  const log = join(state, "calls.log")
  writeFileSync(log, "")
  return {
    log,
    state,
    calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    mark: (task: string, part: string) => writeFileSync(join(state, `${task}.${part}`), "1"),
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, CLEO_LOG: log, CLEO_STATE: state, ...(mode ? { CLEO_MODE: mode } : {}) },
  }
}

async function command(host: Awaited<ReturnType<typeof goalHost>>, sessionID: string, text: string, match: RegExp): Promise<string> {
  const goalRpc = (host.client as any).rpc(GoalRpc)
  const notices: string[] = []
  const off = goalRpc.events.on("notice", (e: any) => notices.push(String(e?.data?.text ?? e?.text ?? "")))
  await host.client.session.command({ sessionID, name: "goal", text } as any)
  const found = await until(async () => notices.find((n) => match.test(n)) ?? undefined, 60000)
  off?.()
  return found ?? notices.join("\n")
}

function head(host: Awaited<ReturnType<typeof goalHost>>): string {
  const out = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: host.project })
  return out.stdout.toString().trim()
}

const projectFiles = (contract = CONTRACT()) => ({
  "test/fixture.test.ts": 'import { expect, test } from "bun:test"\ntest("fixture", () => expect(1).toBe(1))\n',
  ".opencode/goals/demo/goal.yaml": contract,
})

describe("CLEO evidence rollup (T171)", () => {
  test("a proves: ref to an undeclared task is refused at validation, before any run", async () => {
    const fx = fixture({})
    const broken = CONTRACT().replace("tasks: [T911, T912]", "tasks: [T911]")
    const host = await goalHost(idle, { ...projectFiles(broken), ".opencode/goals/broken/goal.yaml": broken.replace("id: demo", "id: broken") }, { env: fx.env })
    try {
      const sessionID = await newSession(host)
      const text = await command(host, sessionID, "validate broken", /cleo\.tasks/)
      expect(text).toContain("cleo.tasks does not declare")
      expect(text).toContain("T912#AC1")
      // validation never ran a CLEO write
      expect(fx.calls().filter((c) => c.startsWith("verify") || c.startsWith("complete"))).toEqual([])
    } finally {
      await host.stop()
    }
  }, 120000)

  test("one evidence write per (task, gate), and a second sync reuses instead of duplicating", async () => {
    const fx = fixture({ T911: "AC1,AC2", T912: "AC1" })
    const host = await goalHost(idle, projectFiles(), { env: fx.env })
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      await until(async () => existsSync(join(host.project, ".opencode/goals/demo/run.json")), 30000)
      const sha = head(host)

      const first = await command(host, sessionID, `cleo sync demo T911@${sha} T912@${sha}`, /completed|not completed/)
      expect(first).toContain("✓ T911 completed")
      expect(first).toContain("✓ T912 completed")
      const writes = fx.calls().filter((c) => c.startsWith("verify"))
      // implemented + testsPassed for T911, implemented for T912 — exactly once each
      expect(writes.filter((c) => c.startsWith("verify T911 --gate implemented"))).toHaveLength(1)
      expect(writes.filter((c) => c.startsWith("verify T911 --gate testsPassed"))).toHaveLength(1)
      expect(writes.filter((c) => c.startsWith("verify T912 --gate implemented"))).toHaveLength(1)
      expect(writes).toHaveLength(3)
      // the gate write cites the criterion's AC, not a positional guess
      expect(writes.find((c) => c.includes("--gate implemented") && c.includes("T911"))).toContain("satisfies:T911#AC1")

      const before = fx.calls().filter((c) => c.startsWith("verify")).length
      const second = await command(host, sessionID, `cleo sync demo T911@${sha} T912@${sha}`, /completed|not completed/)
      expect(second).toContain("reused")
      // no duplicate evidence write on the second pass
      expect(fx.calls().filter((c) => c.startsWith("verify"))).toHaveLength(before)
    } finally {
      await host.stop()
    }
  }, 180000)

  test("the rollup shows proven vs unproven work for the saga and its epics, and the criterion map", async () => {
    const fx = fixture({ T911: "AC1,AC2", T912: "AC1" })
    for (const gate of ["implemented", "testsPassed", "qaPassed"]) fx.mark("T911", gate)
    const host = await goalHost(idle, projectFiles(), { env: fx.env })
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      await until(async () => existsSync(join(host.project, ".opencode/goals/demo/run.json")), 30000)

      const report = await command(host, sessionID, "cleo rollup demo", /CLEO rollup/)
      expect(report).toContain("read-only")
      expect(report).toContain("saga T900 Evidence saga (pending)")
      expect(report).toContain("epic T910 Rollup epic (pending) · 1/2 tasks proven")
      expect(report).toContain("✓ T911 Write the rollup (done)")
      expect(report).toContain("· T912 Show it in status (pending) · gates 0/3 · AC 0/1 · open AC1")
      expect(report).toContain("goal criteria → CLEO ACs")
      expect(report).toContain("T911#AC1")
      // read-only: no verify/complete was issued by a status command
      expect(fx.calls().filter((c) => c.startsWith("verify") || c.startsWith("complete"))).toEqual([])

      const status = await command(host, sessionID, "status", /CLEO rollup:/)
      expect(status).toContain("CLEO rollup: saga T900 (pending)")
      expect(status).toContain("epics: T910 1/2 proven")
    } finally {
      await host.stop()
    }
  }, 180000)

  test("no evidence atom ⇒ the task is not closed and `cleo complete` is never called", async () => {
    const fx = fixture({ T911: "AC1,AC2" }, "no-evidence")
    const host = await goalHost(idle, projectFiles(), { env: fx.env })
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
      await until(async () => existsSync(join(host.project, ".opencode/goals/demo/run.json")), 30000)
      const sha = head(host)
      // T999 is linked nowhere in the contract, so the plan has no gate to write
      const text = await command(host, sessionID, `cleo sync demo T999@${sha}`, /not completed|refusing/)
      expect(text).toContain("not completed")
      expect(text).toContain("refusing to close a task without proof")
      expect(fx.calls().filter((c) => c.startsWith("complete"))).toEqual([])
    } finally {
      await host.stop()
    }
  }, 180000)
})
