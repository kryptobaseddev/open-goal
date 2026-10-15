import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { DEMO_GOAL, PLUGIN, goalHost, isVerifier, ledger, newSession, run, turnOf, waitStatus } from "./goal.helpers"
import { until, type ChatRequest, type Reply, type Script } from "./harness"

// Axiom C2 timed out three times with `messages: []`: the engine interrupted
// the child before reading its context, so a sibling-repo
// "permission denied: external_directory" loop was invisible. A timeout must
// keep the transcript and name the cause; a contract may grant the verifier
// extra READ-ONLY folders, and nothing else.

const DONE = "status: ok - verifier diagnostics\n"
const evidence = { C1: "wrote done.txt", C2: "grep finds status: ok", C3: "the file states it" }
const plugin = (options: Record<string, unknown>) => ({ package: process.env.OCGOAL_GIT_SPEC ?? PLUGIN, options }) as unknown as string

const worker = (_request: ChatRequest, turn: ReturnType<typeof turnOf>) => {
  if (turn.trigger.includes("goal started")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
    if (turn.results === 1) return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "claim" } }] }
    if (turn.results === 2) return { toolCalls: [{ name: "goal_claim", args: { summary: "done.txt written.", evidence } }] }
    return { text: "Claimed." }
  }
  if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "inspect verdict" } }] }
  return { text: "Holding." }
}

const verifierStep = (req: ChatRequest) => turnOf(req).results
// The shared script() helper answers every post-tool verifier request with
// prose, which would hide multi-step verifier behaviour. Route directly.
const script = (work: typeof worker, verifier: (req: ChatRequest) => Reply): Script => (req) =>
  !req.tools?.length ? { text: "Goal session" } : isVerifier(req) ? verifier(req) : work(req, turnOf(req))

test("a timed-out verifier round keeps its transcript and names the denied sibling path", async () => {
  const roots: { sibling?: string } = {}
  const host = await goalHost(script(worker, (req) => {
    if (verifierStep(req) === 0) return { toolCalls: [{ name: "read", args: { path: roots.sibling } }] }
    return { text: "still looking", delayMs: 30000 }
  }), {}, { plugin: plugin({ verifierTimeoutMs: 6000 }) })
  try {
    roots.sibling = join(host.root, "sibling", "notes.md")
    await Bun.write(roots.sibling, "SIBLING-EVIDENCE\n")
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    const verdict = await until(async () => (await ledger(host)).find((e) => e.type === "verdict"), 60000, 250)
    const line = (verdict.lines as string[]).join("\n")
    expect(line).toContain("verifier timed out")
    expect(line).toContain("external_directory")
    expect(line).toContain(join(host.root, "sibling"))
    const transcriptEvent = (await ledger(host)).find((e) => e.type === "verifier-transcript")!
    expect(transcriptEvent.cause).toContain("external_directory")
    const transcript = await Bun.file(String(transcriptEvent.file)).json()
    expect(transcript.done).toBe("timeout")
    expect(transcript.messages.length).toBeGreaterThan(0)
    expect(JSON.stringify(transcript.messages)).toContain("read")
    expect((await run(host)).criteria.C3.status).not.toBe("pass")
  } finally { await host.stop() }
}, 90000)

test("contract-listed verifier read paths are readable, unlisted paths stay denied, and nothing becomes writable", async () => {
  const roots: Record<string, string> = {}
  const goal = DEMO_GOAL + "verification: {mode: host+verifier, read: [../sibling]}\n"
  const host = await goalHost(script(worker, (req) => {
    const step = verifierStep(req)
    if (step === 0) return { toolCalls: [{ name: "read", args: { path: roots.sibling } }] }
    if (step === 1) return { toolCalls: [{ name: "read", args: { path: roots.other } }] }
    if (step === 2) return { toolCalls: [{ name: "write", args: { path: roots.hack, content: "x" } }] }
    return { toolCalls: [{ name: "goal_verdict", args: { verdicts: [{ id: "C3", verdict: "proven", reason: "states it", evidence: [{ path: "done.txt", quote: DONE.trim() }] }] } }] }
  }), { ".opencode/goals/demo/goal.yaml": goal }, { plugin: plugin({ verifierTimeoutMs: 20000 }) })
  try {
    roots.sibling = join(host.root, "sibling", "notes.md")
    roots.other = join(host.root, "other", "secret.md")
    roots.hack = join(host.root, "sibling", "hack.md")
    await Bun.write(roots.sibling, "SIBLING-EVIDENCE\n")
    await Bun.write(roots.other, "SECRET-OUTSIDE\n")
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    await waitStatus(host, ["complete", "running", "waiting", "needs_review", "paused"], 60000)
    await until(async () => (await ledger(host)).find((e) => e.type === "verdict"), 60000, 250)
    const verifierRequests = host.fixture.requests.filter((r) => JSON.stringify(r.messages).includes("independent completion verifier")).map((r) => JSON.stringify(r.messages))
    expect(verifierRequests.some((m) => m.includes("SIBLING-EVIDENCE"))).toBe(true)
    expect(verifierRequests.some((m) => m.includes("SECRET-OUTSIDE"))).toBe(false)
    expect(existsSync(roots.hack)).toBe(false)
    const done = await run(host)
    expect(done.criteria.C3).toMatchObject({ status: "pass" })
  } finally { await host.stop() }
}, 90000)
