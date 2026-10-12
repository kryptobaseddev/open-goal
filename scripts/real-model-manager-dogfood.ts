// Two real-model goals on the explicitly scoped installed QA host. The PTY
// observer is read-only; only real keyboard/mouse input operates the manager.
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { GoalRpc } from "../src/rpc"

if (!process.argv.includes("--assert") || !process.env.QA_RESUME_ROOT) throw Error("Use --assert with QA_RESUME_ROOT")
const root = realpathSync(process.env.QA_RESUME_ROOT), location = { directory: root }
const evidence = join(root, "qa-evidence"), prior = JSON.parse(await readFile(join(evidence, "context.json"), "utf8"))
const endpoint = await Service.discover()
if (!endpoint || endpoint.url !== prior.endpoint) throw Error("QA endpoint changed; no unscoped fallback")
const client = OpenCode.make({ baseUrl: endpoint.url, headers: { ...Service.headers(endpoint), "x-opencode-directory": root } })
const info: any = await client.server.info()
if (info.pid !== prior.serverPID) throw Error("QA serving PID changed")
const rpc: any = (client as any).rpc(GoalRpc)
const run = async (slug: string) => JSON.parse(await readFile(join(root, `.opencode/goals/${slug}/run.json`), "utf8"))
const until = async (predicate: () => Promise<any>, why: string) => {
  const end = Date.now() + 120000
  while (Date.now() < end) { const value = await predicate().catch(() => undefined); if (value) return value; await Bun.sleep(200) }
  throw Error(why)
}
const firstSlug = "qa-manager-one", secondSlug = "qa-manager-two"
const primary: any = await client.session.create({ location, title: "Deployed Real-Model Manager", agent: prior.originalAgent, model: prior.originalModel } as any)
const out = join(evidence, "manager-pty"), observer = join(out, "render-tree.json")
await mkdir(out, { recursive: true })
// This affects only the isolated QA location, not any global configuration.
const configPath = join(root, ".opencode/opencode.json")
const isolatedConfig = JSON.parse(await readFile(configPath, "utf8").catch(() => "{}"))
const probePath = join(import.meta.dir, "../test/fixtures/manager-pty-probe")
isolatedConfig.plugins = [...(isolatedConfig.plugins ?? []).filter((p: any) => (typeof p === "string" ? p : p.package) !== probePath), { package: probePath, options: { output: observer } }]
await writeFile(configPath, JSON.stringify(isolatedConfig, null, 2))
await client.location.reload({ location } as any)
// The interview goal correctly completed after the test owner's resume.
// Preserve it and create independent fixed-scope inspection goals instead
// of rewriting/restarting its completed history to make the gate pass.
for (const [slug, marker] of [[firstSlug, "manager-one.txt"], [secondSlug, "manager-two.txt"]]) {
  await mkdir(join(root, `.opencode/goals/${slug}`), { recursive: true })
  await writeFile(join(root, `.opencode/goals/${slug}/goal.yaml`), `schema: goal/v1\nid: ${slug}\ntitle: ${slug}\nintent: {verbatim: "Hold this isolated real-model manager inspection goal"}\noutcome: ${marker} contains status ok\nnon_goals: [production edits, global changes, identities]\nconstraints: ["Write ${marker} with status ok, then always call goal_wait for 300 seconds; do not claim during this inspection. The test owner operates the manager."]\ncriteria:\n  - id: C1\n    statement: ${marker} exists\n    check: {kind: file, path: ${marker}}\n  - id: C2\n    statement: ${marker} states status ok\n    check: {kind: contains, path: ${marker}, text: 'status: ok'}\nverification: {mode: host}\n`)
}
const firstSession: any = await client.session.create({ location, title: "First Real-Model Manager Goal", agent: prior.originalAgent, model: prior.originalModel } as any)
const secondSession: any = await client.session.create({ location, title: "Second Real-Model Goal", agent: prior.originalAgent, model: prior.originalModel } as any)
await client.session.command({ sessionID: firstSession.id, name: "goal", text: `start ${firstSlug}` } as any)
const first = await until(async () => { const r = await run(firstSlug); return r.status === "waiting" ? r : undefined }, "First real goal did not remain held for manager QA")
await client.session.command({ sessionID: secondSession.id, name: "goal", text: `start ${secondSlug}` } as any)
const second = await until(async () => { const r = await run(secondSlug); return r.status === "waiting" ? r : undefined }, "Second real model did not hold its independent goal")
const actual = await rpc.provenance({ sessionID: first.sessionID }, { location })
if (actual.source.version !== prior.revision || actual.serverPID !== prior.serverPID || actual.location !== root) throw Error("Manager uses a different deployed artifact/host/location")
await writeFile(join(out, "provenance.json"), JSON.stringify(actual, null, 2))
const control = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  if (new URL(request.url).pathname === "/state") return Response.json({ first: await run(firstSlug), second: await run(secondSlug) })
  return new Response("No owner operations exposed", { status: 404 })
} })
try {
  // Authentication lives only in the child environment, never this artifact.
  const packet = { url: endpoint.url, project: root, sessionID: primary.id, firstSessionID: first.sessionID, secondSessionID: second.sessionID,
    firstSlug, secondSlug, firstRunId: first.runId, secondRunId: second.runId, controlURL: `http://127.0.0.1:${control.port}`,
    observer, out, managerOnly: true, binary: join(process.env.HOME!, ".opencode/bin/opencode") }
  await writeFile(join(out, "host.json"), JSON.stringify(packet))
  const auth = endpoint.auth?.type === "basic" ? { OPENCODE_PASSWORD: endpoint.auth.password, OPENCODE_USERNAME: endpoint.auth.username } : {}
  const gate = Bun.spawn(["python3", join(import.meta.dir, "../spikes/goal-manager-gate.py"), join(out, "host.json")], { env: { ...process.env, ...auth }, stdout: "inherit", stderr: "inherit" })
  const exit = await gate.exited, a = await run(firstSlug), b = await run(secondSlug)
  await writeFile(join(out, "result.json"), JSON.stringify({ pass: exit === 0 && a.status === "paused" && b.status === "waiting" && a.runId === first.runId && b.runId === second.runId,
    exit, first: a, second: b, primaryID: primary.id, model: prior.originalModel, revision: prior.revision, automatedQATestOwner: true, providerIsFixture: false }, null, 2))
  await writeFile(join(out, "first-transcript.json"), JSON.stringify(await client.session.context({ sessionID: a.sessionID } as any), null, 2))
  await writeFile(join(out, "second-transcript.json"), JSON.stringify(await client.session.context({ sessionID: b.sessionID } as any), null, 2))
  if (exit !== 0 || a.status !== "paused" || b.status !== "waiting") throw Error("Real-model deployed manager gate failed")
  console.log(JSON.stringify({ pass: true, evidence: out, revision: prior.revision, serverPID: info.pid, providerIsFixture: false }))
} finally { control.stop(true) }
