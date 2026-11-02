import { expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"

// T150 C1 — a new goal starts in the canonical store by default.
//
// The fixture project carries a completed goal in the legacy store and a fresh
// draft in `.cleo/goals`. Starting the fresh draft must write the run, ledger
// and evidence under `.cleo/goals`, must not create a folder for it under
// `.opencode/goals`, and must leave the legacy goal's bytes untouched while it
// stays readable and reportable.

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

/** A completed goal on disk in the legacy store, with its exact bytes. */
function legacyGoal(project: string) {
  const dir = join(project, ".opencode", "goals", "old")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "goal.yaml"), GOAL("old"))
  writeFileSync(join(dir, "run.json"), JSON.stringify({ version: 1, slug: "old", title: "old goal", sessionID: "ses_old", runId: "r-old", lock: "lock-old", status: "complete", createdAt: 1, updatedAt: 1, turn: 3, activeMs: 0, activeSince: null, usage: { tokens: 0, cost: 0, baseTokens: null, baseCost: null }, base: {}, counters: { noProgress: 0, failures: 0 }, wrapup: false, criteria: {}, steps: {}, turnFacts: { tools: 0, goalCalls: 0, stepsChanged: false, progressRecorded: false }, steers: 0, compacted: false, flags: [], amendments: [] }))
  return { yaml: readFileSync(join(dir, "goal.yaml"), "utf8"), run: readFileSync(join(dir, "run.json"), "utf8") }
}

test("a project override selects the store the engine actually writes", async () => {
  const host = await goalHost(worker, {
    ".cleo/goal-store.json": JSON.stringify({ goalsDir: ".state/goals", archiveDir: ".state/done" }),
    ".state/goals/custom/goal.yaml": GOAL("custom"),
  })
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start custom" } as any)
    await waitStatus(host, ["complete"], 120000, "custom")

    expect(existsSync(join(host.project, ".state", "goals", "custom", "run.json"))).toBe(true)
    expect(JSON.parse(readFileSync(join(host.project, ".state", "goals", "custom", "run.json"), "utf8"))).toMatchObject({ slug: "custom", status: "complete" })
    // neither the canonical default nor the legacy store received this run
    expect(existsSync(join(host.project, ".cleo", "goals", "custom"))).toBe(false)
    expect(existsSync(join(host.project, ".opencode", "goals", "custom"))).toBe(false)
  } finally {
    await host.stop()
  }
}, 220000)

test("a new goal starts under .cleo/goals while the legacy run stays readable and byte-identical", async () => {
  const host = await goalHost(worker, { ".cleo/goals/fresh/goal.yaml": GOAL("fresh") })
  try {
    const before = legacyGoal(host.project)
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start fresh" } as any)
    await waitStatus(host, ["complete"], 120000, "fresh")

    // the new run lives in the canonical store, with its ledger
    const canonical = join(host.project, ".cleo", "goals", "fresh")
    expect(existsSync(join(canonical, "run.json"))).toBe(true)
    expect(existsSync(join(canonical, "ledger.jsonl"))).toBe(true)
    expect(JSON.parse(readFileSync(join(canonical, "run.json"), "utf8"))).toMatchObject({ slug: "fresh", status: "complete" })
    expect((await ledger(host, "fresh")).some((e) => e.type === "complete")).toBe(true)
    // nothing was written for it under the legacy store
    expect(existsSync(join(host.project, ".opencode", "goals", "fresh"))).toBe(false)

    // the legacy goal is readable and its bytes did not move
    expect(await run(host, "old")).toMatchObject({ slug: "old", status: "complete", runId: "r-old" })
    expect(readFileSync(join(host.project, ".opencode", "goals", "old", "goal.yaml"), "utf8")).toBe(before.yaml)
    expect(readFileSync(join(host.project, ".opencode", "goals", "old", "run.json"), "utf8")).toBe(before.run)
  } finally {
    await host.stop()
  }
}, 220000)
