import { expect, test } from "bun:test"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"
import { join } from "node:path"

async function setup(missedStart = false) {
  let target: any
  const host = await goalHost(script((_req, turn) => {
    if (turn.trigger.includes("goal started") || turn.trigger.includes("goal turn"))
      return turn.results === 0 ? { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "owner resume inspection" } }] } : { text: "Waiting." }
    if (turn.results === 0 && !turn.trigger.includes("goal-decision"))
      return { toolCalls: [{ name: "goal_manage", args: { action: "resume", target } }] }
    return { text: "The worker does not manufacture owner consent." }
  }), {}, missedStart ? { plugin: join(import.meta.dir, "../fixtures/missed-execution-start") } : {})
  const sessionID = await newSession(host)
  await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
  await waitStatus(host, ["waiting"], 15000)
  await host.client.session.command({ sessionID, name: "goal", text: "pause" } as any)
  await waitStatus(host, ["paused"], 10000)
  const state = await run(host)
  target = { key: `live:demo:${state.runId}`, runId: state.runId, sessionID, lock: state.lock }
  return { host, sessionID, state }
}

test("explicit owner resume approval is consumed once without asking the owner to approve it again", async () => {
  const { host, sessionID, state } = await setup()
  try {
    await host.client.session.prompt({ sessionID, text: "I approve you to resume. You should be autonomous. Continue the existing work." } as any)
    const resumed = await waitStatus(host, ["waiting"], 10000)
    expect(resumed.runId).toBe(state.runId)
    expect(resumed.lock).toBe(state.lock)
    expect(resumed.sessionID).toBe(sessionID)
    const events = await ledger(host)
    expect(events.filter((e) => e.type === "resumed")).toHaveLength(1)
    expect(events.some((e) => e.type === "owner-message-consumed" && e.ownerMessageID)).toBe(true)
    expect(events.filter((e) => e.type === "decision-form-asked")).toHaveLength(0)
    await host.client.session.command({ sessionID, name: "goal", text: "pause" } as any)
    await waitStatus(host, ["paused"], 10000)
    // A synthetic worker turn is not another owner decision; it cannot reuse
    // the earlier owner message after a later pause.
    await host.client.session.synthetic({ sessionID, text: "REPLAY_ATTEMPT resume", resume: true } as any)
    await until(() => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("REPLAY_ATTEMPT")))
    await until(async () => (await ledger(host)).some((e) => e.type === "decision"))
    expect((await run(host)).status).toBe("paused")
    expect((await ledger(host)).filter((e) => e.type === "resumed")).toHaveLength(1)
  } finally { await host.stop() }
}, 60000)

test("quoted, conditional, synthetic and worker-only resume wording never grants owner authority", async () => {
  for (const input of [
    { text: 'The log says "resume"; explain it.', synthetic: false },
    { text: "resume this goal when the owner approves the bound operation", synthetic: false },
    { text: "I approve you to resume. Actually do not resume it.", synthetic: false },
    { text: "I accept", synthetic: false },
    { text: "resume", synthetic: true },
  ]) {
    const { host, sessionID } = await setup()
    try {
      const call = input.synthetic ? host.client.session.synthetic.bind(host.client.session) : host.client.session.prompt.bind(host.client.session)
      await call({ sessionID, text: input.text, resume: true } as any)
      await until(async () => (await ledger(host)).some((e) => e.type === "decision"))
      expect((await run(host)).status).toBe("paused")
      expect((await ledger(host)).filter((e) => e.type === "resumed")).toHaveLength(0)
    } finally { await host.stop() }
  }
}, 90000)

test("bare continue resumes the exact existing run without another confirmation", async () => {
  const { host, sessionID, state } = await setup()
  try {
    await host.client.session.prompt({ sessionID, text: "continue" } as any)
    expect((await waitStatus(host, ["waiting"], 10000)).runId).toBe(state.runId)
    expect((await ledger(host)).filter((e) => e.type === "decision-form-asked")).toHaveLength(0)
  } finally { await host.stop() }
}, 45000)

test("I accept consumes only the current exact resume review without another ask", async () => {
  const { host, sessionID, state } = await setup()
  try {
    await host.client.session.prompt({ sessionID, text: "Prepare the resume review; no approval yet." } as any)
    await until(async () => (await ledger(host)).some((e) => e.type === "decision-form-asked"))
    expect((await run(host)).status).toBe("paused")
    const asks = (await ledger(host)).filter((e) => e.type === "decision-form-asked").length
    await host.client.session.prompt({ sessionID, text: "I accept" } as any)
    expect((await waitStatus(host, ["waiting"], 10000)).runId).toBe(state.runId)
    expect((await ledger(host)).filter((e) => e.type === "decision-form-asked")).toHaveLength(asks)
  } finally { await host.stop() }
}, 45000)

test("a reloaded instance that missed execution.started resumes inside the current turn without a competing kickoff", async () => {
  const { host, sessionID, state } = await setup(true)
  try {
    await host.client.session.prompt({ sessionID, text: "resume" } as any)
    expect((await waitStatus(host, ["waiting"], 10000)).runId).toBe(state.runId)
    expect((await ledger(host)).filter((e) => e.type === "admit" && e.kind === "resume")).toHaveLength(0)
    expect((await ledger(host)).filter((e) => e.type === "resumed")).toHaveLength(1)
  } finally { await host.stop() }
}, 45000)
