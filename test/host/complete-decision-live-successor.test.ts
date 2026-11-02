import { expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { goalHost, ledger, newSession, script, waitStatus, run } from "./goal.helpers"
import { until } from "./harness"
import { GoalRpc } from "../../src/rpc"
import { parseContract } from "../../src/contract/parse"

// D5 — a completion must never offer a stale "Start the next goal".
//
// Two scenarios, both against the real engine:
//   1. a successor goal is already live (here: a second run on disk) — no
//      completion decision is created and the notice names the successor;
//   2. nothing more is ready and no successor is live — the fallback is a
//      notification that says nothing was started, still with no start-next
//      offer.

const GOAL = `schema: goal/v1
id: demo
title: demo completion
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

const NEXT_GOAL = `schema: goal/v1
id: next
title: the successor goal
intent:
  verbatim: "next work"
outcome: next.txt exists
non_goals: [y]
criteria:
  - id: C1
    statement: next.txt SHALL exist
    check: {kind: file, path: next.txt}
`

const worker = script((_req, turn) => {
  if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok\n" } }] }
  if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
  if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence: { C1: "done.txt exists" } } }] }
  return { text: "Done." }
})

/** A successor run that exists only on disk, started by another session. Its
 *  lock is the real one, so recovery resumes it instead of pausing a divergent run. */
const NEXT_LOCK = parseContract(NEXT_GOAL, { slug: "next" }).lock
function liveSuccessor(project: string) {
  const dir = join(project, ".opencode", "goals", "next")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "goal.yaml"), NEXT_GOAL)
  writeFileSync(join(dir, "run.json"), JSON.stringify({
    version: 1, slug: "next", title: "the successor goal", sessionID: "ses_elsewhere", runId: "r-next",
    lock: NEXT_LOCK, status: "running", createdAt: 1_000, updatedAt: Date.now(), turn: 1,
    activeMs: 0, activeSince: 1_000, usage: { tokens: 0, cost: 0, baseTokens: null, baseCost: null }, base: {},
    counters: { noProgress: 0, failures: 0 }, wrapup: false, criteria: {}, steps: {}, turnFacts: { tools: 0, goalCalls: 0, stepsChanged: false, progressRecorded: false }, steers: 0, compacted: false, flags: [], amendments: [],
  }))
}

test("a completion with a live successor creates no start-next decision and names the successor", async () => {
  const host = await goalHost(worker, { ".opencode/goals/demo/goal.yaml": GOAL })
  try {
    const goalRpc = (host.client as any).rpc(GoalRpc)
    const decisions: any[] = []
    const notices: string[] = []
    goalRpc.events.on("decision", (event: any) => decisions.push(event.data))
    goalRpc.events.on("notice", (event: any) => notices.push(String(event?.data?.text ?? event?.text ?? "")))

    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
    // the demo run exists before its first turn; the successor then joins the
    // inventory as a live run from another session
    await until(async () => ((await run(host, "demo").catch(() => undefined)) ? true : undefined), 20000)
    liveSuccessor(host.project)
    await waitStatus(host, ["complete"], 120000)

    const complete = decisions.find((d) => d.kind === "complete")
    expect(complete).toBeUndefined()
    expect(decisions.flatMap((d) => d.choices ?? []).some((c: any) => c.act === "start-next")).toBe(false)
    const notice = await until(() => notices.find((text) => text.includes('successor goal "next" is already live')), 15000)
    expect(notice).toContain("no next-goal question is offered")
    expect(notices.some((text) => /Start the next goal/i.test(text))).toBe(false)

    const suppressed = await until(async () => (await ledger(host, "demo")).find((e) => e.type === "complete-decision-suppressed"), 15000)
    expect(suppressed.successor).toBe("next")
    expect(suppressed.runId).toBe("r-next")
  } finally {
    await host.stop()
  }
}, 220000)

test("a completion with no ready item and no live successor is a notification without a start-next offer", async () => {
  const host = await goalHost(worker, { ".opencode/goals/demo/goal.yaml": GOAL })
  try {
    const goalRpc = (host.client as any).rpc(GoalRpc)
    const decisions: any[] = []
    const notices: string[] = []
    goalRpc.events.on("decision", (event: any) => decisions.push(event.data))
    goalRpc.events.on("notice", (event: any) => notices.push(String(event?.data?.text ?? event?.text ?? "")))

    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["complete"], 120000)

    // The fallback may still offer Archive/Decompose, but nothing may offer
    // "Start the next goal" — that is the stale offer D5 removed.
    const complete = await until(() => decisions.find((d) => d.kind === "complete"), 15000)
    expect(complete.choices.some((c: any) => c.act === "start-next")).toBe(false)
    expect(complete.choices.some((c: any) => /Start the next goal/i.test(c.label ?? c.run ?? ""))).toBe(false)
    expect(complete.choices.some((c: any) => c.act === "archive")).toBe(true)

    const notice = await until(() => notices.find((text) => text.includes("No ready CLEO item and no live successor")), 15000)
    expect(notice).toContain("nothing was started")
    expect(notices.some((text) => /Start the next goal/i.test(text))).toBe(false)

    const notification = await until(async () => (await ledger(host, "demo")).find((e) => e.type === "complete-notification"), 15000)
    expect(notification.reason).toContain("no ready item and no live successor")
  } finally {
    await host.stop()
  }
}, 220000)
