import { expect, test } from "bun:test"
import { join } from "node:path"
import { parseContract } from "../../src/contract/parse"
import { GoalRpc } from "../../src/rpc"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// v0.8.0 C4 — a completed goal starts the next ready CLEO item by itself.
// No owner question is created; the start is recorded as a notification.

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

test("completion starts the next ready CLEO item without an owner question", async () => {
  const host = await goalHost(
    worker,
    { ".cleo/project-context.json": "{}", ".bin/cleo": CLEO },
    { env: { PATH: `.bin:${process.env.PATH}` }, executable: [".bin/cleo"] },
  )
  const notices: any[] = []
  try {
    const sid = await newSession(host)
    const rpc: any = (host.client as any).rpc(GoalRpc)
    rpc.events.on("notice", (event: any) => notices.push(event.data))
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["complete"], 120000)

    // the next item's contract was written from the task itself
    const yaml = await host.readProject(".opencode/goals/cleo-t900/goal.yaml")
    const parsed = parseContract(yaml, { slug: "cleo-t900" })
    expect(parsed.contract).toBeDefined()
    expect(parsed.contract!.cleo?.tasks.map((t) => t.id)).toEqual(["T900"])
    expect(parsed.contract!.criteria.some((c) => c.statement.includes("the ready marker exists"))).toBe(true)
    expect(parsed.contract!.intent.verbatim).toContain("next ready CLEO item")

    // the decision is recorded, not asked
    const events = await ledger(host)
    expect(events.filter((e) => e.type === "continue-work" && e.taskId === "T900")).toHaveLength(1)
    const decisions = JSON.parse(await host.readProject(".opencode/goals/.owner-decisions.json").catch(() => '{"requests":{}}'))
    expect(Object.values(decisions.requests ?? {}).filter((d: any) => d.slug === "demo" && d.kind === "complete")).toHaveLength(0)

    // a new session/run was actually opened for it
    const started = await until(async () => {
      try {
        const next = await run(host, "cleo-t900")
        return next.status ? next : undefined
      } catch { return undefined }
    }, 30000)
    expect(started.sessionID).not.toBe(sid)
    expect(["running", "waiting"]).toContain(started.status)

    // the owner can read what happened
    await until(() => notices.some((n) => JSON.stringify(n).includes("next ready CLEO item T900")), 10000)
  } finally {
    await host.stop()
  }
}, 180000)
