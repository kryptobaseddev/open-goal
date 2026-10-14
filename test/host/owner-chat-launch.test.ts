import { expect, test } from "bun:test"
import { join } from "node:path"
import { goalHost, ledger, newSession, run, script } from "./goal.helpers"
import { until } from "./harness"

function launchingHost() {
  return goalHost(script((_request, turn) => {
    if (turn.trigger === "PREPARE" && !turn.results)
      return { toolCalls: [{ name: "goal_prepare_launch", args: { slug: "demo" } }] }
    const payload = turn.trigger.split("\n").find((line) => line.startsWith("GOAL_FORM_JSON:"))
    if (payload && !turn.results) return { toolCalls: [{ name: "question", args: JSON.parse(payload.slice("GOAL_FORM_JSON:".length)) }] }
    if ((turn.trigger === "Start the goal now." || turn.trigger === "REPLAY") && !turn.results)
      return { toolCalls: [{ name: "goal_start", args: { slug: "demo" } }] }
    return { text: "No manufactured approval." }
  }))
}

test("fresh actual owner chat starts the exact reviewed draft after form expiry, without replaying the old choice", async () => {
  const host = await launchingHost()
  try {
    const sessionID = await newSession(host)
    await host.client.session.prompt({ sessionID, text: "PREPARE" } as never)
    const form = await until(async () => (await host.client.session.form.list({ sessionID }))[0], 10000)
    const path = join(host.project, ".opencode/goals/.owner-launches.json")
    const data = await Bun.file(path).json()
    const original = Object.values(data.requests)[0] as { id: string; expiresAt: number; lock: string }
    // Trusted fixture simulates elapsed clock time, never consent.
    original.expiresAt = Date.now() - 1
    await Bun.write(path, JSON.stringify(data))
    await host.client.session.form.cancel({ sessionID, formID: form.id })
    await host.client.session.wait({ sessionID })
    await host.client.session.prompt({ sessionID, text: "Start the goal now." } as never)
    const started = await until(async () => await run(host).catch(() => undefined), 10000)
    expect(started.sessionID).toBe(sessionID)
    expect(started.lock).toBe(original.lock)
    const events = await ledger(host)
    expect(events.filter((event) => event.type === "start")).toHaveLength(1)
    const consumed = events.filter((event) => event.type === "owner-message-consumed")
    expect(consumed).toHaveLength(1)
    const message = (await host.client.session.context({ sessionID })).find((message) => message.id === consumed[0].ownerMessageID)
    expect(message).toMatchObject({ type: "user", text: "Start the goal now." })
    expect(consumed[0].decisionId).not.toBe(original.id)
    const after = await Bun.file(path).json()
    expect(after.requests[original.id].status).not.toBe("succeeded")
    await host.client.session.prompt({ sessionID, text: "REPLAY" } as never)
    await host.client.session.wait({ sessionID })
    expect((await ledger(host)).filter((event) => event.type === "start")).toHaveLength(1)
    expect((await ledger(host)).filter((event) => event.type === "owner-message-consumed")).toHaveLength(1)
    await host.client.location.reload()
    expect((await ledger(host)).filter((event) => event.type === "start")).toHaveLength(1)
  } finally { await host.stop() }
}, 45000)

test("quoted or conditional chat and an unrelated form never release or authorize a launch", async () => {
  const host = await launchingHost()
  try {
    const sessionID = await newSession(host)
    await host.client.session.prompt({ sessionID, text: "PREPARE" } as never)
    const form = await until(async () => (await host.client.session.form.list({ sessionID }))[0], 10000)
    for (const text of ['The agent said "start the goal"', "Start the goal if tests pass"]) {
      await host.client.session.prompt({ sessionID, text } as never)
      expect((await host.client.session.form.get({ sessionID, formID: form.id })).state.status).toBe("pending")
      expect(await run(host).catch(() => undefined)).toBeUndefined()
    }
    const unrelated = await host.client.session.form.create({ sessionID, title: "Unrelated preference", fields: [{ key: "preference", type: "string", options: [{ value: "keep", label: "Keep preference" }] }] })
    await host.client.session.prompt({ sessionID, text: "Start the goal now." } as never)
    expect((await host.client.session.form.get({ sessionID, formID: unrelated.id })).state.status).toBe("pending")
    expect((await host.client.session.form.get({ sessionID, formID: form.id })).state.status).toBe("pending")
    expect(await run(host).catch(() => undefined)).toBeUndefined()
    expect((await ledger(host)).filter((event) => event.type === "owner-message-consumed")).toHaveLength(0)
  } finally { await host.stop() }
}, 45000)

test("owner chat cannot launch contract bytes changed since the displayed review", async () => {
  const host = await launchingHost()
  try {
    const sessionID = await newSession(host)
    await host.client.session.prompt({ sessionID, text: "PREPARE" } as never)
    const form = await until(async () => (await host.client.session.form.list({ sessionID }))[0], 10000)
    const path = join(host.project, ".opencode/goals/demo/goal.yaml")
    await Bun.write(path, (await Bun.file(path).text()).replace("Demo file says ok", "Changed after review"))
    await host.client.session.form.cancel({ sessionID, formID: form.id })
    await host.client.session.wait({ sessionID })
    await host.client.session.prompt({ sessionID, text: "Start the goal now." } as never)
    await host.client.session.wait({ sessionID })
    expect(await run(host).catch(() => undefined)).toBeUndefined()
    expect((await ledger(host)).filter((event) => event.type === "owner-message-consumed")).toHaveLength(0)
  } finally { await host.stop() }
}, 45000)

test("actual owner start chat unholds only its exact pending launch form and creates one real run", async () => {
  const host = await launchingHost()
  try {
    const sessionID = await newSession(host)
    await host.client.session.prompt({ sessionID, text: "PREPARE" } as never)
    const form = await until(async () => (await host.client.session.form.list({ sessionID }))[0], 10000)
    expect((await host.client.session.form.get({ sessionID, formID: form.id })).state.status).toBe("pending")
    await host.client.session.prompt({ sessionID, text: "Start the goal now." } as never)
    await until(async () => await run(host).catch(() => undefined), 10000)
    const events = await ledger(host)
    expect(events.filter((event) => event.type === "start")).toHaveLength(1)
    expect(events.filter((event) => event.type === "owner-message-consumed")).toHaveLength(1)
    expect(events.filter((event) => event.type === "launch-chat-unheld")).toHaveLength(1)
    expect((await host.client.session.form.list({ sessionID })).some((f) => f.id === form.id)).toBe(false)
  } finally { await host.stop() }
}, 45000)
