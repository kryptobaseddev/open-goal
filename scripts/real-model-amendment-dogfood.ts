// Automated QA owner, isolated project, actual deployed tools and model.
// Chat acceptance is not production consent or a criterion waiver.
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { GoalRpc } from "../src/rpc"
import { parseContract } from "../src/contract/parse"
import { artifactDiscrepancies, hashArtifact, isArtifactPath } from "../src/verify/artifact"

if (!process.argv.includes("--assert") || !process.env.OCGOAL_GIT_SPEC || !process.env.OPENCODE_SESSION_ID) throw Error("Use --assert with OCGOAL_GIT_SPEC and OPENCODE_SESSION_ID")
const endpoint = await Service.discover()
if (!endpoint) throw Error("No existing QA service; no service/provider changes allowed")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
const original: any = await client.session.get({ sessionID: process.env.OPENCODE_SESSION_ID } as any)
if (!original.agent || !original.model) throw Error("Original model/agent missing; no fallback")
const info: any = await client.server.info()
const root = realpathSync(await mkdtemp(join(tmpdir(), "opencode", "real-model-amendment-")))
const evidence = join(root, "qa-evidence"), location = { directory: root }
await mkdir(join(root, ".opencode/goals/qa-chat-amend"), { recursive: true })
await mkdir(evidence, { recursive: true })
await writeFile(join(root, ".opencode/opencode.json"), JSON.stringify({ plugins: ["-opencode-goal", process.env.OCGOAL_GIT_SPEC] }))
const yaml = `schema: goal/v1
id: qa-chat-amend
title: Deployed Composer acceptance QA
intent: {verbatim: verify chat accepts an exact staged review}
outcome: qa-marker.txt exists under the reviewed semantics
non_goals: [production changes, global settings, other files]
criteria:
  - id: C1
    statement: qa-marker.txt exists
    check: {kind: file, path: qa-marker.txt}
  - id: C2
    statement: qa-marker.txt contains status ok
    check: {kind: contains, path: qa-marker.txt, text: 'status: ok'}
constraints: [Write the marker then call goal_wait for 300 seconds; do not claim until the QA owner finishes inspection]
`
await writeFile(join(root, ".opencode/goals/qa-chat-amend/goal.yaml"), yaml)
const session: any = await client.session.create({ location, title: "Deployed real-model Composer amendment QA", agent: original.agent, model: original.model } as any)
const sessionID = session.id, rpc: any = (client as any).rpc(GoalRpc)
function git(...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
  if (r.exitCode) throw Error(`git ${args[0]} failed`)
  return r.stdout.toString().trim()
}
const ref = `v${JSON.parse(await readFile(join(import.meta.dir, "../package.json"), "utf8")).version}`
const revision = git("rev-parse", `${ref}^{commit}`)
const artifacts = Object.fromEntries(git("ls-tree", "-r", "--name-only", revision).split("\n").filter(isArtifactPath).map((path) => [path, hashArtifact(Bun.spawnSync(["git", "show", `${revision}:${path}`], { cwd: join(import.meta.dir, ".."), stdout: "pipe" }).stdout)]))
const provenance = await rpc.provenance({ sessionID }, { location })
const discrepancies = artifactDiscrepancies(provenance, { revision, artifacts, serverPID: info.pid, location: root, minVersion: "0.3.10" })
if (discrepancies.length) throw Error(discrepancies.join("\n"))
await writeFile(join(evidence, "provenance.json"), JSON.stringify(provenance, null, 2))
await writeFile(join(evidence, "context.json"), JSON.stringify({ root, location, sessionID, endpoint: endpoint.url, serverPID: info.pid, revision, model: original.model, agent: original.agent, automatedQATestOwner: true, providerIsFixture: false }, null, 2))
const current = async () => JSON.parse(await readFile(join(root, ".opencode/goals/qa-chat-amend/run.json"), "utf8"))
async function until<T>(read: () => Promise<T | undefined>, duration = 120000): Promise<T> {
  const deadline = Date.now() + duration
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await Bun.sleep(250) }
  throw Error("Timed out; raw evidence retained")
}
let proposal: any, before: any, after: any
const acceptance = "I accept the amendment get it done"
try {
  await client.session.command({ sessionID, name: "goal", text: "start qa-chat-amend" } as any)
  before = await until(async () => { const state = await current().catch(() => undefined); return state?.status === "waiting" ? state : undefined })
  const stagedPrompt = "Change this same goal's outcome to say qa-marker.txt exists under the revised QA semantics. Keep every criterion, constraint, non-goal and marker unchanged. Use goal_propose_amendment with the actual current lock and replacement YAML; show me the exact diff in the Composer, then stop. Do not edit the live contract, resume, claim, invent a sidebar Accept or ask me to type a command. This is an isolated automated QA owner, not production."
  await client.session.prompt({ sessionID, text: stagedPrompt } as any)
  proposal = await until(async () => {
    const data = JSON.parse(await readFile(join(root, ".opencode/goals/.owner-amendments.json"), "utf8").catch(() => '{"requests":{}}'))
    return Object.values(data.requests).find((r: any) => r.sessionID === sessionID && r.status === "pending")
  })
  const next = parseContract(proposal.nextText)
  if (proposal.runId !== before.runId || proposal.lock !== before.lock || !next.contract || next.contract.outcome !== "qa-marker.txt exists under the revised QA semantics" || proposal.diff.changed.length || proposal.diff.added.length || proposal.diff.removed.length)
    throw Error("Proposed diff exceeds the QA owner's exact semantic change")
  await writeFile(join(evidence, "reviewed-proposal.json"), JSON.stringify(proposal, null, 2))
  await writeFile(join(evidence, "before-accept-transcript.json"), JSON.stringify(await client.session.context({ sessionID } as any), null, 2))
  await writeFile(join(evidence, "before-accept-forms.json"), JSON.stringify(await (client.session.form as any).list({ sessionID }), null, 2))
  // No native form reply or raw owner-action API substitutes for this chat.
  await client.session.prompt({ sessionID, text: acceptance } as any)
  after = await until(async () => { const state = await current(); return state.lock === proposal.nextLock && state.status === "waiting" ? state : undefined })
  const transcript: any[] = await client.session.context({ sessionID } as any)
  const events = (await readFile(join(root, ".opencode/goals/qa-chat-amend/ledger.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
  const owner = transcript.find((m) => m.type === "user" && m.text === acceptance)
  const resolved = events.filter((e) => e.type === "amendment-chat-resolved" && e.ownerMessageID === owner?.id && e.decisionId === proposal.id)
  const continued = events.filter((e) => e.type === "amendment-chat-continuation" && e.ownerMessageID === owner?.id && e.lock === proposal.nextLock && e.ok)
  const pass = after.runId === before.runId && after.sessionID === before.sessionID && resolved.length === 1 && continued.length === 1
  await writeFile(join(evidence, "transcript.json"), JSON.stringify(transcript, null, 2))
  await writeFile(join(evidence, "ledger.json"), JSON.stringify(events, null, 2))
  await writeFile(join(evidence, "result.json"), JSON.stringify({ pass, before, after, ownerMessageID: owner?.id, resolved, continued, automatedQATestOwner: true, providerIsFixture: false }, null, 2))
  if (!pass) throw Error("Deployed chat consent did not execute exactly once")
  console.log(JSON.stringify({ pass, root, evidence, sessionID, revision, serverPID: info.pid, providerIsFixture: false }))
} catch (error) {
  await writeFile(join(evidence, "failure.json"), JSON.stringify({ pass: false, error: String(error), before, after, proposal }, null, 2))
  await writeFile(join(evidence, "transcript.json"), JSON.stringify(await client.session.context({ sessionID } as any), null, 2))
  console.error(`Real-model chat amendment failed; retained ${evidence}: ${String(error)}`)
  process.exitCode = 1
}
