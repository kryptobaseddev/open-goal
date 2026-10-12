// Real-model typed lifecycle dogfood. Automated QA owner commands are scoped
// to an isolated inspection run, never the production completion run.
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { readFile, writeFile } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { GoalRpc } from "../src/rpc"

if (!process.argv.includes("--assert") || !process.env.QA_RESUME_ROOT) throw Error("Use --assert and QA_RESUME_ROOT")
const root = realpathSync(process.env.QA_RESUME_ROOT), evidence = join(root, "qa-evidence")
const source = JSON.parse(await readFile(join(evidence, "context.json"), "utf8"))
const manager = JSON.parse(await readFile(join(evidence, "manager-pty/result.json"), "utf8"))
if (!manager.pass) throw Error("No passing deployed two-goal manager evidence")
const endpoint = await Service.discover()
if (!endpoint || endpoint.url !== source.endpoint) throw Error("QA endpoint changed")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: { ...Service.headers(endpoint), "x-opencode-directory": root } })
const info: any = await client.server.info()
if (info.pid !== source.serverPID) throw Error("QA server changed")
const rpc: any = (client as any).rpc(GoalRpc)
const runPath = join(root, `.opencode/goals/${manager.first.slug}/run.json`)
const current = async () => JSON.parse(await readFile(runPath, "utf8"))
const before = await current()
if (before.status !== "paused" || before.runId !== manager.first.runId) throw Error("Expected exact selected paused inspection run")
const actual = await rpc.provenance({ sessionID: before.sessionID }, { location: { directory: root } })
if (actual.source.version !== source.revision || actual.serverPID !== source.serverPID || actual.location !== root) throw Error("Wrong deployed artifact")
await writeFile(join(evidence, "lifecycle-provenance.json"), JSON.stringify(actual, null, 2))
const prompt = "I approve you to resume. Resume this same inspection run now through goal_inventory and goal_manage; do not create a replacement or ask a redundant resume question. Then immediately call goal_wait for 300 seconds and do not claim. This is the automated QA owner exercising the current exact lifecycle on its isolated inspection goal."
await client.session.prompt({ sessionID: before.sessionID, text: prompt } as any)
const end = Date.now() + 120000
let after: any
while (Date.now() < end) {
  after = await current()
  if (after.status === "waiting") break
  await Bun.sleep(200)
}
const transcript: any[] = await client.session.context({ sessionID: before.sessionID } as any)
const ledger = (await readFile(join(root, `.opencode/goals/${before.slug}/ledger.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line))
const owner = [...transcript].reverse().find((m) => m.type === "user" && m.text === prompt)
const consumption = ledger.find((e) => e.type === "owner-message-consumed" && e.ownerMessageID === owner?.id && e.targetRunId === before.runId && e.lock === before.lock && e.action === "resume")
const resolution = ledger.find((e) => e.type === "decision-resolved" && e.decision === consumption?.decisionId && e.via === "owner-message" && e.ok === true)
const forms: any[] = await (client.session.form as any).list({ sessionID: before.sessionID })
const pass = after?.status === "waiting" && after.runId === before.runId && after.lock === before.lock && !!owner && !!resolution && forms.length === 0
await writeFile(join(evidence, "lifecycle-transcript.json"), JSON.stringify(transcript, null, 2))
await writeFile(join(evidence, "lifecycle-ledger.json"), JSON.stringify(ledger, null, 2))
await writeFile(join(evidence, "lifecycle-result.json"), JSON.stringify({ pass, before, after, ownerMessageID: owner?.id, consumption, resolution, forms, automatedQATestOwner: true, providerIsFixture: false }, null, 2))
if (!pass) throw Error(`Real-model conversational resume failed; retained ${evidence}/lifecycle-result.json`)
console.log(JSON.stringify({ pass, evidence, sessionID: before.sessionID, runId: before.runId, revision: source.revision, serverPID: info.pid, providerIsFixture: false }))
await rpc.manage({ sessionID: manager.primaryID, action: "pause", target: { key: `live:${before.slug}:${before.runId}`, lock: before.lock, runId: before.runId, sessionID: before.sessionID } }, { location: { directory: root } })
