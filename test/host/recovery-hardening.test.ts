import { expect, test } from "bun:test"
import { join } from "node:path"
import { lockOf, parseContract } from "../../src/contract/parse"
import { initialRun } from "../../src/engine/state"
import { GoalRpc } from "../../src/rpc"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script } from "./goal.helpers"
import { until } from "./harness"

// T124 recovery hardening. Two live agents were bricked today (0.9.4) by the
// D10 class: a contract locked under an older, laxer validator is unreadable by
// the current one. Two gaps remained after the D10 fix (repro messages
// 01M61Q6A5ASQN4TJTA4C5RH5PT and 01M626VSSH4SV5JBJNQD17PXEN):
//   A. goal_propose_amendment looked the run up only in the in-memory `runs`
//      map, so a paused run read from disk (reload window, or recovered by
//      another session) answered "No live run for the selected goal" and the
//      one-key repair was unreachable.
//   B. contractOf() strict-parsed the locked evidence snapshot, so
//      goal_recover_divergence answered "The locked contract snapshot is
//      unavailable" and resume could not read the prior either.

const SEEDED = "ses_recoveryhardening000000"
const RUN = "recover1"
const INVALID = `${DEMO_GOAL}budget:\n  turns: 100\n  rationale: 'owner raised the cap twice; this note predates the strict validator'\n`
const FIXED = `${DEMO_GOAL}budget:\n  turns: 100\n`
const DISK_EDIT = DEMO_GOAL.replace("Demo file says ok", "Disk edit title")
const invalidLock = parseContract(INVALID).lock
const fixedLock = lockOf(FIXED)
const diskLock = lockOf(DISK_EDIT)
const snapshot = `.opencode/goals/demo/evidence/${RUN}/contract-${invalidLock}.yaml`

/** A paused run whose lock is the invalid generation, exactly as a 0.9.2 host left it. */
function pausedRun(sessionID: string) {
  const state = initialRun(parseContract(INVALID, { tolerateUnknownBudgetKeys: true }).contract!, { sessionID, runId: RUN, lock: invalidLock })
  state.status = "paused"
  state.reason = "contract unavailable after restart; resume when ready"
  return JSON.stringify(state, null, 2)
}

function worker(lock: { value: string }, seen: string[]) {
  return script((_request, turn) => {
    const form = turn.trigger.split("\n").find((line) => line.startsWith("GOAL_FORM_JSON:"))
    if (form && !turn.results) return { toolCalls: [{ name: "question", args: JSON.parse(form.slice(form.indexOf(":") + 1)) }] }
    if (turn.trigger === "FIX" && !turn.results)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "demo", expectedLock: lock.value, yaml: FIXED, rationale: "drop the budget.rationale metadata key rejected by the tightened validator" } }] }
    if (turn.trigger === "RECOVER" && !turn.results)
      return { toolCalls: [{ name: "goal_recover_divergence", args: { slug: "demo", expectedLock: lock.value } }] }
    if (turn.trigger === "FIX" || turn.trigger === "RECOVER") {
      seen.push(turn.all)
      return { text: "Recorded." }
    }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold for the recovery scenario" } }] }
    return { text: "Holding." }
  })
}

async function choose(host: Awaited<ReturnType<typeof goalHost>>, sessionID: string, marker: string, label: string) {
  const form = await until(async () => (await host.client.session.form.list({ sessionID })).find((f) => JSON.stringify(f).includes(marker)), 15000)
  const field: any = form.fields[0]!
  const choice = field.options.find((option: any) => option.label === label)!
  await host.client.session.form.reply({ sessionID, formID: form.id, answer: { [field.key]: choice.value } })
  return form
}

test("T124/A: a paused run that exists only on disk can stage the one-key repair", async () => {
  const seen: string[] = []
  const lock = { value: invalidLock }
  const host = await goalHost(worker(lock, seen), { ".opencode/goals/demo/goal.yaml": INVALID })
  try {
    const owner = await newSession(host)
    // Wait until the engine's RPC answers: setup (and recover()) has completed,
    // so the run we write next can never be mirrored. This is the reload
    // window, or a run another session recovered: THIS process has no entry in
    // `runs`, which is exactly what made the amendment unreachable.
    const rpc: any = (host.client as any).rpc(GoalRpc)
    await until(async () => {
      try { await rpc.list({}); return true } catch { return false }
    }, 30000)
    await Bun.write(join(host.project, ".opencode/goals/demo/run.json"), pausedRun(owner))

    await host.client.session.prompt({ sessionID: owner, text: "FIX" } as never)
    await choose(host, owner, "Accept amendment", "Accept amendment")

    const repaired = await until(async () => { const r = await run(host); return r.lock === fixedLock ? r : undefined }, 15000)
    expect(repaired.slug).toBe("demo")
    expect(repaired.runId).toBe(RUN)
    const events = await ledger(host)
    expect(events.some((e) => e.type === "amendment-staged")).toBe(true)
    expect(events.some((e) => e.type === "amended" && e.newLock === fixedLock)).toBe(true)
    // The refusal the old lookup produced never reached the model.
    expect(seen.join("\n")).not.toContain("No live run for the selected goal")
  } finally { await host.stop() }
}, 60000)

test("T124/B: a locked snapshot that predates the validator backs divergence recovery", async () => {
  const seen: string[] = []
  const lock = { value: invalidLock }
  const host = await goalHost(worker(lock, seen), {
    ".opencode/goals/demo/goal.yaml": DISK_EDIT,
    ".opencode/goals/demo/run.json": pausedRun(SEEDED),
    [snapshot]: INVALID,
  })
  try {
    const rescuer = await newSession(host)
    await host.client.session.prompt({ sessionID: rescuer, text: "RECOVER" } as never)
    // Before the tolerant prior this was "The locked contract snapshot is
    // unavailable; nothing changed" and no review was ever staged.
    const form = await choose(host, rescuer, "Adopt disk version", "Adopt disk version")
    expect(JSON.stringify(form)).toContain(invalidLock)
    expect(JSON.stringify(form)).toContain(diskLock)

    const adopted = await until(async () => { const r = await run(host); return r.lock === diskLock ? r : undefined }, 15000)
    expect(adopted.status).toBe("paused")
    expect((await ledger(host)).some((e) => e.type === "divergence-adopted" && e.by === "owner" && e.oldLock === invalidLock && e.newLock === diskLock)).toBe(true)
    expect(seen.join("\n")).not.toContain("locked contract snapshot is unavailable")
  } finally { await host.stop() }
}, 60000)

test("T124/B: a paused run whose locked bytes predate the validator can resume", async () => {
  const seen: string[] = []
  const lock = { value: invalidLock }
  const host = await goalHost(worker(lock, seen), {
    ".opencode/goals/demo/goal.yaml": INVALID,
    ".opencode/goals/demo/run.json": pausedRun(SEEDED),
    [snapshot]: INVALID,
  })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "resume" } as never)
    // Before the tolerant prior, admit() refused with "contract unavailable"
    // and the run stayed paused at turn 0 with no admission.
    const events = await until(async () => {
      const read = await ledger(host)
      return read.some((e) => e.type === "admit" && e.kind === "resume") ? read : undefined
    }, 15000)
    const admitted = events.findLast((e) => e.type === "admit" && e.kind === "resume")!
    expect(admitted.turn).toBe(1)
    expect(events.some((e) => e.type === "resumed")).toBe(true)
    const state = await run(host)
    expect(state.reason ?? "").not.toContain("contract unavailable")
  } finally { await host.stop() }
}, 60000)
