import { expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T169 — one goal, declared workstreams, a named worker over AgentMBX.
// The channel is a fake agentmbx on PATH, so no mailbox is touched. The test
// proves the parts the AC asks for: the brief goes to the declared worker and is
// journalled; prose-only returns are rejected BY NAME; a return with the
// declared atoms is accepted; and the host keeps ONE run (a workstream never
// creates a second goal).

const AGENTMBX = `#!/bin/sh
case "$1" in
  send)
    echo "$@" >> .workstream-log
    echo '{"id":"01TESTDISPATCH000000000001"}'
    ;;
  inbox)
    if [ -f .peer-reply ]; then cat .peer-reply; else echo '[]'; fi
    ;;
  *) exit 1 ;;
esac
`

const GOAL = `schema: goal/v1
id: demo
title: demo goal with workstreams
intent:
  verbatim: "make done.txt say ok"
outcome: done.txt exists and the engine workstream is accepted
non_goals: [Touching anything else]
criteria:
  - id: C1
    statement: done.txt SHALL exist
    check: {kind: file, path: done.txt}
cleo:
  tasks:
    - id: T169
      acs: {implemented: [AC1], testsPassed: [AC2]}
workstreams:
  - id: engine
    title: the engine work
    task: T169
    worker: builder@macbook
    done_when: T169 evidence is returned with atoms
`

const worker = script((_req, turn) => {
  if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok\n" } }] }
  if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
  if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence: { C1: "done.txt exists" } } }] }
  return { text: "Done." }
})

test("a declared workstream is dispatched to its named worker, believed only with atoms, and never forks a goal", async () => {
  const host = await goalHost(
    worker,
    { ".opencode/goals/demo/goal.yaml": GOAL, ".bin/agentmbx": AGENTMBX },
    {
      executable: [".bin/agentmbx"],
      env: {
        PATH: `.bin:${process.env.PATH}`,
        OCGOAL_PEER_BIN: "agentmbx",
        OCGOAL_PEER_IDENTITY: "lead@macbook",
        OCGOAL_PEER_COOLDOWN_MS: "0",
        OCGOAL_PEER_POLL_MS: "300",
      },
    },
  )
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)

    // 1. the brief goes to the worker the contract names, and is journalled once.
    const sent = await until(async () => {
      const text = await host.readProject(".workstream-log").catch(() => "")
      return text.trim() ? text : undefined
    }, 20000)
    expect(sent).toContain("--to builder@macbook")
    expect(sent).toContain("CLEO task: T169")
    const dispatched = await until(async () => {
      const entries = (await ledger(host)).filter((e) => e.type === "workstream-dispatch")
      return entries.length ? entries : undefined
    }, 15000)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({ id: "engine", task: "T169", worker: "builder@macbook", messageId: "01TESTDISPATCH000000000001" })

    // 2. a prose-only return is rejected BY NAME and never counted as progress.
    await Bun.write(join(host.project, ".peer-reply"), JSON.stringify([
      { id: "01RETURN0000000000000000001", ts: new Date().toISOString(), from: "builder@macbook", body: "All good, the engine is done. T169 complete." },
    ]))
    const rejected = await until(async () => (await ledger(host)).find((e) => e.type === "workstream-return" && e.ok === false), 20000)
    expect(rejected.reason).toContain("prose-only return for engine")

    // 3. a return with the declared atoms is accepted.
    await Bun.write(join(host.project, ".peer-reply"), JSON.stringify([
      { id: "01RETURN0000000000000000002", ts: new Date(Date.now() + 1000).toISOString(), from: "builder@macbook",
        body: "commit:abcdef123\nfiles:src/engine/a.ts,src/engine/b.ts\ntest-run:.tmp/report.json\nsatisfies:T169#AC1 satisfies:T169#AC2" },
    ]))
    const accepted = await until(async () => (await ledger(host)).find((e) => e.type === "workstream-return" && e.ok === true), 20000)
    expect(accepted.atoms).toContain("commit:abcdef123")

    // 4. the run carries the verdict, and one run is still one goal.
    const state = await until(async () => {
      const current = await run(host)
      return current.workstreams?.engine?.status === "accepted" ? current : undefined
    }, 15000)
    expect(state.slug).toBe("demo")
    expect(state.workstreams!.engine).toMatchObject({ task: "T169", worker: "builder@macbook", status: "accepted" })
    const goals = readdirSync(join(host.project, ".opencode/goals")).filter((name) => !name.startsWith("."))
    expect(goals).toEqual(["demo"])

    await waitStatus(host, ["complete"], 120000)
  } finally {
    await host.stop()
  }
}, 240000)
