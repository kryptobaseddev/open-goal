import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseContract } from "../../src/contract/parse"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T186 — the auto-started successor contract is written beside the store of the
// run it continues: a canonical run mints its successor under `.cleo/goals`, a
// legacy run keeps minting under `.opencode/goals`. No existing legacy bytes are
// rewritten either way.
//
// The continuation oracle (`test/host/continue-work.test.ts`) is left untouched
// and pins the legacy path; this file adds the canonical case and re-checks the
// legacy one against the same run.

const CLEO = `#!/bin/sh
case "$1" in
  --version) echo '{"success":true,"data":{"version":"test-1"}}' ;;
  doctor) echo '{"success":true,"data":{"projectId":"test-project"}}' ;;
  next) echo '{"success":true,"data":{"suggestions":[{"id":"T900","title":"Ready item from the board","priority":"medium"}],"totalCandidates":1}}' ;;
  show) echo '{"success":true,"data":{"task":{"id":"T900","title":"Ready item from the board","status":"pending","description":"Do the ready thing","acceptance":["the ready marker exists"]}}}' ;;
  *) echo '{"success":false}'; exit 1 ;;
esac
`

const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }

const worker = script((_req, turn) => {
  if (!turn.trigger.includes("Demo file")) return { text: "Working the new item." }
  if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok - continue work\n" } }] }
  if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
  if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  return { text: "Claiming." }
}, () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the file states it", evidence: [{ path: "done.txt", quote: "status: ok - continue work" }] }] } }] }))

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

const CLEO_FILES = { ".cleo/project-context.json": "{}", ".bin/cleo": CLEO }
const CLEO_ENV = { env: { PATH: `.bin:${process.env.PATH}` }, executable: [".bin/cleo"] }

test("a canonical run writes its successor contract beside the canonical store", async () => {
  const host = await goalHost(
    worker,
    // a canonical draft: the run this test continues lives in .cleo/goals
    { ".cleo/goals/demo/goal.yaml": DEMO_GOAL, ...CLEO_FILES },
    { seedLegacy: false, ...CLEO_ENV },
  )
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["complete"], 120000)

    // the successor lands beside the store the completed run came from
    const path = join(host.project, ".cleo/goals/cleo-t900/goal.yaml")
    await until(() => existsSync(path), 15000)
    const parsed = parseContract(readFileSync(path, "utf8"), { slug: "cleo-t900" })
    expect(parsed.contract).toBeDefined()
    expect(parsed.contract!.cleo?.tasks.map((t) => t.id)).toEqual(["T900"])
    expect(parsed.contract!.criteria.some((c) => c.statement.includes("the ready marker exists"))).toBe(true)
    // no legacy folder was created for it
    expect(existsSync(join(host.project, ".opencode/goals/cleo-t900"))).toBe(false)
    expect(existsSync(join(host.project, ".opencode"))).toBe(false)

    expect((await ledger(host, "demo")).filter((e) => e.type === "continue-work" && e.taskId === "T900")).toHaveLength(1)
    await until(async () => {
      const next = await run(host, "cleo-t900").catch(() => undefined)
      return next && ["running", "waiting"].includes(next.status) ? next : undefined
    }, 30000)
  } finally {
    await host.stop()
  }
}, 180000)

test("a legacy run keeps minting its successor beside the legacy store and rewrites nothing", async () => {
  const host = await goalHost(worker, CLEO_FILES, CLEO_ENV)
  try {
    const contract = join(host.project, ".opencode/goals/demo/goal.yaml")
    const before = sha(contract)
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["complete"], 120000)

    const path = join(host.project, ".opencode/goals/cleo-t900/goal.yaml")
    await until(() => existsSync(path), 15000)
    expect(parseContract(readFileSync(path, "utf8"), { slug: "cleo-t900" }).contract).toBeDefined()
    // the run's own contract bytes are untouched, and nothing appeared in the canonical store
    expect(sha(contract)).toBe(before)
    expect(existsSync(join(host.project, ".cleo/goals/cleo-t900"))).toBe(false)
    expect((await ledger(host, "demo")).filter((e) => e.type === "continue-work" && e.taskId === "T900")).toHaveLength(1)
  } finally {
    await host.stop()
  }
}, 180000)
