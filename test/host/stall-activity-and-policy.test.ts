import { expect, test } from "bun:test"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// The VidaPeps run paused with "stalled: no change the host could see for 3
// turns" while the agent was running the whole contract check set — real work
// the host could not see. Two things follow: host-visible activity must count
// as activity (and be recorded as such), and the OWNER may set
// `autonomy.on_stall: continue` so a stalled-but-active run continues with a
// recorded stall report instead of pausing. Default stays pause.

const POLICY = DEMO_GOAL + "autonomy: {on_stall: continue}\n"

/** A worker that calls a tool each turn and then ends the turn with text:
 * host-visible activity, but no file or step change. */
const busyworker = script((_request, turn) =>
  turn.results === 0
    ? { toolCalls: [{ name: "read", args: { path: turn.trigger.includes("oracle") ? "oracle.txt" : "README.md" } }] }
    : { text: "ran the checks; nothing changed on disk" })

test("host-visible activity is recorded as activity, and on_stall: continue keeps a stalled-but-active run going with a stall report", async () => {
  const host = await goalHost(busyworker, { ".opencode/goals/demo/goal.yaml": POLICY }, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    await waitStatus(host, ["running"], 15000)

    // Several turns of tool calls with no file or step change.
    const stall = await until(async () => (await ledger(host)).find((e) => e.type === "stall" || e.type === "paused"), 60000, 250)
    const events = await ledger(host)
    const turns = events.filter((e) => e.type === "turn")
    expect(turns.length).toBeGreaterThanOrEqual(2)
    // Activity is recorded per turn, not treated as nothing.
    expect(turns.some((t) => Number(t.tools) > 0 && t.activity === true)).toBe(true)

    if (stall.type === "stall") {
      // The owner-set policy continued the run and said so, visibly.
      expect(String(stall.reason ?? "")).toMatch(/active|activity/i)
      expect((await run(host)).status).toBe("running")
      expect(events.some((e) => e.type === "stall-report")).toBe(true)
    } else {
      throw new Error(`on_stall: continue must not pause an active run; got ${JSON.stringify(stall)}`)
    }
  } finally { await host.stop() }
}, 120000)

test("without the policy a stalled run still pauses, and the reason distinguishes activity from idleness", async () => {
  const host = await goalHost(busyworker, {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    const paused = await waitStatus(host, ["paused"], 60000)
    expect(paused.reason).toMatch(/stalled/i)
    expect(paused.reason).toMatch(/active|activity/i)
    expect((await ledger(host)).some((e) => e.type === "stall" && e.activity === true)).toBe(true)
    // The engine stopped for the owner, who is the only one who resumes it.
    expect((await ledger(host)).filter((e) => e.type === "resumed")).toHaveLength(0)
  } finally { await host.stop() }
}, 120000)

test("recording progress with goal_progress resets the stall counter without a file change", async () => {
  let first = true
  const host = await goalHost(script((_request, turn) => {
    if (turn.results === 0) {
      const call = first
        ? { name: "goal_progress", args: { note: "ran the whole contract check set; no file changed", next: "continue" } }
        : { name: "read", args: { path: "README.md" } }
      first = false
      return { toolCalls: [call] }
    }
    return { text: "still working; recorded what I did" }
  }), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    await waitStatus(host, ["running"], 15000)
    const quiet = await until(async () => {
      const turns = (await ledger(host)).filter((e) => e.type === "turn")
      return turns.find((t) => t.progress === true && Number(t.tools) > 0) ? turns : undefined
    }, 60000, 250)
    expect(quiet.some((t) => t.progress === true)).toBe(true)
    expect((await run(host)).counters.noProgress).toBeLessThan(3)
    expect((await run(host)).status).not.toBe("paused")
  } finally { await host.stop() }
}, 120000)
