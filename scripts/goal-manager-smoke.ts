// Real TUI/PTY gate. The read-only test observer proves native Select
// controls/focus/bounds; keyboard/mouse input is driven through a real PTY.
import { join } from "node:path"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { OpenCode } from "@opencode/client"
import { mkdir, writeFile } from "node:fs/promises"
import { DEMO_GOAL, goalHost, newSession, run, script, text, waitStatus } from "../test/host/goal.helpers"
import { until } from "../test/host/harness"

if (!process.argv.includes("--assert")) throw new Error("Use --assert; this gate never reports a screenshot as a pass")
// OpenCode watches local plugin directories recursively. Writing live gate
// artifacts under THIS repo reloads the plugin and pauses unrelated goals.
const out = join(tmpdir(), "opencode", "goal-manager-gates", `${Date.now()}-${process.pid}`)
await mkdir(out, { recursive: true })
const observer = join(out, "render-tree.json")
const asked = new Set<string>()
// Preserve plugin activation diagnostics when the real client opens a new
// session tab; a new lazy location must not pause the unrelated goal.
process.env.OPENCODE_LOG_LEVEL = "debug"
const fixtureHost = await goalHost(script((req, turn) => {
  const lines = req.messages.map(text).join("\n").split("\n")
  const payload = lines.findLast((l) => l.startsWith("GOAL_DECISION_JSON:"))
  const presentation = lines.findLast((l) => l.startsWith("GOAL_DECISION_ASK:"))
  if (payload && presentation && !asked.has(presentation)) {
    asked.add(presentation)
    return { toolCalls: [{ name: "question", args: JSON.parse(payload.slice("GOAL_DECISION_JSON:".length)) }] }
  }
  if (turn.results === 0) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "real manager terminal gate" } }] }
  return { text: "Holding this goal for terminal inspection." }
}), { ".opencode/goals/second/goal.yaml": DEMO_GOAL.replace("id: demo", "id: second").replace("Demo file says ok", "Second Managed Goal") }, {
  extraPlugins: [{ package: join(import.meta.dir, "../test/fixtures/manager-pty-probe"), options: { output: observer } }],
})
// macOS /var is a symlink to /private/var. The CLI canonicalizes cwd; use
// the SAME location in the API, or two distinct plugin instances recover
// the same folders and pause each other's goals before the test begins.
const project = realpathSync(fixtureHost.project)
const host = { ...fixtureHost, project, location: { directory: project }, client: OpenCode.make({ baseUrl: fixtureHost.url, headers: { "x-opencode-directory": project, authorization: "Basic " + Buffer.from(`opencode:${fixtureHost.password}`).toString("base64") } }) }
try {
  const created: any = await host.client.session.create({ location: host.location, title: "Primary Manager", agent: "build", model: { providerID: "fixture", id: "test" } } as any)
  const primary = created.id, one = await newSession(host), two = await newSession(host)
  await host.client.session.command({ sessionID: one, name: "goal", text: "start demo" } as any)
  const first = await waitStatus(host, ["waiting"], 15000)
  await host.client.session.command({ sessionID: two, name: "goal", text: "start second" } as any)
  const second = await waitStatus(host, ["waiting"], 15000, "second")
  const control = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/state") return Response.json({ first: await run(host), second: await run(host, "second") })
    if (request.method === "POST" && url.pathname === "/fresh") {
      await host.client.session.command({ sessionID: primary, name: "goal", text: "start demo fresh" } as any)
      // Commands may be acknowledged while the abort-confirmation turn is
      // finishing. Do not mistake its old aborted state for a fresh launch.
      const launched = await until(async () => {
        const state = await run(host)
        return state && state.runId !== first.runId && state.handoff?.fromSessionID === primary ? state : undefined
      }, 20000)
      return Response.json({ first: launched })
    }
    return new Response("Not found", { status: 404 })
  } })
  try {
    // The current gate's fresh phase restarts the ABORTED demo only after a
    // real rendered manager action aborts it. The other goal stays waiting.
    await writeFile(join(out, "host.json"), JSON.stringify({ url: host.url, project: host.project, sessionID: primary, firstSessionID: one, secondSessionID: two, firstRunId: first.runId, secondRunId: second.runId, controlURL: `http://127.0.0.1:${control.port}`, observer, out, env: host.env, binary: process.env.OPENCODE_BINARY ?? join(process.env.HOME!, ".opencode/bin/opencode") }))
    const gate = Bun.spawn(["python3", join(import.meta.dir, "../spikes/goal-manager-gate.py"), join(out, "host.json")], { stdout: "inherit", stderr: "inherit" })
    const exit = await gate.exited
    const current = await run(host), other = await run(host, "second")
    await writeFile(join(out, "server.log"), host.log())
    await writeFile(join(out, "fixture-requests.json"), JSON.stringify(host.fixture.requests, null, 2))
    await writeFile(join(out, "primary-context.json"), JSON.stringify(await host.client.session.context({ sessionID: primary } as any), null, 2))
    for (const slug of ["demo", "second"]) {
      await writeFile(join(out, `${slug}.ledger.jsonl`), await host.readProject(`.opencode/goals/${slug}/ledger.jsonl`))
    }
    const serverLog = join(host.env.XDG_DATA_HOME!, "opencode/log/opencode.log")
    if (await Bun.file(serverLog).exists()) await writeFile(join(out, "plugin-lifecycle.log"), (await Bun.file(serverLog).text()).split("\n").filter((line) => line.includes("opencode-goal") || line.includes('component=location')).join("\n"))
    const focused: any = await Bun.file(observer).json().catch(() => null)
    const pass = exit === 0 && other.runId === second.runId && other.status === "waiting" && current.sessionID !== one && current.sessionID !== primary && focused?.route?.sessionID === current.sessionID
    await writeFile(join(out, "result.json"), JSON.stringify({ pass, ptyExit: exit, current, other, focused, artifacts: out }, null, 2))
    console.log(`GOAL-MANAGER-PTY ${pass ? "PASS" : "FAIL"} artifacts=${out}`)
    process.exitCode = pass ? 0 : 1
  } finally { control.stop(true) }
} finally { await host.stop() }
