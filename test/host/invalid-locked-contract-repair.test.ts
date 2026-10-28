import { expect, test } from "bun:test"
import { parseContract } from "../../src/contract/parse"
import { initialRun } from "../../src/engine/state"
import { DEMO_GOAL, goalHost, newSession, run, script } from "./goal.helpers"
import { until } from "./harness"

// Live report (axiom-instrument-studio, goal cbl514-scrutiny-ready, run
// 17122c97c001, turn 574): a contract locked by an earlier, laxer validator
// carried a free-text `budget.rationale` key. After the D9 tightening the
// LOCKED bytes no longer parse, so resume refused as "read-only", the
// amendment refused as "disk differs", and recovery said "nothing to recover"
// — three different answers and no path from the worker side. The disk was
// never edited; the lock was computed before the validator changed.

const SEEDED = "ses_seededinvalidcontract0000000"
const RUN = "seedr1"
const INVALID = `${DEMO_GOAL}budget:\n  turns: 100\n  rationale: 'owner raised the cap twice; this note predates the strict validator'\n`
const FIXED = `${DEMO_GOAL}budget:\n  turns: 100\n`
const lock = parseContract(INVALID).lock
const fixedLock = parseContract(FIXED).lock
const contract = parseContract(INVALID, { tolerateUnknownBudgetKeys: true }).contract!

const seededState = (() => {
  const state = initialRun(contract, { sessionID: SEEDED, runId: RUN, lock })
  state.status = "paused"
  state.reason = "contract unavailable after restart; resume when ready"
  return state
})()

function worker(seen: string[]) {
  return script((_req, turn) => {
    const form = turn.trigger.split("\n").find((line) => line.startsWith("GOAL_FORM_JSON:"))
    if (form && !turn.results) return { toolCalls: [{ name: "question", args: JSON.parse(form.slice(form.indexOf(":") + 1)) }] }
    if (turn.trigger === "RESUME" && !turn.results)
      return { toolCalls: [{ name: "goal_manage", args: { action: "resume", target: { key: `live:demo:${RUN}`, lock, runId: RUN, sessionID: SEEDED } } }] }
    if (turn.trigger === "FIX" && !turn.results)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "demo", expectedLock: lock, yaml: FIXED, rationale: "drop the budget.rationale metadata key rejected by the tightened validator" } }] }
    if (turn.trigger === "RESUME" || turn.trigger === "FIX") {
      seen.push(turn.all)
      return { text: "Recorded." }
    }
    return { text: "Holding." }
  })
}

test("a contract invalid under the current validator names the key and can be repaired by amendment", async () => {
  const seen: string[] = []
  const host = await goalHost(worker(seen), {
    ".opencode/goals/demo/goal.yaml": INVALID,
    ".opencode/goals/demo/run.json": JSON.stringify(seededState, null, 2),
  })
  try {
    const owner = await newSession(host)

    // 1. Resume must name the real cause and the supported repair, never the
    //    generic "read-only draft" refusal or "nothing to recover".
    await host.client.session.prompt({ sessionID: owner, text: "RESUME" } as never)
    await until(async () => (seen.length ? seen : undefined), 15000)
    const refusal = seen.join("\n")
    expect(refusal).toContain("budget.rationale")
    expect(refusal).toContain("goal_propose_amendment")
    expect(refusal).not.toContain("read-only (draft, archived or invalid)")
    expect((await run(host)).status).toBe("paused")

    // 2. The worker can stage the repair even though the current bytes do not
    //    parse: the diff is taken from the lenient prior, the next text is
    //    validated strictly, and the owner still reviews it.
    await host.client.session.prompt({ sessionID: owner, text: "FIX" } as never)
    const form = await until(async () => (await host.client.session.form.list({ sessionID: owner })).find((f) => JSON.stringify(f).includes("Accept amendment")), 15000)
    const field: any = form.fields[0]!
    const choice = field.options.find((option: any) => option.label === "Accept amendment")!
    await host.client.session.form.reply({ sessionID: owner, formID: form.id, answer: { [field.key]: choice.value } })

    const repaired = await until(async () => { const r = await run(host); return r.lock === fixedLock ? r : undefined }, 15000)
    expect(repaired.lock).toBe(fixedLock)
    expect(repaired.slug).toBe("demo")
  } finally {
    await host.stop()
  }
}, 60000)
