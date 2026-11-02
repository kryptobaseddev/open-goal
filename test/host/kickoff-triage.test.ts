import { expect, test } from "bun:test"
import { join } from "node:path"
import { lockOf } from "../../src/contract/parse"
import { goalHost, ledger, newSession, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// T167 — before a new goal is staged, the real engine compares it with the
// project inventory and routes the owner to continue / repair / consolidate /
// new. These host tests drive the actual opencode server: the existing goal
// reaches a real state (waiting, paused, blocked, draft), then a second draft
// is prepared and must be refused with the existing goal/run/lock named.

const INTENT = "export the quarterly ledger as a csv"
const OUTCOME = "ledger.csv contains every exported row"

const goal = (id: string) => `schema: goal/v1
id: ${id}
title: ${id} ledger export
intent:
  verbatim: "${INTENT}"
outcome: ${OUTCOME}
non_goals: [other files]
criteria:
  - id: C1
    statement: ledger.csv SHALL exist
    check: {kind: file, path: ledger.csv}
plan:
  - {id: S1, title: Write ledger.csv, proves: [C1]}
`

const candidateYaml = goal("candidate")

function worker(mode: "wait" | "block" = "wait") {
  return script((_req, turn) => {
    if (turn.trigger === "TRIAGE" && !turn.results)
      return { toolCalls: [{ name: "goal_prepare_launch", args: { slug: "candidate" } }] }
    if (turn.trigger === "TRIAGE") return { text: "No duplicate launch." }
    if (mode === "block" && turn.results === 0)
      return { toolCalls: [{ name: "goal_block", args: { key: "missing-ledger-token", reason: "the ledger export token is absent", needs: "credential" } }] }
    if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold the existing goal" } }] }
    return { text: "Holding." }
  })
}

type Message = { role?: string; content?: unknown }
async function toolResults(host: Awaited<ReturnType<typeof goalHost>>) {
  return (host.fixture.requests as Array<{ messages?: Message[] }>).flatMap((request) =>
    (request.messages ?? [])
      .filter((m) => m.role === "tool")
      // Tool results are nested JSON, so inner quotes arrive escaped.
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")).replace(/\\"/g, '"')),
  )
}

/** Run the actor's TRIAGE turn and return the kickoff-triage refusal it saw. */
async function refusal(host: Awaited<ReturnType<typeof goalHost>>, decision: string) {
  const actor = await newSession(host)
  await host.client.session.prompt({ sessionID: actor, text: "TRIAGE" } as never)
  await host.client.session.wait({ sessionID: actor } as never)
  return until(async () => (await toolResults(host)).findLast((text) => text.includes("kickoff triage") && text.includes(`: ${decision})`)), 15000)
}

/** The candidate draft is written only AFTER the existing goal is in its
 *  state, exactly like a later idea in a real project: the start of the
 *  existing goal is not triaged against its own future successor. */
async function writeCandidate(host: Awaited<ReturnType<typeof goalHost>>) {
  await Bun.write(join(host.project, ".opencode/goals/candidate/goal.yaml"), candidateYaml)
}

async function noCandidateLaunch(host: Awaited<ReturnType<typeof goalHost>>) {
  const store = JSON.parse(await host.readProject(".opencode/goals/.owner-launches.json").catch(() => '{"requests":{}}'))
  expect(Object.values(store.requests).some((request: any) => request.slug === "candidate")).toBe(false)
}

async function triageLedger(host: Awaited<ReturnType<typeof goalHost>>) {
  return (await ledger(host, "candidate")).filter((event) => event.type === "kickoff-triage")
}

test("a live run of the same work is refused as continue, naming its slug, runId and lock", async () => {
  const host = await goalHost(worker(), { ".opencode/goals/existing/goal.yaml": goal("existing") })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start existing" } as never)
    const existing = await waitStatus(host, ["waiting"], 30000, "existing")
    await writeCandidate(host)

    const text = await refusal(host, "continue")
    expect(text).toContain('"existing"')
    expect(text).toContain(existing.runId)
    expect(text).toContain(existing.lock)
    expect(text).toContain("No new run was created")
    expect((await triageLedger(host))[0]).toMatchObject({ decision: "continue", surface: "prepare_launch", targets: [{ slug: "existing", runId: existing.runId, lock: existing.lock, status: "waiting" }] })
    await noCandidateLaunch(host)
  } finally { await host.stop() }
}, 60000)

test("a paused run of the same work is refused as repair, naming the stopped goal/run/lock", async () => {
  const host = await goalHost(worker(), { ".opencode/goals/existing/goal.yaml": goal("existing") })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start existing" } as never)
    await waitStatus(host, ["waiting"], 30000, "existing")
    await host.client.session.command({ sessionID: owner, name: "goal", text: "pause" } as never)
    const existing = await waitStatus(host, ["paused"], 20000, "existing")
    await writeCandidate(host)

    const text = await refusal(host, "repair")
    expect(text).toContain('"existing"')
    expect(text).toContain(existing.runId)
    expect(text).toContain(existing.lock)
    expect(text).toContain("paused")
    expect((await triageLedger(host))[0]).toMatchObject({ decision: "repair", targets: [{ slug: "existing", runId: existing.runId, lock: existing.lock, status: "paused" }] })
    await noCandidateLaunch(host)
  } finally { await host.stop() }
}, 90000)

test("a blocked run of the same work is refused as repair, naming the stopped goal/run/lock", async () => {
  const host = await goalHost(worker("block"), { ".opencode/goals/existing/goal.yaml": goal("existing") })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start existing" } as never)
    const existing = await waitStatus(host, ["blocked"], 90000, "existing")
    await writeCandidate(host)

    const text = await refusal(host, "repair")
    expect(text).toContain('"existing"')
    expect(text).toContain(existing.runId)
    expect(text).toContain(existing.lock)
    expect(text).toContain("blocked")
    expect((await triageLedger(host))[0]).toMatchObject({ decision: "repair", targets: [{ slug: "existing", runId: existing.runId, lock: existing.lock, status: "blocked" }] })
    await noCandidateLaunch(host)
  } finally { await host.stop() }
}, 150000)

test("an existing draft of the same work is refused as continue, naming the draft and its lock (no invented run)", async () => {
  const host = await goalHost(worker(), {
    ".opencode/goals/existing/goal.yaml": goal("existing"),
    ".opencode/goals/candidate/goal.yaml": candidateYaml,
  })
  try {
    const text = await refusal(host, "continue")
    expect(text).toContain('"existing"')
    expect(text).toContain("no run yet")
    expect(text).toContain(lockOf(goal("existing")))
    expect(text).toContain("draft")
    const event = (await triageLedger(host))[0]!
    expect(event).toMatchObject({ decision: "continue", targets: [{ slug: "existing", status: "draft", lock: lockOf(goal("existing")) }] })
    expect(JSON.stringify(event.targets)).not.toContain("runId")
    await noCandidateLaunch(host)
  } finally { await host.stop() }
}, 60000)

test("two existing goals covering the same work are refused as consolidate with both targets named", async () => {
  const host = await goalHost(worker(), { ".opencode/goals/existing/goal.yaml": goal("existing") })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start existing" } as never)
    await waitStatus(host, ["waiting"], 30000, "existing")
    // A second goal for the same work appears after the first is live.
    await Bun.write(join(host.project, ".opencode/goals/second/goal.yaml"), goal("second"))
    await writeCandidate(host)

    const text = await refusal(host, "consolidate")
    expect(text).toContain('"existing"')
    expect(text).toContain('"second"')
    expect(text).toContain("Consolidate them")
    expect((await triageLedger(host))[0]).toMatchObject({ decision: "consolidate", targets: [{ slug: "existing", status: "waiting" }, { slug: "second", status: "draft" }] })
    await noCandidateLaunch(host)
  } finally { await host.stop() }
}, 60000)
