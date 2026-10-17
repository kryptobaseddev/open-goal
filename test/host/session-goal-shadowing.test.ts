import { expect, test } from "bun:test"
import { DEMO_GOAL, goalHost, newSession, run, script, waitStatus } from "./goal.helpers"
import { GoalRpc } from "../../src/rpc"
import { until } from "./harness"

// T106 follow-up found during release: a session can own several goals over
// time (finish one, start the next). On reload the engine mirrors EVERY goal
// on disk into `runs`, keyed by session — so the alphabetically-last folder won
// and a COMPLETE sibling shadowed the live run. Observed on the real v0.4.1 hot
// reload: goal_status reported the previous, finished goal for the live session.

const DONE = "status: ok - shadowing check\n"

test("after a reload the session's active goal is the running one, not a completed sibling", async () => {
  const host = await goalHost(script((_request, turn) => {
    if (turn.trigger.includes("Older finished goal")) {
      if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
      if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
      if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written", evidence: { C1: "file", C2: "grep", C3: "states it" } } }] }
    }
    return !turn.results ? { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold for shadowing check" } }] } : { text: "Holding." }
  }, () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "states it", evidence: [{ path: "done.txt", quote: DONE.trim() }] }] } }] })), {
    // The COMPLETE goal sorts LAST, exactly like the real incident (a live
    // "divergence-…" shadowed by a completed "unblock-…"): the last folder won.
    ".opencode/goals/z-finished/goal.yaml": DEMO_GOAL.replace("id: demo", "id: z-finished").replace("title: Demo file says ok", "title: Older finished goal"),
    ".opencode/goals/a-live/goal.yaml": DEMO_GOAL.replace("id: demo", "id: a-live").replace("title: Demo file says ok", "title: Live goal in the same session"),
  })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start z-finished" } as never)
    const finished = await waitStatus(host, ["complete"], 60000, "z-finished")
    expect(finished.status).toBe("complete")

    await host.client.session.command({ sessionID: owner, name: "goal", text: "start a-live" } as never)
    const live = await waitStatus(host, ["waiting"], 20000, "a-live")

    // A host reload rebuilds every mirrored run from disk.
    await host.client.location.reload()

    const active = await until(async () => {
      const snapshot: any = await host.client.rpc(GoalRpc).snapshot({ sessionID: owner }).catch(() => undefined)
      return snapshot?.view?.slug === "a-live" ? snapshot : undefined
    }, 20000)
    expect(active.view.slug).toBe("a-live")
    // A clean reload resumes the live run (v0.8.0 C1); the point is that the
    // session reports the LIVE goal and not the completed sibling.
    expect(["running", "waiting"]).toContain(active.view.status)
    // and the reload did not pause it for the owner
    expect(active.view.reason ?? "").not.toContain("host restarted")
    expect(active.view.target).toMatchObject({ key: `live:a-live:${live.runId}`, runId: live.runId, lock: live.lock, sessionID: owner })
    // The finished goal is still intact on disk and reported terminal.
    expect((await run(host, "z-finished")).status).toBe("complete")
  } finally { await host.stop() }
}, 120000)
