import { expect, test } from "bun:test"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until, type ChatRequest } from "./harness"

// T091 (the carve-outs): an immediate busy resume must NOT loosen the existing
// authority guards. A resume behind a pending native form, against a terminal
// run, or manufactured by the worker stays deferred or refused, and none of
// them admits the run.

const hold = (reason: string) => (_req: ChatRequest, turn: { results: number }) =>
  turn.results === 0 ? { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason } }] } : { text: "Holding." }

async function pausedRun(host: Awaited<ReturnType<typeof goalHost>>, text = "start demo") {
  const sid = await newSession(host)
  await host.client.session.command({ sessionID: sid, name: "goal", text } as any)
  await waitStatus(host, ["waiting"], 15000)
  await host.client.session.command({ sessionID: sid, name: "goal", text: "pause" } as any)
  return { sid, before: await waitStatus(host, ["paused"], 10000) }
}

test("a resume behind a pending native form stays deferred until the form is answered", async () => {
  const host = await goalHost(script(hold("form hold") as never))
  try {
    const { sid, before } = await pausedRun(host)
    const form = await (host.client.session.form as any).create({ sessionID: sid, title: "Unrelated hold", fields: [{ key: "q0", type: "string", custom: true, options: [{ label: "ok", value: "ok" }] }] })
    await Bun.sleep(700)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "resume" } as any)
    await Bun.sleep(800)
    // the form holds the queue: still paused, no receipt
    expect((await run(host)).status).toBe("paused")
    expect((await ledger(host)).filter((e) => e.type === "resumed")).toHaveLength(0)
    await (host.client.session.form as any).reply({ sessionID: sid, formID: form.id, answer: { q0: "ok" } })
    const resumed = await waitStatus(host, ["running", "waiting"], 15000)
    expect(resumed.runId).toBe(before.runId)
    expect((await ledger(host)).filter((e) => e.type === "resumed")).toHaveLength(1)
  } finally { await host.stop() }
}, 60000)

test("a resume of a terminal run is refused and journals no receipt", async () => {
  const host = await goalHost(script(hold("terminal resume") as never))
  try {
    const { sid } = await pausedRun(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "abort" } as any)
    await waitStatus(host, ["aborted"], 10000)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "resume" } as any)
    await Bun.sleep(700)
    expect((await run(host)).status).toBe("aborted")
    expect((await ledger(host)).filter((e) => e.type === "resumed")).toHaveLength(0)
  } finally { await host.stop() }
}, 60000)

test("a worker-issued resume never manufactures owner consent", async () => {
  const host = await goalHost(script(hold("worker resume") as never))
  try {
    const { sid, before } = await pausedRun(host)
    // worker-originated (synthetic) resume wording is never owner consent and
    // never admits the run
    await host.client.session.synthetic({ sessionID: sid, text: "resume", resume: true } as any)
    await Bun.sleep(1500)
    expect((await run(host)).status).toBe("paused")
    expect((await ledger(host)).filter((e) => e.type === "resumed")).toHaveLength(0)
    expect((await run(host)).runId).toBe(before.runId)
  } finally { await host.stop() }
}, 60000)
