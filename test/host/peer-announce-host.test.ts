import { expect, test } from "bun:test"
import { join } from "node:path"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// v0.8.0 C5 — exactly one availability announcement per idle transition, no
// re-announce while it is unanswered, and replies become candidate work.
// The channel is injected (a fake agentmbx on PATH); no network is touched.

const AGENTMBX = `#!/bin/sh
case "$1" in
  send)
    echo "$@" >> .peer-log
    echo '{"id":"01TESTANNOUNCE0000000000001"}'
    ;;
  inbox)
    if [ -f .peer-reply ]; then cat .peer-reply; else echo '[]'; fi
    ;;
  *) exit 1 ;;
esac
`

const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }
const worker = script((_req, turn) => {
  if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok - peer\n" } }] }
  if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
  if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  return { text: "Claiming." }
}, () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "the file states it", evidence: [{ path: "done.txt", quote: "status: ok - peer" }] }] } }] }))

test("an idle loop announces once, waits for an answer, and turns the reply into candidate work", async () => {
  const host = await goalHost(
    worker,
    { ".bin/agentmbx": AGENTMBX },
    {
      executable: [".bin/agentmbx"],
      env: {
        PATH: `.bin:${process.env.PATH}`,
        OCGOAL_PEER_BIN: "agentmbx",
        OCGOAL_PEER_IDENTITY: "test-peer",
        OCGOAL_PEER_COOLDOWN_MS: "0",
        OCGOAL_PEER_POLL_MS: "300",
      },
    },
  )
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["complete"], 120000)

    const sent = await until(async () => {
      const text = await host.readProject(".peer-log").catch(() => "")
      return text.trim() ? text.trim().split("\n") : undefined
    }, 15000)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain("send")
    expect(sent[0]).toContain("Available for work")
    const announced = (await ledger(host)).filter((e) => e.type === "peer-announce")
    expect(announced).toHaveLength(1)
    expect(announced[0]!.id).toBe("01TESTANNOUNCE0000000000001")
    // the announcement is outstanding, so no second one is sent
    await Bun.sleep(1200)
    expect((await host.readProject(".peer-log")).trim().split("\n")).toHaveLength(1)

    // a peer answers: the reply is candidate work, never consent
    await Bun.write(join(host.project, ".peer-reply"), JSON.stringify([
      { id: "01REPLY00000000000000000001", ts: new Date().toISOString(), from: "peer@host", subject: "Please take T777: small fix" },
    ]))
    const replied = await until(async () => (await ledger(host)).find((e) => e.type === "peer-reply"), 15000)
    expect(replied.count).toBe(1)
    const state = await until(async () => {
      const current = await run(host)
      return current.peer?.candidates?.length ? current : undefined
    }, 10000)
    expect(state.peer!.outstanding).toBeUndefined()
    expect(state.peer!.candidates![0]!.taskId).toBe("T777")
    expect(state.peer!.candidates![0]!.from).toBe("peer@host")
    // and no second announcement was sent for the reply
    expect((await host.readProject(".peer-log")).trim().split("\n")).toHaveLength(1)
  } finally {
    await host.stop()
  }
}, 180000)
