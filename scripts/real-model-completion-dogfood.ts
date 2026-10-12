// Explicit automated QA owner asks a real model to finish its inspected
// waiting goal; only the installed engine can prove and complete it.
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { readFile, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { GoalRpc } from "../src/rpc"

if (!process.argv.includes("--assert") || !process.env.QA_RESUME_ROOT) throw Error("Use --assert with QA_RESUME_ROOT")
const root = realpathSync(process.env.QA_RESUME_ROOT), location = { directory: root }
const evidence = join(root, "qa-evidence")
const source = JSON.parse(await readFile(join(evidence, "context.json"), "utf8"))
const manager = JSON.parse(await readFile(join(evidence, "manager-pty/result.json"), "utf8"))
if (!manager.pass) throw Error("Manager inspection did not pass")
const endpoint = await Service.discover()
if (!endpoint || endpoint.url !== source.endpoint) throw Error("QA endpoint changed; no default-host substitute")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: { ...Service.headers(endpoint), "x-opencode-directory": root } })
const info: any = await client.server.info()
if (info.pid !== source.serverPID) throw Error("QA serving PID changed")
const current = async () => JSON.parse(await readFile(join(root, `.opencode/goals/${manager.second.slug}/run.json`), "utf8"))
const before = await current()
if (before.status !== "waiting" || before.runId !== manager.second.runId) throw Error("Expected the exact other waiting inspection goal")
const rpc: any = (client as any).rpc(GoalRpc)
const provenance = await rpc.provenance({ sessionID: before.sessionID }, { location })
if (provenance.source.version !== source.revision || provenance.serverPID !== source.serverPID || provenance.location !== root) throw Error("Wrong installed QA artifact")
await writeFile(join(evidence, "completion-provenance.json"), JSON.stringify(provenance, null, 2))
const prompt = "The automated QA owner's manager inspection is finished. Your existing marker is ready. Complete this SAME waiting inspection goal now: read its marker, call goal_claim with evidence for every criterion, then END YOUR TURN so the installed host runs its declared checks. Do not wait again, request manual verification, fabricate passes, create a replacement goal, edit the locked contract, or change global settings. This instruction ends the inspection, not an approval of any criterion."
await client.session.prompt({ sessionID: before.sessionID, text: prompt } as any)
const deadline = Date.now() + 120000
let after: any
while (Date.now() < deadline) {
  after = await current()
  if (after.status === "complete") break
  await Bun.sleep(200)
}
const transcript: any[] = await client.session.context({ sessionID: before.sessionID } as any)
const ledger = (await readFile(join(root, `.opencode/goals/${before.slug}/ledger.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
const owner = transcript.find((m) => m.type === "user" && m.text === prompt)
const claim = ledger.find((e) => e.type === "claim" && e.t >= owner?.time?.created)
const verification = ledger.find((e) => e.type === "verify-start" && e.source === "claim" && e.t >= claim?.t)
const verdict = ledger.find((e) => e.type === "verdict" && e.passed === true && e.t >= verification?.t)
const pass = after?.status === "complete" && after.runId === before.runId && after.lock === before.lock && !!owner && !!verdict
  && Object.values(after.criteria).every((c: any) => c.status === "pass" && c.by === "host")
await writeFile(join(evidence, "completion-transcript.json"), JSON.stringify(transcript, null, 2))
await writeFile(join(evidence, "completion-ledger.json"), JSON.stringify(ledger, null, 2))
await writeFile(join(evidence, "completion-result.json"), JSON.stringify({ pass, before, after, ownerMessageID: owner?.id, claim, verification, verdict, automatedQATestOwner: true, providerIsFixture: false }, null, 2))
if (!pass) throw Error(`Actual installed automatic completion did not pass; retained ${evidence}/completion-result.json`)
console.log(JSON.stringify({ pass, evidence, sessionID: before.sessionID, runId: before.runId, revision: source.revision, serverPID: info.pid, providerIsFixture: false }))
