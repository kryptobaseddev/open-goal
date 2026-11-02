import { expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"

// T150 C2 — a project that still has runs under the legacy store keeps them.
//
// The default store is canonical now, but a goal that already lives under
// `.opencode/goals` must be read, reported and driven IN PLACE: its run state
// is written beside its contract, never copied into `.cleo/goals` behind the
// session's back, and a read-only status leaves its bytes untouched.

const GOAL = (slug: string) => `schema: goal/v1
id: ${slug}
title: ${slug} goal
intent:
  verbatim: "write done.txt"
outcome: done.txt exists
non_goals: [x]
criteria:
  - id: C1
    statement: done.txt SHALL exist
    check: {kind: file, path: done.txt}
verification: {mode: host}
plan:
  - {id: S1, title: write done.txt, proves: [C1]}
`

const worker = script((_req, turn) => {
  if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok\n" } }] }
  if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
  if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence: { C1: "done.txt exists" } } }] }
  return { text: "Done." }
})

test("a legacy draft is started in place and never copied into .cleo/goals", async () => {
  const host = await goalHost(worker, { ".opencode/goals/old/goal.yaml": GOAL("old") })
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start old" } as any)
    await waitStatus(host, ["complete"], 120000, "old")

    // the run, ledger and evidence live beside the contract it started from
    expect(JSON.parse(readFileSync(join(host.project, ".opencode", "goals", "old", "run.json"), "utf8"))).toMatchObject({ slug: "old", status: "complete" })
    expect((await ledger(host, "old")).some((e) => e.type === "complete")).toBe(true)
    // and nothing was copied into the canonical store
    expect(await host.readProject(".cleo/goals/old/run.json").catch(() => "")).toBe("")
  } finally {
    await host.stop()
  }
}, 220000)

test("status reports a running legacy run and leaves its bytes untouched", async () => {
  const host = await goalHost(worker, {})
  try {
    const dir = join(host.project, ".opencode", "goals", "legacy")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "goal.yaml"), GOAL("legacy"))
    const runJson = JSON.stringify({
      version: 1, slug: "legacy", title: "legacy goal", sessionID: "ses_legacy", runId: "r-legacy", lock: "lock-legacy",
      status: "running", createdAt: 1, updatedAt: Date.now(), turn: 4,
      activeMs: 0, activeSince: 1, usage: { tokens: 0, cost: 0, baseTokens: null, baseCost: null }, base: {},
      counters: { noProgress: 0, failures: 0 }, wrapup: false, criteria: { C1: { status: "unknown", rejections: 0 } }, steps: { S1: "active" },
      turnFacts: { tools: 0, goalCalls: 0, stepsChanged: false, progressRecorded: false }, steers: 0, compacted: false, flags: [], amendments: [],
    }, null, 2)
    writeFileSync(join(dir, "run.json"), runJson)
    const before = readFileSync(join(dir, "run.json"), "utf8")

    const bin = join(import.meta.dir, "..", "..", "cli", "ocg.ts")
    const proc = Bun.spawnSync(["bun", bin, "status", "--json"], { cwd: host.project, stdout: "pipe", stderr: "pipe" })
    expect(proc.exitCode).toBe(0)
    const reported = JSON.parse(proc.stdout.toString()) as { goal: string; status: string }
    expect(reported.goal).toBe("legacy")
    expect(reported.status).toBe("running")
    expect(readFileSync(join(dir, "run.json"), "utf8")).toBe(before)
    // the same run is readable through the helper (default store → legacy locate)
    expect(await run(host, "legacy")).toMatchObject({ slug: "legacy", status: "running" })
  } finally {
    await host.stop()
  }
}, 220000)
