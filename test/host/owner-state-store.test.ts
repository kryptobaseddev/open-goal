import { test, expect } from "bun:test"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseContract } from "../../src/contract/parse"
import { GoalRpc } from "../../src/rpc"
import { goalHost, newSession, script } from "./goal.helpers"
import { until } from "./harness"

// T185 — the plugin's owner-state sidecars (`.owner-decisions.json`,
// `.owner-launches.json`, `.owner-amendments.json`, `.launch-approvals.json`)
// resolve through the store resolver, not the hardcoded legacy path.
//
// A project with NO `.opencode/goals` must write all four under `.cleo/goals`;
// a project that still has the legacy store keeps its records there (a pending
// form is never split from the run it authorizes); a pre-flip file is still
// read; and the write guard refuses the sidecars in BOTH roots.

const DEMO = `schema: goal/v1
id: demo
title: Demo picker goal
intent: {verbatim: pick a demo goal without naming it}
outcome: demo.txt exists
non_goals: [other files]
criteria:
  - {id: C1, statement: demo.txt exists, check: {kind: file, path: demo.txt}}
plan:
  - {id: S1, title: write demo.txt, proves: [C1]}
`

const AMEND = `schema: goal/v1
id: amend
title: Amend store goal
intent: {verbatim: stage one reviewed amendment for the store}
outcome: amend.txt exists
non_goals: [changing the amendment oracle]
criteria:
  - {id: C1, statement: amend.txt exists, check: {kind: file, path: amend.txt}}
plan:
  - {id: S1, title: write amend.txt, proves: [C1]}
`
const AMENDED = AMEND.replace("title: Amend store goal", "title: Amend store goal, reviewed")

const LAUNCH = `schema: goal/v1
id: launchme
title: Launch review goal
intent: {verbatim: prepare a launch review for a separate draft}
outcome: launch.txt exists
non_goals: [starting this goal in the test]
criteria:
  - {id: C1, statement: launch.txt exists, check: {kind: file, path: launch.txt}}
plan:
  - {id: S1, title: write launch.txt, proves: [C1]}
`

const worker = script((_req, turn) => {
  if (turn.trigger.startsWith("REQUEST_LAUNCH") && turn.results === 0)
    return { toolCalls: [{ name: "goal_prepare_launch", args: { slug: "launchme" } }] }
  if (turn.trigger.startsWith("GUARD ") && turn.results === 0) {
    const path = turn.trigger.split(" path ")[1]!
    if (turn.trigger.startsWith("GUARD shell "))
      return { toolCalls: [{ name: "shell", args: { command: `echo x > ${path}` } }] }
    return { toolCalls: [{ name: "write", args: { path, content: "{}" } }] }
  }
  if (turn.trigger.includes("Amend store goal") && turn.results === 0)
    return { toolCalls: [{ name: "goal_propose_amendment", args: { slug: "amend", expectedLock: parseContract(AMEND).lock, yaml: AMENDED, rationale: "clarify the title, keep every criterion" } }] }
  return { text: "ok" }
})

/** The tool result produced after the newest turn that carried `prompt`. */
async function guardAttempt(host: Awaited<ReturnType<typeof goalHost>>, sessionID: string, prompt: string) {
  await host.client.session.prompt({ sessionID, text: prompt } as any)
  return until(() => {
    const request = (host.fixture.requests as Array<{ messages?: Array<{ role?: string; content?: unknown }> }>)
      .filter((r) => JSON.stringify(r.messages ?? []).includes(prompt)).at(-1)
    const messages = request?.messages ?? []
    const at = messages.findLastIndex((m) => m.role === "user" && JSON.stringify(m.content ?? "").includes(prompt))
    const result = messages.slice(at + 1).filter((m) => m.role === "tool")
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).at(-1)
    return result
  }, 20000)
}

test("a project with no legacy store writes every owner-state file under the resolved store", async () => {
  // One draft at first: the legacy launch-form binding only seals a candidate
  // when the project has exactly one (the shipped skill's old question).
  const host = await goalHost(worker, { ".cleo/goals/demo/goal.yaml": DEMO }, { seedLegacy: false })
  try {
    // 1. launch approvals — the owner answers a launch-shaped native form.
    // One rpc round-trip first: the plugin loads after `serve` answers, and a
    // form created before its event hook exists is not seen.
    const approvals = await newSession(host)
    await (host.client as any).rpc(GoalRpc).snapshot({ sessionID: approvals })
    const form = await (host.client.session.form as any).create({
      sessionID: approvals, title: "Launch this goal?",
      fields: [{ key: "q0", type: "string", custom: true, options: [{ value: "Start goal now", label: "Start goal now" }] }],
    })
    await Bun.sleep(300)
    await (host.client.session.form as any).reply({ sessionID: approvals, formID: form.id, answer: { q0: "Start goal now" } })
    await until(() => existsSync(join(host.project, ".cleo/goals/.launch-approvals.json")), 15000)

    // keep more work out of the approvals path; the remaining drafts arrive now
    for (const [slug, yaml] of [["amend", AMEND], ["launchme", LAUNCH]] as const) {
      mkdirSync(join(host.project, ".cleo/goals", slug), { recursive: true })
      await Bun.write(join(host.project, ".cleo/goals", slug, "goal.yaml"), yaml)
    }

    // 2. decisions — /goal start with no slug opens the start picker decision
    const picker = await newSession(host)
    await host.client.session.command({ sessionID: picker, name: "goal", text: "start" } as any)
    await until(() => existsSync(join(host.project, ".cleo/goals/.owner-decisions.json")), 15000)

    // 3. launches — a validated draft reaches native launch review
    const launch = await newSession(host)
    await host.client.session.prompt({ sessionID: launch, text: "REQUEST_LAUNCH the validated draft" } as any)
    await until(() => existsSync(join(host.project, ".cleo/goals/.owner-launches.json")), 20000)

    // 4. amendments — a live goal stages one reviewed diff
    const amender = await newSession(host)
    await host.client.session.command({ sessionID: amender, name: "goal", text: "start amend" } as any)
    await until(() => existsSync(join(host.project, ".cleo/goals/.owner-amendments.json")), 30000)

    for (const name of [".owner-decisions.json", ".owner-launches.json", ".owner-amendments.json"])
      expect(JSON.parse(readFileSync(join(host.project, ".cleo/goals", name), "utf8")).version, name).toBe(1)
    expect(Object.keys(JSON.parse(readFileSync(join(host.project, ".cleo/goals/.launch-approvals.json"), "utf8"))).length).toBeGreaterThan(0)
    // nothing was written into the store this project does not have
    expect(existsSync(join(host.project, ".opencode/goals"))).toBe(false)

    // 5. the write guard covers BOTH roots for these sidecars
    const guard = await newSession(host)
    for (const [label, goal] of [["write", ".cleo/goals/.owner-decisions.json"], ["shell", ".cleo/goals/.owner-decisions.json"], ["write", ".opencode/goals/.launch-approvals.json"]]) {
      const result = await guardAttempt(host, guard, `GUARD ${label} path ${goal}`)
      expect(result, `${label} ${goal} must be refused`).toMatch(/owned by the owner and the host/i)
    }
  } finally {
    await host.stop()
  }
}, 180000)

test("a project with the legacy store keeps its records there and still reads a pre-flip file", async () => {
  const preflip = {
    version: 1,
    requests: {
      "pre-flip-launch": {
        id: "pre-flip-launch", sessionID: "ses_preflip", slug: "demo", lock: "lock-preflip",
        title: "Demo file says ok", question: "Launch the pre-flip draft?", createdAt: 1, expiresAt: 9_999_999_999_999,
        expiryPolicy: "target", issuerPID: 1, status: "pending", fresh: false,
      },
    },
  }
  const host = await goalHost(worker, { ".opencode/goals/.owner-launches.json": JSON.stringify(preflip) })
  try {
    // the pre-flip record is read through the resolved (legacy) sidecar
    const rpc: any = (host.client as any).rpc(GoalRpc)
    const snapshot = await rpc.snapshot({ sessionID: "ses_preflip" })
    expect(snapshot.launches.map((l: any) => l.decisionId)).toContain("pre-flip-launch")

    // and a new approval lands beside it, not in the canonical store
    const sessionID = await newSession(host)
    const form = await (host.client.session.form as any).create({
      sessionID, title: "Launch this goal?",
      fields: [{ key: "q0", type: "string", custom: true, options: [{ value: "Start goal now", label: "Start goal now" }] }],
    })
    await (host.client.session.form as any).reply({ sessionID, formID: form.id, answer: { q0: "Start goal now" } })
    await until(() => existsSync(join(host.project, ".opencode/goals/.launch-approvals.json")), 15000)
    expect(existsSync(join(host.project, ".cleo/goals/.launch-approvals.json"))).toBe(false)
    // the pre-flip bytes were read, never rewritten
    expect(JSON.parse(readFileSync(join(host.project, ".opencode/goals/.owner-launches.json"), "utf8")).requests["pre-flip-launch"].status).toBe("pending")
  } finally {
    await host.stop()
  }
}, 120000)
