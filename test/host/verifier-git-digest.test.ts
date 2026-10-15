import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { PLUGIN, goalHost, ledger, newSession, script, waitStatus } from "./goal.helpers"
import type { ChatRequest, Reply } from "./harness"

// T109: the verifier has only read/glob/grep, so "check the git history" was
// unanswerable and burned the round budget — the real cause of the C4/C5
// timeouts. The host now supplies a bounded git digest in the prompt AND saves
// a quotable copy inside the project, so the verifier needs no shell and no
// external path.

const GOAL = `schema: goal/v1
id: demo
title: History shows the marker
intent:
  verbatim: "record the marker in history"
outcome: the repository history records the marker commit
non_goals:
  - anything else
criteria:
  - id: C1
    statement: done.txt SHALL exist
    check: {kind: file, path: done.txt}
  - id: C2
    statement: The git history SHALL include the marker commit
    check: {kind: verifier, ask: "Does the repository history include a commit whose subject mentions the marker?"}
plan:
  - {id: S1, title: Write done.txt, proves: [C1, C2]}
`
const MARKER = "MARKER-ALPHA add the tracked feature"
const evidence = { C1: "wrote done.txt", C2: "the digest shows the marker commit" }

const worker = (_request: ChatRequest, turn: { trigger: string; results: number }) => {
  if (turn.trigger.includes("goal started") || turn.trigger.includes("host verdict")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: "status: ok\n" } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { note: "wrote done.txt", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
  }
  return { text: "Nothing else to do." }
}

// The verifier answers the git-history criterion by quoting the host-saved
// digest, exactly as a real child would read it (no shell, no external path).
const verifier = (req: ChatRequest): Reply => {
  const json = JSON.stringify(req.messages)
  const match = /\.opencode\/goals\/demo\/evidence\/[^"\\\s]*git-history-[^"\\\s]+\.json/.exec(json)
  return {
    toolCalls: [{
      name: "goal_verdict",
      args: { verdicts: [{ id: "C2", verdict: "proven", reason: "the digest lists the marker commit", evidence: [{ path: match ? match[0] : ".opencode/goals/demo/evidence/missing.json", quote: MARKER }] }] },
    }],
  }
}

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" }, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
}

test("a commit-history criterion is judged from the host git digest, no shell or external path", async () => {
  const host = await goalHost(script(worker as never, verifier), { ".opencode/goals/demo/goal.yaml": GOAL }, { plugin: PLUGIN })
  try {
    // A distinctive commit the verifier must find in the host-provided digest.
    writeFileSync(join(host.project, "marker.txt"), "tracked\n")
    git(host.project, "add", "-A")
    git(host.project, "commit", "-q", "-m", MARKER)

    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as never)
    const done = await waitStatus(host, ["complete", "paused", "needs_review", "blocked"], 90000)
    expect(done.status).toBe("complete")
    expect(done.criteria.C2).toMatchObject({ status: "pass", by: "verifier" })

    const verifierRequests = host.fixture.requests.filter((r) => JSON.stringify(r.messages).includes("independent completion verifier"))
    expect(verifierRequests.length).toBeGreaterThan(0)
    const prompt = JSON.stringify(verifierRequests[0]!.messages)
    expect(prompt).toContain("Repository history digest")
    expect(prompt).toContain(MARKER)
    expect(prompt).toContain("git-history-")
    // the verifier never needed a shell
    expect((verifierRequests[0]!.tools ?? []).some((t) => /shell|bash/.test(t.function.name))).toBe(false)
    // the fallback path was not needed — the digest made the criterion answerable directly
    expect((await ledger(host)).some((e) => e.type === "verifier-transcript" && e.cause)).toBe(false)
  } finally { await host.stop() }
}, 120000)
