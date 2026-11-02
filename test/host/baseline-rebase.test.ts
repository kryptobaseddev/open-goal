import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until, type ChatRequest } from "./harness"

// T183 — a merged oracle update needs no contract amendment.
//
// Live case (2026-11-02): commit 8642180 changed
// test/host/ask-tool-decisions.test.ts (a protected oracle) after a store-goal
// run had started, so `changedSince(base.commit)` named a path the worker never
// touched and every claim failed INTEGRITY. The only workarounds were withdrawing
// the protect entry by amendment or restoring the old oracle bytes.
//
// This pins the supported route: an OWNER-only baseline rebase moves
// run.base.commit, leaves goal.yaml and the protect list byte-identical, stops
// flagging the already-merged change, and still catches a protected edit made
// AFTER the new baseline. A worker tool call can never move the baseline.

const WRONG = "status: not yet\n"
const CLAIM = { summary: "done.txt written; oracle untouched", evidence: { C1: "done.txt exists", C2: "grep checks the line" } }

const GOAL = `schema: goal/v1
id: rebase-demo
title: Baseline rebase keeps the oracle honest
intent:
  verbatim: "prove a merged oracle update stops tripping INTEGRITY after an owner rebase"
outcome: done.txt states that the status is ok and the worker never edits the oracle
non_goals:
  - Touching oracle.txt
criteria:
  - id: C1
    statement: done.txt SHALL exist
    check: {kind: file, path: done.txt}
  - id: C2
    statement: 'done.txt SHALL contain the line "status: ok"'
    check: {kind: command, run: "grep -q 'status: ok' done.txt"}
protect: ["oracle.txt"]
verification: {mode: host, max_rejections: 5}
plan:
  - {id: S1, title: Write done.txt, proves: [C1, C2]}
`

type Host = Awaited<ReturnType<typeof goalHost>>

/** Land a commit in the project, as a merged upstream change would. */
function commitFile(host: Host, rel: string, content: string, message: string): string {
  writeFileSync(join(host.project, rel), content)
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: host.project, env })
  git("add", rel)
  git("commit", "-q", "-m", message)
  return git("rev-parse", "HEAD").stdout.toString().trim()
}

const verdicts = async (host: Host) => (await ledger(host, "rebase-demo")).filter((e) => e.type === "verdict")
const integrityOf = (verdict: any) => (verdict.lines as string[]).filter((l) => l.startsWith("INTEGRITY"))

/** The worker's next turn: claim, or hold while the owner acts. */
function worker(target: () => Record<string, unknown>) {
  return script((_req: ChatRequest, turn) => {
    if (turn.trigger.includes("goal started")) {
      if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: WRONG } }] }
      if (turn.results === 1) return { toolCalls: [{ name: "goal_wait", args: { seconds: 900, reason: "waiting for the owner to re-baseline" } }] }
      return { text: "Holding for the owner." }
    }
    if (turn.trigger.includes("host verdict")) {
      if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 900, reason: "waiting for the owner to re-baseline" } }] }
      return { text: "Holding for the owner." }
    }
    if (turn.trigger.includes("CLAIM_NOW")) {
      if (turn.results === 0) return { toolCalls: [{ name: "goal_claim", args: CLAIM }] }
      return { text: "claimed" }
    }
    if (turn.trigger.includes("WORKER_REBASE")) {
      // A worker asking the engine to move its own verification baseline.
      if (turn.results === 0) return { toolCalls: [{ name: "goal_manage", args: { action: "rebase", target: target() } }] }
      return { text: "asked" }
    }
    return { text: "nothing to do" }
  })
}

describe("baseline rebase (T183)", () => {
  test("only the owner moves run.base.commit; a merged oracle change stops tripping INTEGRITY and a later edit is still caught", async () => {
    let target: Record<string, unknown> = {}
    const host = await goalHost(worker(() => target), { ".opencode/goals/rebase-demo/goal.yaml": GOAL })
    try {
      const sessionID = await newSession(host)
      await host.client.session.command({ sessionID, name: "goal", text: "start rebase-demo" } as any)

      // 1. The run starts at commit A; the worker writes done.txt (wrong on
      //    purpose so no claim can ever complete) and then holds.
      const started = await waitStatus(host, ["waiting"], 30000, "rebase-demo")
      const baseA = started.base.commit as string
      expect(baseA).toMatch(/^[0-9a-f]{40}$/)
      target = { key: `live:rebase-demo:${started.runId}`, lock: started.lock, runId: started.runId, sessionID }
      const contractBefore = await host.readProject(".opencode/goals/rebase-demo/goal.yaml")

      // 2. A merged upstream change lands on the protected oracle — the live
      //    8642180 case, committed on main after the run's base.
      const headB = commitFile(host, "oracle.txt", "do not edit — merged D5 oracle update\n", "test: merged oracle update")
      expect(headB).not.toBe(baseA)

      // 3. Claiming now reports INTEGRITY for a file the worker never touched.
      await host.client.session.prompt({ sessionID, text: "CLAIM_NOW after the merged oracle update" } as any)
      const first = await until(async () => (await verdicts(host))[0], 60000)
      const firstIntegrity = integrityOf(first)
      expect(firstIntegrity.some((l) => l.includes("oracle.txt"))).toBe(true)

      // 4. A worker cannot invoke the act: goal_manage refuses, nothing moves,
      //    and the contract stays byte-identical.
      await waitStatus(host, ["waiting"], 30000, "rebase-demo")
      const receipts = async () => (await ledger(host, "rebase-demo")).filter((e) => e.type === "baseline-rebase")
      await host.client.session.prompt({ sessionID, text: "WORKER_REBASE move my baseline to the merged commit" } as any)
      await until(() => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("owner-only act")), 30000)
      expect(await receipts()).toHaveLength(0)
      expect((await run(host, "rebase-demo")).base.commit).toBe(baseA)
      expect(await host.readProject(".opencode/goals/rebase-demo/goal.yaml")).toBe(contractBefore)

      // 5. The owner rebases to the named commit: run.base.commit moves, one
      //    receipt names the old and new commits and the owner.
      await host.client.session.command({ sessionID, name: "goal", text: `rebase ${headB}` } as any)
      const receipt = await until(async () => (await receipts())[0], 30000)
      expect(receipt).toMatchObject({ type: "baseline-rebase", by: "owner", from: baseA, to: headB, requested: headB, status: expect.stringMatching(/waiting|running/) })
      expect((await run(host, "rebase-demo")).base.commit).toBe(headB)

      // 6. The same claim no longer reports INTEGRITY for the merged change —
      //    it still fails C2, so the run stays live.
      await host.client.session.prompt({ sessionID, text: "CLAIM_NOW after the rebase" } as any)
      const second = await until(async () => (await verdicts(host))[1], 60000)
      expect(integrityOf(second)).toEqual([])
      expect(second.lines.join("\n")).toContain("C2 FAILED")

      // 7. The guard is not weakened: a protected edit made AFTER the new
      //    baseline is still caught.
      await waitStatus(host, ["waiting"], 30000, "rebase-demo")
      writeFileSync(join(host.project, "oracle.txt"), "the worker changed the oracle after the rebase\n")
      await host.client.session.prompt({ sessionID, text: "CLAIM_NOW after editing the oracle" } as any)
      const third = await until(async () => (await verdicts(host))[2], 60000)
      expect(integrityOf(third).some((l) => l.includes("oracle.txt"))).toBe(true)

      // 8. Additive throughout: the contract, its protect list and the single
      //    owner receipt are the only record of the move.
      expect(await host.readProject(".opencode/goals/rebase-demo/goal.yaml")).toBe(contractBefore)
      expect((await run(host, "rebase-demo")).lock).toBe(started.lock)
      expect((await run(host, "rebase-demo")).base.commit).toBe(headB)
      expect(await receipts()).toHaveLength(1)
    } finally {
      await host.stop()
    }
  }, 240000)
})
