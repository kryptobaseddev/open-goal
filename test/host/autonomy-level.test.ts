import { expect, test } from "bun:test"
import { join } from "node:path"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, text, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T170 — an owner-set autonomy level.
//
// `autonomy.level: standard` is the documented default for a run the owner
// wants without routine pauses: a stalled-but-active run continues with a
// recorded report, and a clean restart / accepted amendment / verifier retry
// need no second owner act. It is a ceiling, not a grant: a human criterion, a
// real blocker, an out-of-policy contract change and a protected oracle still
// stop and ask. The accepted-amendment and verifier-retry proofs live in
// amendment-continuity.test.ts and verifier-empty-response.test.ts (unchanged,
// not duplicated here); this file proves the level reaches a real server and
// that every remaining stop still fires under it.

const LEVEL = (level: string) => `${DEMO_GOAL}autonomy: {level: ${level}}\n`

const formOf = (req: any) => {
  const lines = req.messages.map(text).join("\n").split("\n")
  return {
    payload: lines.findLast((l: string) => l.startsWith("GOAL_DECISION_JSON:") || l.startsWith("GOAL_FORM_JSON:")),
    ask: lines.findLast((l: string) => l.startsWith("GOAL_DECISION_ASK:") || l.startsWith("GOAL_FORM_ASK:")),
  }
}

/** Answer the engine's decision prompt with the question tool exactly once per
 *  presentation. The decision prompt can share a request with the summary
 *  prompt, so the LAST form line across all messages is the one to answer. */
const decisionAnswer = (req: any, asked: Set<string>) => {
  const { payload, ask } = formOf(req)
  if (!payload || !ask || asked.has(ask)) return undefined
  asked.add(ask)
  return { toolCalls: [{ name: "question", args: JSON.parse(payload.slice(payload.indexOf(":") + 1)) }] }
}

/** A worker that keeps taking a visible action but changes nothing on disk:
 * stalled-but-active, exactly the case T170 wants to stop pausing on. */
const busyWorker = script((_request, turn) =>
  turn.results === 0
    ? { toolCalls: [{ name: "read", args: { path: turn.trigger.includes("oracle") ? "oracle.txt" : "README.md" } }] }
    : { text: "ran the checks; nothing changed on disk" })

test("level: standard continues a stalled-but-active run with a recorded report and no owner act", async () => {
  const host = await goalHost(busyWorker, { ".opencode/goals/demo/goal.yaml": LEVEL("standard") })
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as never)
    await waitStatus(host, ["running"], 15000)

    // The level reached the worker in the contract block the host injects.
    await until(async () =>
      host.fixture.requests.some((r) => r.tools?.length && JSON.stringify(r.messages).includes("Autonomy level (owner-set): standard")), 20000
    )

    const stall = await until(async () => (await ledger(host)).find((e) => e.type === "stall" || e.type === "paused"), 60000, 250)
    expect(stall.type).toBe("stall")
    expect(String(stall.reason ?? "")).toMatch(/active|activity/i)
    expect(stall.policy).toBe("continue") // the level's on_stall, not an explicit flag
    const events = await ledger(host)
    expect(events.some((e) => e.type === "stall-report" && e.action === "continued")).toBe(true)
    expect((await run(host)).status).toBe("running")
    expect(events.filter((e) => e.type === "paused")).toHaveLength(0)
  } finally { await host.stop() }
}, 120000)

test("level: standard resumes a clean restart by itself, with no owner decision", async () => {
  const DONE = "status: ok - level restart\n"
  const worker = script((_request, turn) => {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "park in a wait" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_wait", args: { seconds: 10, reason: "restart window" } }] }
    return { text: "Holding while the host restarts." }
  })
  const host = await goalHost(worker, { ".opencode/goals/demo/goal.yaml": LEVEL("standard") })
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as never)
    const parked = await waitStatus(host, ["waiting"], 20000)

    await host.client.location.reload()
    const resumed = await until(async () => (await ledger(host)).find((e) => e.type === "restart-resume"), 20000)
    expect(resumed.runId).toBe(parked.runId)
    expect(resumed.lock).toBe(parked.lock)
    const state = await run(host)
    expect(state.status).not.toBe("paused")
    expect(state.runId).toBe(parked.runId)
    // No restart owner decision was created, and the run keeps moving.
    expect((await host.readProject(".opencode/goals/.owner-decisions.json").catch(() => '{"requests":{}}')).includes('"kind":"owner-operation"')).toBe(false)
    await until(async () => (await ledger(host)).filter((e) => e.type === "admit").length >= 2, 20000)
  } finally { await host.stop() }
}, 120000)

test("level: standard still stops for a human criterion and asks the owner", async () => {
  const yaml = `schema: goal/v1
id: demo
title: Human sign-off under standard autonomy
intent: {verbatim: write the marker and let the owner confirm the result}
outcome: marker.txt exists and the owner confirms the result
non_goals: [other files, fake owner consent]
criteria:
  - id: C1
    statement: marker.txt exists
    check: {kind: file, path: marker.txt}
  - id: C2
    statement: the owner confirms the visible result
    check: {kind: human, ask: "Does the result look right?"}
protect: [oracle.txt]
plan:
  - {id: S1, title: Write the marker, proves: [C1]}
autonomy: {level: standard}
`
  const asked = new Set<string>()
  const worker = script((req, turn) => {
    const answer = decisionAnswer(req, asked)
    if (answer) return answer
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "marker.txt", content: "marker\n" } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote the marker", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "marker written", evidence: { C1: "wrote marker.txt", C2: "the owner must confirm" } } }] }
    return { text: "Waiting for the owner's sign-off." }
  })
  const host = await goalHost(worker, { ".opencode/goals/demo/goal.yaml": yaml, "oracle.txt": "do not edit\n" })
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as never)
    const review = await waitStatus(host, ["needs_review"], 60000)
    expect(review.reason).toContain("C2")
    const form = await until(async () => {
      const forms: any[] = await (host.client.session.form as any).list({ sessionID: sid })
      return forms.find((f) => JSON.stringify(f).includes("Approve C2"))
    }, 20000)
    expect(form).toBeDefined()
    expect((await ledger(host)).some((e) => e.type === "decision" && e.kind === "needs_review")).toBe(true)
  } finally { await host.stop() }
}, 120000)

test("level: standard still stops for a real blocker and asks the owner", async () => {
  const asked = new Set<string>()
  const worker = script((req, turn) => {
    const answer = decisionAnswer(req, asked)
    if (answer) return answer
    if (turn.results === 0)
      return { toolCalls: [{ name: "goal_block", args: { key: "missing-deploy-credential", reason: "the deploy needs an owner credential", needs: "credential" } }] }
    return { text: "Blocked on the owner." }
  })
  const host = await goalHost(worker, { ".opencode/goals/demo/goal.yaml": LEVEL("standard") })
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as never)
    const blocked = await waitStatus(host, ["blocked"], 60000)
    expect(blocked.blocker?.key).toBe("missing-deploy-credential")
    const form = await until(async () => {
      const forms: any[] = await (host.client.session.form as any).list({ sessionID: sid })
      return forms.find((f) => JSON.stringify(f).includes("Goal blocked"))
    }, 20000)
    expect(form).toBeDefined()
    expect((await ledger(host)).some((e) => e.type === "blocked" && e.blocker?.key === "missing-deploy-credential")).toBe(true)
  } finally { await host.stop() }
}, 120000)

test("level: standard routes an out-of-policy contract change to the owner and never applies it", async () => {
  const state = { lock: "" }
  const changed = LEVEL("standard").replace(`grep -q 'status: ok' done.txt`, `true`)
  const asked = new Set<string>()
  const worker = script((req, turn) => {
    const answer = decisionAnswer(req, asked)
    if (answer) return answer
    if (turn.trigger === "PROPOSE" && turn.results === 0)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "demo", expectedLock: state.lock, yaml: changed, rationale: "agent change" } }] }
    if (turn.trigger === "PROPOSE") return { text: "Recorded." }
    return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold for policy scenario" } }] }
  })
  const host = await goalHost(worker, { ".opencode/goals/demo/goal.yaml": LEVEL("standard") })
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as never)
    const initial = await waitStatus(host, ["waiting", "running"], 20000)
    state.lock = initial.lock

    await host.client.session.prompt({ sessionID: sid, text: "PROPOSE" } as never)
    await until(async () => host.fixture.requests.map((r) => JSON.stringify(r.messages)).find((m) => m.includes("outside the owner-set autonomy policy")), 15000)
    expect((await run(host)).lock).toBe(initial.lock)
    expect(await host.readProject(".opencode/goals/demo/goal.yaml")).toBe(LEVEL("standard"))
    expect((await ledger(host)).filter((e) => e.type === "amended")).toHaveLength(0)
  } finally { await host.stop() }
}, 120000)
