import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { parseContract } from "../../src/contract/parse"
import { initialRun } from "../../src/engine/state"
import { GoalRpc } from "../../src/rpc"
import { goalHost, newSession, run, script, text, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T188 — `ocg migrate` through the goal UX.
//
// The dry run is the same read-only plan the CLI prints (`writes: 0`, no file
// touched). The move is a NATIVE owner decision bound to the exact plan digest:
// a worker's `goal_migrate {confirm:true}` is refused, and the owner's answered
// review copies only the migratable folders, skipping every live run and
// keeping the legacy copy byte-identical.

const contractText = (slug: string) => `schema: goal/v1
id: ${slug}
title: ${slug} goal
intent:
  verbatim: "keep ${slug} history"
outcome: ${slug} reports its own separate completion
non_goals: [z]
criteria:
  - id: C1
    statement: s
    check: {kind: file, path: f}
`

/** A legacy folder the move is allowed to carry. */
function finishedGoal(slug: string, status?: "complete"): Record<string, string> {
  const parsed = parseContract(contractText(slug), { slug })
  const run = initialRun(parsed.contract!, { sessionID: `ses_${slug}`, runId: `r_${slug}`, lock: parsed.lock, now: 1000 })
  if (status) run.status = status
  return {
    [`.opencode/goals/${slug}/goal.yaml`]: contractText(slug),
    [`.opencode/goals/${slug}/run.json`]: `${JSON.stringify(run, null, 2)}\n`,
    [`.opencode/goals/${slug}/ledger.jsonl`]: `${JSON.stringify({ t: 1, type: "note" })}\n`,
  }
}

/** Every file under `dir` (relative path → sha256), for byte-identity checks. */
function snapshot(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      const child = join(current, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) out[relative(base, child)] = createHash("sha256").update(readFileSync(child)).digest("hex")
    }
  }
  visit(dir)
  return out
}

test("the goal-side migration surface: dry run writes nothing, the native owner confirmation moves only finished goals, and a worker cannot confirm", async () => {
  let sawMigrateTool = false
  let askedForm = false
  let triedWorkerMove = false
  let waited = false
  const host = await goalHost(script((req) => {
    const lines = req.messages.map(text).join("\n").split("\n")
    const payload = lines.findLast((s) => s.startsWith("GOAL_DECISION_JSON:"))
    const presentation = lines.findLast((s) => s.startsWith("GOAL_DECISION_ASK:"))
    if (payload && presentation && !askedForm) {
      askedForm = true
      return { toolCalls: [{ name: "question", args: JSON.parse(payload.slice("GOAL_DECISION_JSON:".length)) }] }
    }
    sawMigrateTool ||= (req.tools ?? []).some((tool) => tool.function.name === "goal_migrate")
    // A worker tries to authorize the move itself. The host must refuse: only
    // the owner's answered review may execute it.
    if (!triedWorkerMove) {
      triedWorkerMove = true
      return { toolCalls: [{ name: "goal_migrate", args: { confirm: true } }] }
    }
    if (!waited) {
      waited = true
      return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "waiting for the owner's migration review" } }] }
    }
    return { text: "Waiting for the owner's migration review." }
  }), { ...finishedGoal("finished", "complete"), ".opencode/goals/draft/goal.yaml": contractText("draft") })

  try {
    const primary = await newSession(host)
    const rpc = (host.client as any).rpc(GoalRpc)

    // 1) Dry run before any goal runs: the plan, writes 0, not one byte touched.
    const before = snapshot(host.project)
    const plan = await rpc.migrate({ sessionID: primary })
    expect(plan).toMatchObject({ schemaVersion: 1, dryRun: true, writes: 0 })
    expect(plan.source.goals).toBe(".opencode/goals")
    expect(plan.target.goals).toBe(".cleo/goals")
    expect(plan.goals.map((goal: { slug: string }) => goal.slug).sort()).toEqual(["demo", "draft", "finished"])
    expect(snapshot(host.project)).toEqual(before)
    expect(existsSync(join(host.project, ".cleo", "goals"))).toBe(false)

    // 2) Start the demo goal: it lives in the legacy store and is LIVE, so the
    //    move must report and skip it. The kickoff also tries the worker move.
    await host.client.session.command({ sessionID: primary, name: "goal", text: "start demo" } as any)
    await waitStatus(host, ["waiting"], 20000)
    expect(sawMigrateTool).toBe(true)
    expect(existsSync(join(host.project, ".cleo", "goals", "finished"))).toBe(false)
    expect(existsSync(join(host.project, ".cleo", "goals", "draft"))).toBe(false)

    const livePlan = await rpc.migrate({ sessionID: primary })
    expect(livePlan.goals.find((goal: { slug: string }) => goal.slug === "demo")).toMatchObject({ status: "waiting", migratable: false })
    expect(livePlan.goals.find((goal: { slug: string }) => goal.slug === "demo").reason).toContain("finish, stop or abort")

    // 3) `confirm` offers a native owner review and moves nothing by itself.
    const legacyFinished = snapshot(join(host.project, ".opencode", "goals", "finished"))
    const legacyDraft = snapshot(join(host.project, ".opencode", "goals", "draft"))
    const offered = await rpc.migrate({ sessionID: primary, confirm: true })
    expect(offered).toMatchObject({ ok: true, pending: true })
    expect(existsSync(join(host.project, ".cleo", "goals", "finished"))).toBe(false)

    // 4) The owner answers the exact review (the same authority path as abort).
    const forms = async () => {
      const listed: any[] = await (host.client.session.form as any).list({ sessionID: primary })
      return listed.find((form) => form.fields.some((field: any) => field.options?.some((o: any) => o.label.startsWith("Move into .cleo/goals/"))))
    }
    const form = await until(forms, 20000)
    const field = form.fields[0]
    await (host.client.session.form as any).reply({ sessionID: primary, formID: form.id, answer: { [field.key]: field.options.find((o: any) => o.label.startsWith("Move into .cleo/goals/")).value } })

    // 5) Only the migratable folders landed; the legacy tree is byte-identical
    //    (including the live demo run, which was NOT moved).
    await until(() => existsSync(join(host.project, ".cleo", "goals", "finished", "goal.yaml")) && existsSync(join(host.project, ".cleo", "goals", "draft", "goal.yaml")), 20000)
    expect(existsSync(join(host.project, ".cleo", "goals", "demo"))).toBe(false)
    expect(snapshot(join(host.project, ".cleo", "goals", "finished"))).toEqual(legacyFinished)
    expect(snapshot(join(host.project, ".cleo", "goals", "draft"))).toEqual(legacyDraft)
    // the legacy copies are retained, byte for byte
    expect(snapshot(join(host.project, ".opencode", "goals", "finished"))).toEqual(legacyFinished)
    expect(snapshot(join(host.project, ".opencode", "goals", "draft"))).toEqual(legacyDraft)

    // the live run is still the resolved live goal after the copy
    expect((await run(host)).status).toBe("waiting")
  } finally { await host.stop() }
}, 120000)
