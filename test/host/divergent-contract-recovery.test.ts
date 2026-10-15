import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { DEMO_GOAL, goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T101 / axiom release-lane-completion: the disk goal.yaml is ahead of the
// locked contract through an UNJOURNALLED edit. A pending proposal whose
// nextLock equals the disk bytes exists, its author session is gone and it
// carries no commit. v0.3.15 refused every path (stage, accept, resume,
// /goal amend confirm). The owner must be able to review the exact
// difference from ANY live session and adopt or restore it; the old
// proposal is never counted as consent.

const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const DISK = DEMO_GOAL.replace("Demo file says ok", "Disk edit title")
const amendments = async (host: Awaited<ReturnType<typeof goalHost>>) =>
  Object.values((await Bun.file(join(host.project, ".opencode/goals/.owner-amendments.json")).json().catch(() => ({ requests: {} }))).requests) as Array<Record<string, any>>

function worker(state: { lock: string }) {
  return script((_request, turn) => {
    const form = turn.trigger.split("\n").find((line) => line.startsWith("GOAL_FORM_JSON:") || line.startsWith("GOAL_DECISION_JSON:"))
    if (form && !turn.results) return { toolCalls: [{ name: "question", args: JSON.parse(form.slice(form.indexOf(":") + 1)) }] }
    if (turn.trigger === "STAGE" && !turn.results)
      return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "demo", expectedLock: state.lock, yaml: DISK, rationale: "raise the title (axiom shape)" } }] }
    if (turn.trigger === "RECOVER" && !turn.results)
      return { toolCalls: [{ name: "goal_recover_divergence", args: { slug: "demo", expectedLock: state.lock } }] }
    if (turn.trigger === "STAGE" || turn.trigger === "RECOVER") return { text: "Recorded." }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold for recovery scenario" } }] }
    return { text: "Holding." }
  })
}

async function answer(host: Awaited<ReturnType<typeof goalHost>>, sessionID: string, label: string) {
  const form = await until(async () => (await host.client.session.form.list({ sessionID })).find((f) => JSON.stringify(f).includes("Adopt disk version")), 15000)
  const field = form.fields[0]!
  if (field.type !== "string") throw new Error("Expected recovery choice")
  const question = `${field.title ?? ""}\n${field.description ?? ""}`
  const choice = field.options!.find((option) => option.label === label)!
  await host.client.session.form.reply({ sessionID, formID: form.id, answer: { [field.key]: choice.value } })
  return question
}

test("axiom shape: disk == unaccepted nextLock, dead author, no journal — owner adopts from another live session", async () => {
  const state = { lock: "" }
  const host = await goalHost(worker(state), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const owner = await newSession(host), author = await newSession(host), rescuer = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    const initial = await waitStatus(host, ["waiting"], 15000)
    state.lock = initial.lock
    await host.client.session.prompt({ sessionID: author, text: "STAGE" } as never)
    const proposal = await until(async () => (await amendments(host)).find((p) => p.sessionID === author), 10000)
    expect(proposal.nextLock).toBe(sha(DISK))
    // The author session wrote the proposed bytes directly, then died.
    await Bun.write(join(host.project, ".opencode/goals/demo/goal.yaml"), DISK)
    await host.client.session.remove({ sessionID: author } as never).catch(() => {})
    expect(proposal.commit).toBeUndefined()

    await host.client.session.prompt({ sessionID: rescuer, text: "RECOVER" } as never)
    const question = await answer(host, rescuer, "Adopt disk version")
    // The review shows the exact difference and last-writer provenance.
    expect(question).toContain(initial.lock)
    expect(question).toContain(sha(DISK))
    expect(question).toContain("Disk edit title")
    expect(question).toContain(proposal.id)
    expect(question).toMatch(/no commit|not accepted/i)

    const adopted = await until(async () => { const r = await run(host); return r.lock === sha(DISK) ? r : undefined }, 15000)
    expect(adopted.runId).toBe(initial.runId)
    expect(adopted.status).toBe("paused")
    const events = await ledger(host)
    expect(events.some((e) => e.type === "divergence-adopted" && e.by === "owner" && e.newLock === sha(DISK) && e.oldLock === initial.lock)).toBe(true)
    expect(events.filter((e) => e.type === "amended")).toHaveLength(1)
    expect(events.filter((e) => e.type === "resumed")).toHaveLength(0)
    // The old proposal was superseded, never replayed as acceptance.
    const old = (await amendments(host)).find((p) => p.id === proposal.id)!
    expect(old.status).toBe("cancelled")
    expect(old.commit).toBeUndefined()
    const evidenceDir = join(host.project, ".opencode/goals/demo/evidence", initial.runId)
    expect(readdirSync(evidenceDir).some((f) => f === `contract-${sha(DISK)}.yaml`)).toBe(true)
    // No pending review is left to block resume.
    expect((await amendments(host)).filter((p) => p.slug === "demo" && ["pending", "interrupted", "executing"].includes(p.status))).toHaveLength(0)
  } finally { await host.stop() }
}, 60000)

test("restore locked version puts the locked bytes back and preserves the divergent bytes as evidence", async () => {
  const state = { lock: "" }
  const host = await goalHost(worker(state), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const owner = await newSession(host), rescuer = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    const initial = await waitStatus(host, ["waiting"], 15000)
    state.lock = initial.lock
    await Bun.write(join(host.project, ".opencode/goals/demo/goal.yaml"), DISK)
    await host.client.session.prompt({ sessionID: rescuer, text: "RECOVER" } as never)
    await answer(host, rescuer, "Restore locked version")
    await until(async () => sha(await host.readProject(".opencode/goals/demo/goal.yaml")) === initial.lock, 15000)
    expect((await run(host)).lock).toBe(initial.lock)
    const events = await ledger(host)
    expect(events.some((e) => e.type === "divergence-restored" && e.by === "owner" && e.discardedLock === sha(DISK))).toBe(true)
    expect(events.filter((e) => e.type === "amended")).toHaveLength(0)
    const evidenceDir = join(host.project, ".opencode/goals/demo/evidence", initial.runId)
    const kept = readdirSync(evidenceDir).find((f) => f.startsWith("divergent-") && f.includes(sha(DISK)))
    expect(kept).toBeDefined()
    expect(await Bun.file(join(evidenceDir, kept!)).text()).toBe(DISK)
  } finally { await host.stop() }
}, 60000)

test("leave unchanged changes nothing; recovery is refused when nothing diverged", async () => {
  const state = { lock: "" }
  const host = await goalHost(worker(state), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const owner = await newSession(host), rescuer = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    const initial = await waitStatus(host, ["waiting"], 15000)
    state.lock = initial.lock
    await host.client.session.prompt({ sessionID: rescuer, text: "RECOVER" } as never)
    await until(async () => host.fixture.requests.some((r) => JSON.stringify(r.messages).includes("does not differ")), 10000)
    expect(await host.client.session.form.list({ sessionID: rescuer })).toHaveLength(0)

    await Bun.write(join(host.project, ".opencode/goals/demo/goal.yaml"), DISK)
    await host.client.session.prompt({ sessionID: rescuer, text: "RECOVER" } as never)
    await answer(host, rescuer, "Leave unchanged")
    await until(async () => (await ledger(host)).some((e) => e.type === "divergence-left"), 10000)
    expect((await run(host)).lock).toBe(initial.lock)
    expect(await host.readProject(".opencode/goals/demo/goal.yaml")).toBe(DISK)
    expect((await ledger(host)).filter((e) => e.type === "amended" || e.type === "divergence-restored")).toHaveLength(0)
  } finally { await host.stop() }
}, 60000)
