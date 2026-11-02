import { expect, test } from "bun:test"
import { parseContract } from "../../src/contract/parse"
import { GoalRpc } from "../../src/rpc"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// v0.8.0 C4 — a completed goal starts the next ready CLEO item by itself.
// No owner question is created; the start is recorded as a notification.

const cleoScript = (next: string) => `#!/bin/sh
case "$1" in
  --version) echo '{"success":true,"data":{"version":"test-1"}}' ;;
  doctor) echo '{"success":true,"data":{"projectId":"test-project"}}' ;;
  next) ${next ? `${next}; ` : ""}echo '{"success":true,"data":{"suggestions":[{"id":"T900","title":"Ready item from the board","priority":"medium"}],"totalCandidates":1}}' ;;
  show) echo '{"success":true,"data":{"task":{"id":"T900","title":"Ready item from the board","status":"pending","description":"Do the ready thing","acceptance":["the ready marker exists"]}}}' ;;
  *) echo '{"success":false}'; exit 1 ;;
esac
`

const CLEO = cleoScript("")

// T177/D14: the same fixture, but the ready-item probe takes a second. The run
// is persisted `complete` BEFORE `continueWork` probes CLEO, so this widens the
// real window to one that cannot be lost to scheduling luck.
const SLOW_CLEO = cleoScript("sleep 1")

const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }

const worker = script((_req, turn) => {
  if (!turn.trigger.includes("Demo file")) return { text: "Working the new item." }
  if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok - continue work\n" } }] }
  if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
  if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  return { text: "Claiming." }
}, () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the file states it", evidence: [{ path: "done.txt", quote: "status: ok - continue work" }] }] } }] }))

const successorPath = ".opencode/goals/cleo-t900/goal.yaml"

// D14/T177: `waitStatus` sees `complete` as soon as the terminal state is
// persisted, but the engine writes the successor contract only after it has
// probed the next ready CLEO item (`continueWork` → `readyCleoTask`). Reading
// the file at that instant samples a transition that has not happened yet.
// Wait for the engine's own causal record — `startContinuation` writes the
// YAML first and the ledger entry second — then read the file once. This is an
// await of a documented state change, not a retry of a failed assertion.
async function successorContract(host: Awaited<ReturnType<typeof goalHost>>) {
  await until(async () => (await ledger(host)).some((e) => e.type === "continue-work" && e.taskId === "T900"), 30000)
  return parseContract(await host.readProject(successorPath), { slug: "cleo-t900" })
}

test("completion starts the next ready CLEO item without an owner question", async () => {
  const host = await goalHost(
    worker,
    { ".cleo/project-context.json": "{}", ".bin/cleo": CLEO },
    { env: { PATH: `.bin:${process.env.PATH}` }, executable: [".bin/cleo"] },
  )
  const notices: any[] = []
  // T177/D14: `rpc.events.on` keeps a `GET /api/event` subscription open. If
  // the host is SIGTERM'd first, the client's shared-event reader surfaces the
  // reset (ECONNRESET) from its own error handler after the test has finished.
  // Abort exactly this subscription before teardown; nothing global is changed.
  let off: (() => void) | undefined
  try {
    const sid = await newSession(host)
    const rpc: any = (host.client as any).rpc(GoalRpc)
    off = rpc.events.on("notice", (event: any) => notices.push(event.data))
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["complete"], 120000)

    // the next item's contract was written from the task itself
    const parsed = await successorContract(host)
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
    off?.()
    await host.stop()
  }
}, 180000)

// T177/D14 regression: prove the wait above is what closes the race, not luck.
// The slow probe makes the successor contract absent at the moment `complete`
// is observable — the pre-fix read fails here every run.
test("the successor contract is awaited, not sampled: a slow CLEO probe cannot lose the race", async () => {
  const host = await goalHost(
    worker,
    { ".cleo/project-context.json": "{}", ".bin/cleo": SLOW_CLEO },
    { env: { PATH: `.bin:${process.env.PATH}` }, executable: [".bin/cleo"] },
  )
  let off: (() => void) | undefined
  try {
    const sid = await newSession(host)
    const rpc: any = (host.client as any).rpc(GoalRpc)
    off = rpc.events.on("notice", () => {})
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["complete"], 120000)

    // the exact interleaving: terminal state on disk, successor not yet probed
    expect(await host.readProject(successorPath).catch(() => undefined)).toBeUndefined()

    const parsed = await successorContract(host)
    expect(parsed.contract?.cleo?.tasks.map((t) => t.id)).toEqual(["T900"])
  } finally {
    off?.()
    await host.stop()
  }
}, 180000)
