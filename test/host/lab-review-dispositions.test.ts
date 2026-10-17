import { expect, test } from "bun:test"
import { join } from "node:path"
import { GoalRpc } from "../../src/rpc"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

const observer = join(import.meta.dir, "../fixtures/lab-tool-boundary")
const statuses = ["succeeded", "failed", "rejected", "commented", "cancelled", "executing"] as const

test("settled decision diagnostics are owned, non-executing and durable; pending changed targets still fail", async () => {
  const host = await goalHost(script((_request, turn) => turn.results === 0 && !turn.trigger.includes("GOAL_DECISION_JSON:")
    ? { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "inspect review dispositions" } }] }
    : { text: "No owner consent supplied." }))
  try {
    const owner = await newSession(host), actor = await newSession(host), foreign = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    const initial = await waitStatus(host, ["waiting"], 15000)
    const rpc = host.client.rpc(GoalRpc)
    const target = { key: `live:demo:${initial.runId}`, runId: initial.runId, lock: initial.lock, sessionID: owner }
    const receiptFile = join(host.project, ".opencode/goals/.owner-decisions.json")
    for (const status of statuses) {
      const prepared = await rpc.manage({ sessionID: actor, action: "abort", target }) as { decisionId: string }
      // Trusted isolated fixture simulates persisted outcomes, not owner consent.
      const data = await Bun.file(receiptFile).json()
      const request = data.requests[prepared.decisionId]
      request.status = status
      request.result = `recorded ${status} outcome; not a new choice`
      request.target.status = "paused"
      await Bun.write(receiptFile, JSON.stringify(data))
      const before = await host.readProject(".opencode/goals/demo/run.json")
      const events = await ledger(host)
      const review = await rpc.review({ sessionID: actor, decisionId: request.id })
      expect(review).toMatchObject({ ok: false, actionExecuted: false })
      expect(JSON.stringify(review)).toContain(`Decision review is ${status}`)
      expect(JSON.stringify(review)).toContain(request.result)
      expect(JSON.stringify(await rpc.review({ sessionID: foreign, decisionId: request.id }))).not.toContain(request.result)
      expect(await host.readProject(".opencode/goals/demo/run.json")).toBe(before)
      expect(await ledger(host)).toEqual(events)
    }
    const prepared = await rpc.manage({ sessionID: actor, action: "abort", target }) as { decisionId: string }
    const data = await Bun.file(receiptFile).json()
    data.requests[prepared.decisionId].target.lock = "0".repeat(64)
    await Bun.write(receiptFile, JSON.stringify(data))
    const changed = await rpc.review({ sessionID: actor, decisionId: prepared.decisionId })
    expect(changed).toMatchObject({ ok: false, actionExecuted: false })
    expect(JSON.stringify(changed)).toContain("generation or owning session changed")
    // The settled receipts survive reload; no restored answer can execute them.
    await host.client.location.reload()
    const records = await Bun.file(receiptFile).json()
    for (const status of statuses) {
      const record = Object.values(records.requests).find((p) => (p as { result?: string }).result === `recorded ${status} outcome; not a new choice`) as { id: string }
      const review = await rpc.review({ sessionID: actor, decisionId: record.id })
      expect(JSON.stringify(review)).toContain(`Decision review is ${status === "executing" ? "failed" : status}`)
      if (status === "executing") expect(JSON.stringify(review)).toContain("uncertain outcome")
    }
    expect((await ledger(host)).filter((e) => e.type === "aborted" || e.type === "decision-resolved")).toHaveLength(0)
  } finally { await host.stop() }
}, 45000)

test("amendment disposition inspection never consumes chat or leaks another author's receipt, including expiry and reload", async () => {
  let decisionId = ""
  const host = await goalHost(script((_request, turn) => {
    if (turn.trigger === "INSPECT_RECEIPT" && !turn.results)
      return { toolCalls: [{ name: "goal_resolve_amendment", args: { decisionId, action: "accept", continueGoal: true } }] }
    if (turn.trigger === "INSPECT_RECEIPT") return { text: "No additional action." }
    if (turn.trigger.includes("GOAL_FORM_JSON:")) return { text: "No owner answer." }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold review target" } }] }
    return { text: "No consent supplied." }
  }), {}, { extraPlugins: [observer] })
  try {
    const owner = await newSession(host), actor = await newSession(host), foreign = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    const initial = await waitStatus(host, ["waiting"], 15000)
    const receiptFile = join(host.project, ".opencode/goals/.owner-amendments.json")
    const boundary = () => host.readProject("tool-boundary.jsonl").then((raw) => raw.trim().split("\n").map((line) => JSON.parse(line)))
    for (const status of [...statuses, "expired"] as const) {
      decisionId = `fixture-amendment-${status}`
      // Read-only negative/settled paths don't need staged YAML or consent.
      // An actual successful form application is covered by the protected oracle.
      const data = await Bun.file(receiptFile).json().catch(() => ({ version: 1, requests: {} }))
      data.requests[decisionId] = { id: decisionId, sessionID: actor, targetSessionID: owner, slug: "demo", runId: initial.runId,
        lock: initial.lock, nextLock: "0".repeat(64), title: "fixture receipt", question: "fixture only", createdAt: Date.now(), expiresAt: 0,
        expiryPolicy: "target", issuerPID: 0, status, result: `recorded ${status} outcome`, rationale: "fixture only", diff: [] }
      await Bun.write(receiptFile, JSON.stringify(data))
      const before = await host.readProject(".opencode/goals/demo/run.json")
      const events = await ledger(host)
      for (const sessionID of [actor, foreign]) {
        await host.client.session.prompt({ sessionID, text: "INSPECT_RECEIPT" } as never)
        await host.client.session.wait({ sessionID })
        const result = (await boundary()).findLast((e) => e.phase === "after" && e.tool === "goal_resolve_amendment")
        if (sessionID === foreign) {
          expect(result.status).toBe("error")
          expect(JSON.stringify(result.error)).not.toContain(`recorded ${status} outcome`)
        } else if (status === "executing") {
          expect(result.status).toBe("error")
          expect(JSON.stringify(result.error)).toContain("executing")
        } else {
          expect(result.status).toBe("completed")
          expect(result.result.metadata).toMatchObject({ ok: false, status, alreadyResolved: true, actionExecuted: false, decisionId })
          expect(result.result.metadata.result).toBe(`recorded ${status} outcome`)
          expect(result.result.metadata.continuation).toBeUndefined()
        }
      }
      expect(await host.readProject(".opencode/goals/demo/run.json")).toBe(before)
      expect(await ledger(host)).toEqual(events)
      expect((await Bun.file(receiptFile).json()).requests[decisionId].ownerMessageID).toBeUndefined()
    }
    decisionId = "fixture-amendment-time-expired"
    const data = await Bun.file(receiptFile).json()
    data.requests[decisionId] = { ...data.requests["fixture-amendment-expired"], id: decisionId, status: "pending", expiryPolicy: "time", expiresAt: Date.now() - 1 }
    await Bun.write(receiptFile, JSON.stringify(data))
    await host.client.session.prompt({ sessionID: actor, text: "INSPECT_RECEIPT" } as never)
    await host.client.session.wait({ sessionID: actor })
    expect(JSON.stringify((await boundary()).at(-1).error)).toContain("has expired")
    expect((await Bun.file(receiptFile).json()).requests[decisionId].status).toBe("pending")
    await host.client.location.reload()
    decisionId = "fixture-amendment-succeeded"
    await host.client.session.prompt({ sessionID: actor, text: "INSPECT_RECEIPT" } as never)
    await until(async () => (await boundary()).findLast((e) => e.phase === "after" && e.input?.decisionId === decisionId && e.result?.metadata?.alreadyResolved), 10000)
    expect((await ledger(host)).filter((e) => ["amended", "resumed", "owner-message-consumed"].includes(e.type))).toHaveLength(0)
    expect((await run(host)).lock).toBe(initial.lock)
  } finally { await host.stop() }
}, 60000)
