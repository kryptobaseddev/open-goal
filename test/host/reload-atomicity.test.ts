import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { toolNames, until, type ChatRequest } from "./harness"
import { goalHost, ledger, newSession, run, script, waitStatus } from "./goal.helpers"
import { parseContract } from "../../src/contract/parse"
import { initialRun, setStatus } from "../../src/engine/state"

// T173 — reload atomicity and disk-backed reads.
//
// The real failure: after a plugin hot-load a running session lost its entire
// goal tool surface (`axiom-instrument-studio-tbl6run`), and only a fresh
// engine/session recovered. The requirements pinned here:
//   1. a hot-load reaches a session that already exists, with the WHOLE surface
//      and no duplicate registrations;
//   2. goal_status / goal_inventory serve the paused run from disk;
//   3. a read never mutates the run, and a stale in-memory generation never
//      shadows the disk generation;
//   4. the session this server never witnessed can still read its own run from
//      disk (memory is a cache, not the truth);
//   5. the ordinary owner resume path still works afterwards.

const DONE = "status: ok - reload atomicity\n"

const READ_PROBE = "reload probe"

const worker = script((_req: ChatRequest, turn) => {
  if (turn.trigger.includes(READ_PROBE)) {
    if (turn.results === 0)
      return { toolCalls: [
        { name: "goal_status", args: {} },
        { name: "goal_inventory", args: {} },
      ] }
    return { text: "Read both surfaces." }
  }
  if (turn.trigger.includes("goal started") || turn.trigger.includes("goal turn") || turn.trigger.includes("resumed")) {
    if (turn.results === 0) return { toolCalls: [{ name: "write", args: { path: "done.txt", content: DONE } }] }
    if (turn.results === 1)
      return { toolCalls: [{ name: "goal_progress", args: { step: "S1", step_done: true, note: "wrote done.txt", next: "wait for the owner to pause" } }] }
    return { text: "Working until the owner pauses." }
  }
  return { text: "Idle." }
})

const resultText = (message: ChatRequest["messages"][number]) =>
  typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")

/** Tool results produced by the CURRENT turn only: a request carries the whole
 *  conversation, so a bare scan would find the previous turn's results too. */
const currentResults = (request: ChatRequest) => {
  let lastUser = -1
  for (let i = request.messages.length - 1; i >= 0; i--)
    if (request.messages[i]!.role === "user") { lastUser = i; break }
  return request.messages.slice(lastUser + 1).filter((m) => m.role === "tool").map(resultText)
}

const toolResults = (host: Awaited<ReturnType<typeof goalHost>>, from = 0) =>
  host.fixture.requests.slice(from).flatMap((r) => currentResults(r))

const goalNames = (request: ChatRequest) => toolNames(request).filter((n) => n.startsWith("goal_"))

/** goal_status answers with a GoalView; goal_inventory with {goals:[…]}. */
const isStatusView = (text: string) => text.includes('"target"') && text.includes('"criteria"')

const reload = async (host: Awaited<ReturnType<typeof goalHost>>) => {
  await host.client.location.reload()
  await until(async () => {
    try { await host.client.plugin.list({ location: host.location } as any); return true } catch { return false }
  }, 30000)
}

const waitProbeRequest = (host: Awaited<ReturnType<typeof goalHost>>, from: number) =>
  until(async () => {
    const request = host.fixture.requests.slice(from).find((r) => r.tools?.length && r.messages.some((m) => m.role === "user" && resultText(m).includes(READ_PROBE)))
    return request
  }, 30000)

test("a hot-load mid-session keeps exactly one complete goal surface and reads the paused run from disk", async () => {
  const host = await goalHost(worker)
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)
    await until(async () => (await ledger(host)).some((e) => e.type === "progress"), 60000)
    await host.client.session.command({ sessionID, name: "goal", text: "pause" } as any)
    const paused = await waitStatus(host, ["paused"], 30000)
    expect(paused.steps.S1).toBe("done")

    // The surface this session was created under.
    const beforeRequests = host.fixture.requests.filter((r) => r.tools?.length)
    const beforeNames = goalNames(beforeRequests.at(-1)!).sort()
    expect(beforeNames).toContain("goal_status")
    expect(beforeNames).toContain("goal_inventory")
    expect(beforeNames.length).toBeGreaterThanOrEqual(15)

    const runBytes = await host.readProject(".opencode/goals/demo/run.json")

    // ── the hot-load ──
    await reload(host)
    const mark = host.fixture.requests.length
    await host.client.session.prompt({ sessionID, text: READ_PROBE } as any)
    await waitProbeRequest(host, mark)

    // 1. The surface reaches the EXISTING session: the whole set, each name
    //    exactly once — no partial registration and no duplicates.
    const afterRequests = host.fixture.requests.slice(mark).filter((r) => r.tools?.length)
    expect(afterRequests.length).toBeGreaterThan(0)
    for (const request of afterRequests) {
      const names = goalNames(request)
      expect([...names].sort()).toEqual([...beforeNames].sort())
      for (const name of new Set(names)) expect(names.filter((n) => n === name)).toHaveLength(1)
    }

    // 2. goal_status and goal_inventory serve the paused run from disk.
    const pausedResult = await until(async () => {
      const found = toolResults(host, mark).find((t) => isStatusView(t) && t.includes('"slug": "demo"'))
      return found && found.includes(paused.runId) ? found : undefined
    }, 30000)
    expect(pausedResult).toContain('"status": "paused"')
    expect(pausedResult).toContain(paused.lock)
    const inventory = await until(async () => {
      const found = toolResults(host, mark).find((t) => t.includes('"goals"') && t.includes(`live:demo:${paused.runId}`))
      return found
    }, 30000)
    expect(inventory).toContain('"status": "paused"')
    expect(inventory).toContain(paused.lock)

    // 3. Reads never mutate the run on disk.
    expect(await host.readProject(".opencode/goals/demo/run.json")).toBe(runBytes)

    // The supported reconcile is reachable without a restart and never turns
    // the owner's command into a model instruction.
    const quiet = host.fixture.requests.length
    await host.client.session.command({ sessionID, name: "goal", text: "reload" } as any)
    await Bun.sleep(1000)
    expect(host.fixture.requests.length).toBe(quiet)
    expect(await host.readProject(".opencode/goals/demo/run.json")).toBe(runBytes)

    // 4. The ordinary owner resume path still works after the hot-load.
    await host.client.session.command({ sessionID, name: "goal", text: "resume" } as any)
    const resumed = await until(async () => {
      const state = await run(host).catch(() => undefined)
      return state?.status === "running" ? state : undefined
    }, 30000)
    expect(resumed.runId).toBe(paused.runId)
    expect(resumed.lock).toBe(paused.lock)
    await until(async () => host.fixture.requests.slice(quiet).some((r) => r.messages.some((m) => m.role === "user" && resultText(m).includes("resumed"))), 30000)
    await host.client.session.command({ sessionID, name: "goal", text: "pause" } as any)
    await waitStatus(host, ["paused"], 30000)

    // ── a stale in-memory generation must not shadow disk ──
    // Simulate another engine accepting an amendment: new contract bytes, a
    // new lock on the same run, and the matching locked snapshot. This is the
    // READ half (T172 owns the stale-WRITER guard), so nothing after it is
    // asserted about engine writes.
    const amendedYaml = (await host.readProject(".opencode/goals/demo/goal.yaml")).replace("Demo file says ok", "Demo file says ok after amendment")
    const amended = parseContract(amendedYaml, { slug: "demo" })
    expect(amended.contract).toBeTruthy()
    const nextLock = amended.lock
    expect(nextLock).not.toBe(paused.lock)
    await Bun.write(join(host.project, ".opencode/goals/demo/goal.yaml"), amendedYaml)
    const evidenceDir = join(host.project, ".opencode/goals/demo/evidence", paused.runId)
    await mkdir(evidenceDir, { recursive: true })
    await Bun.write(join(evidenceDir, `contract-${nextLock}.yaml`), amendedYaml)
    const onDisk = JSON.parse(await host.readProject(".opencode/goals/demo/run.json"))
    onDisk.lock = nextLock
    await Bun.write(join(host.project, ".opencode/goals/demo/run.json"), `${JSON.stringify(onDisk, null, 2)}\n`)

    const markStale = host.fixture.requests.length
    await host.client.session.prompt({ sessionID, text: READ_PROBE } as any)
    await waitProbeRequest(host, markStale)
    const staleResult = await until(async () => {
      const found = toolResults(host, markStale).find((t) => isStatusView(t) && t.includes('"slug": "demo"') && t.includes(nextLock))
      return found
    }, 30000)
    const staleView = JSON.parse(staleResult)
    expect(staleView.lock).toBe(nextLock)
    expect(staleView.title).toBe("Demo file says ok after amendment")
    expect(staleView.status).toBe("paused")
  } finally {
    await host.stop()
  }
}, 240000)

test("a session this server never witnessed reads its paused run from disk without writing anything", async () => {
  const host = await goalHost(worker)
  try {
    // A session with no goal. Warm the location until the plugin is really set
    // up (a request with tools), so the disk-only run below lands AFTER
    // recovery and this engine never witnesses it.
    const sessionID = await newSession(host)
    await host.client.session.prompt({ sessionID, text: "warm up the location" } as any)
    await until(() => host.fixture.requests.some((r) => r.tools?.length && r.messages.some((m) => m.role === "user" && resultText(m).includes("warm up the location"))), 30000)
    await host.client.session.wait({ sessionID } as any)
    // The demo draft has never started: this engine holds no run for this session.
    expect(await host.readProject(".opencode/goals/demo/run.json").catch(() => "")).toBe("")

    const yaml = (await host.readProject(".opencode/goals/demo/goal.yaml"))
      .replace("id: demo", "id: diskonly")
      .replace("title: Demo file says ok", "title: Disk-only run")
      .replace('verbatim: "make done.txt say ok"', 'verbatim: "prove the disk-only run is readable"')
      .replace("outcome: done.txt exists and states that the status is ok", "outcome: the disk-only run is reported at all")
    const parsed = parseContract(yaml, { slug: "diskonly" })
    expect(parsed.contract).toBeTruthy()
    const state = initialRun(parsed.contract!, { sessionID, runId: "diskonly0001", lock: parsed.lock })
    setStatus(state, "paused", "parked by another engine before this one loaded")
    await mkdir(join(host.project, ".opencode/goals/diskonly"), { recursive: true })
    await Bun.write(join(host.project, ".opencode/goals/diskonly/goal.yaml"), yaml)
    const runBytes = `${JSON.stringify(state, null, 2)}\n`
    await Bun.write(join(host.project, ".opencode/goals/diskonly/run.json"), runBytes)

    await host.client.session.prompt({ sessionID, text: READ_PROBE } as any)
    const status = await until(async () => {
      const found = toolResults(host).find((t) => isStatusView(t) && t.includes('"slug": "diskonly"'))
      return found
    }, 30000)
    expect(status).toContain('"status": "paused"')
    expect(status).toContain("diskonly0001")
    expect(status).toContain(parsed.lock)
    const inventory = await until(async () => toolResults(host).find((t) => t.includes("live:diskonly:diskonly0001")), 30000)
    expect(inventory).toContain('"status": "paused"')

    // A read writes nothing: no run.json rewrite, no ledger event.
    expect(await host.readProject(".opencode/goals/diskonly/run.json")).toBe(runBytes)
    expect(await host.readProject(".opencode/goals/diskonly/ledger.jsonl").catch(() => "")).toBe("")
  } finally {
    await host.stop()
  }
}, 120000)
