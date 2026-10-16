import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { until, type ChatRequest } from "./harness"

// T100: a contract may bind an exact-run execution `workspace` (a root-relative
// linked worktree). When set, host checks, the protect/diff base and the
// fingerprint resolve against that worktree instead of the shared project root —
// so a protected oracle changed INSIDE the worktree is finally guarded, and the
// base commit is the workspace's HEAD. An invalid workspace (not a work-tree
// root) refuses the start, and omitting it keeps today's root behaviour.

const WORKSPACE = ".worktrees/wt"

const GOAL = `schema: goal/v1
id: demo
title: Workspace-bound demo
intent: {verbatim: bound run}
outcome: the workspace marker exists and the protected oracle is untouched
non_goals: [anything else]
workspace: ${WORKSPACE}
criteria:
  - id: C1
    statement: the workspace marker exists
    check: {kind: file, path: marker.txt}
protect:
  - oracle.txt
plan:
  - {id: S1, title: Inspect the bound workspace, proves: [C1]}
`

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, stdout: "pipe", stderr: "pipe" })
  if (r.exitCode) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

/** Create the linked worktree the contract binds, with a marker and an oracle. */
function bindWorktree(project: string) {
  const wt = join(project, WORKSPACE)
  git(project, "worktree", "add", "-q", "-b", "wt", wt)
  writeFileSync(join(wt, "marker.txt"), "ok\n")
  writeFileSync(join(wt, "oracle.txt"), "do not edit\n")
  git(wt, "add", "-A")
  git(wt, "commit", "-q", "-m", "worktree init")
  return { wt, head: git(wt, "rev-parse", "HEAD") }
}

test("a contract workspace binds checks and the base commit to the exact-run worktree", async () => {
  const host = await goalHost(script((_req, turn) => {
    if (turn.results === 0) return { toolCalls: [{ name: "goal_claim", args: { summary: "the marker exists in the bound workspace", evidence: { C1: "marker.txt is in the workspace" } } }] }
    return { text: "End the turn; the host verifies in the bound workspace." }
  }, () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C1", verdict: "proven", reason: "the marker exists in the workspace", evidence: [{ path: "marker.txt", quote: "ok" }] }] } }] })), { ".opencode/goals/demo/goal.yaml": GOAL })
  try {
    const { head } = bindWorktree(host.project)
    const rootHead = git(host.project, "rev-parse", "HEAD")
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const done = await waitStatus(host, ["complete", "needs_review", "paused"], 30000)
    expect(done.status).toBe("complete")
    expect(done.criteria.C1.status).toBe("pass")
    // the run's base commit is the WORKSPACE head, not the shared root head
    expect(done.base.commit).toBe(head)
    expect(done.base.commit).not.toBe(rootHead)
  } finally { await host.stop() }
}, 90000)

test("the protect guard now covers an oracle changed inside the workspace worktree", async () => {
  const host = await goalHost(script((_req, turn) => {
    if (turn.results === 0) return { toolCalls: [{ name: "shell", args: { command: `cd ${WORKSPACE} && echo hacked >> oracle.txt` } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_claim", args: { summary: "touch the protected oracle", evidence: { C1: "marker" } } }] }
    return { text: "End the turn." }
  }, () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C1", verdict: "proven", reason: "x", evidence: [{ path: "marker.txt", quote: "ok" }] }] } }] })), { ".opencode/goals/demo/goal.yaml": GOAL })
  try {
    bindWorktree(host.project)
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    await until(async () => (await ledger(host)).some((e) => e.type === "verdict"), 30000)
    const verdict = (await ledger(host)).find((e) => e.type === "verdict")!
    const line = (verdict.lines as string[]).join("\n")
    expect(line).toMatch(/protected paths were modified/)
    expect(line).toContain("oracle.txt")
    expect((await run(host)).status).not.toBe("complete")
  } finally { await host.stop() }
}, 90000)

test("a workspace that is not a git work-tree root refuses the start, and the default keeps the project root", async () => {
  const invalid = GOAL.replace(`workspace: ${WORKSPACE}`, "workspace: plain-dir")
  const host = await goalHost(script((_req: ChatRequest) => ({ text: "hold" })), { ".opencode/goals/demo/goal.yaml": invalid, "plain-dir/.keep": "" })
  try {
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    await Bun.sleep(1500)
    // the refusal creates no run
    expect(await run(host).catch(() => undefined)).toBeUndefined()
  } finally { await host.stop() }
}, 60000)

test("a contract without a workspace keeps the project root binding", async () => {
  const rootBound = GOAL.replace(`workspace: ${WORKSPACE}\n`, "")
  const host = await goalHost(script((_req, turn) => {
    if (turn.results === 0) return { toolCalls: [{ name: "goal_claim", args: { summary: "marker at the project root", evidence: { C1: "marker.txt is at the root" } } }] }
    return { text: "End the turn." }
  }, () => ({ toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C1", verdict: "proven", reason: "the root marker exists", evidence: [{ path: "marker.txt", quote: "ok" }] }] } }] })), { ".opencode/goals/demo/goal.yaml": rootBound, "marker.txt": "ok\n" })
  try {
    const head = git(host.project, "rev-parse", "HEAD")
    const sid = await newSession(host)
    await host.client.session.command({ sessionID: sid, name: "goal", text: "start demo" } as any)
    const done = await waitStatus(host, ["complete", "needs_review", "paused"], 30000)
    expect(done.status).toBe("complete")
    expect(done.base.commit).toBe(head)
  } finally { await host.stop() }
}, 90000)
