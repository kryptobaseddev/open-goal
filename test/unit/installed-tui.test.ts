import { afterAll, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import type { GoalSummary } from "../../src/rpc"

// Match the host's runtime mapping. Its node_modules exclusion MUST remain:
// no compiler is supplied for the installed package under test.
ensureSolidTransformPlugin()
const { testRender } = await import("@opentui/solid")
const root = join(import.meta.dir, "../..")
await mkdir(join(root, ".tmp"), { recursive: true })
const fixture = await mkdtemp(join(root, ".tmp/installed-tui-"))
// Prevent the repository package's self-reference from bypassing node_modules.
await writeFile(join(fixture, "package.json"), JSON.stringify({ name: "goal-tui-consumer", type: "module" }))
const installed = join(fixture, "node_modules/opencode-goal")
await mkdir(installed, { recursive: true })
for (const path of ["package.json", "tui.tsx", "dist"]) await cp(join(root, path), join(installed, path), { recursive: true })
afterAll(() => rm(fixture, { recursive: true, force: true }))
const entry = Bun.resolveSync("opencode-goal/tui", fixture)
const plugin: typeof import("../../src/tui/index").default = (await import(entry)).default

const primary = "ses_primary"
const goals: GoalSummary[] = ["alpha", "beta"].map((slug, i) => ({
  key: `live:${slug}:run_${slug}`, slug, title: `${slug} waiting goal`, status: "waiting",
  sessionID: `ses_${slug}`, sessionState: "present", agent: "build", runId: `run_${slug}`,
  lock: String(i + 1).repeat(64), total: 2, proven: i, terminal: false, valid: true,
  outcome: `Verified outcome for ${slug}`,
}))

async function mount(locationMode: "session" | "context" | "default" = "session") {
  const slots = new Map<string, any>(), handlers = new Map<string, any>()
  const calls: Array<{ method: string; input: any; options: any }> = []
  const jumps: string[] = [], panels: string[] = []
  const location = { directory: `/project/${locationMode}` }
  let deliver!: (value: unknown) => void
  let serverGoals = goals
  const initial = new Promise((resolve) => { deliver = resolve })
  let reads = 0
  const rpc = {
    list: async (input: any, options: any) => {
      calls.push({ method: "list", input, options })
      return ++reads === 1 ? initial : { goals: serverGoals, directory: location.directory }
    },
    snapshot: async (input: any, options: any) => { calls.push({ method: "snapshot", input, options }); return { view: null } },
    details: async (input: any, options: any) => {
      calls.push({ method: "details", input, options })
      return { goal: serverGoals.find((g) => g.key === input.key) }
    },
    manage: async (input: any, options: any) => { calls.push({ method: "manage", input, options }); return { ok: true, pending: true, message: "Native review required" } },
    events: { on: (name: string, handler: any) => { handlers.set(name, handler); return () => handlers.delete(name) } },
  }
  const stop = await plugin.setup({
    client: { rpc: () => rpc },
    location: locationMode === "context" ? location : undefined,
    data: {
      session: { get: () => locationMode === "session" ? { location } : undefined },
      location: { default: () => location }, listen: () => () => {},
    },
    theme: { text: { base: "#ffffff", muted: "#888888", feedback: {} } },
    ui: {
      slot: (claim: any) => { slots.set(claim.append, claim); return () => slots.delete(claim.append) },
      router: { current: () => ({ type: "session", sessionID: primary }), navigate: () => { throw new Error("tabs should be used") } },
      tabs: { enabled: () => true, open: (id: string) => jumps.push(`open:${id}`), focus: (id: string) => jumps.push(`focus:${id}`) },
      panel: { open: (name: string) => panels.push(name), current: () => undefined, close: () => {} },
      toast: { show: () => {} }, dialog: {},
    },
  } as any)
  const terminal = await testRender(() => [
    slots.get("sidebar.content").render({ sessionID: primary, width: 40 }),
    slots.get("session.panel").render({ name: "goal-dashboard", sessionID: primary, width: 40, height: 30, focus: () => {} }),
  ], { width: 44, height: 44 })
  const render = async () => { await Bun.sleep(25); await terminal.renderOnce() }
  const control = (id: string) => terminal.renderer.root.findDescendantById(id) as any
  return {
    terminal, render, control, deliver, calls, jumps, panels, location,
    refresh: (next: GoalSummary[]) => { serverGoals = next; handlers.get("updated")({ data: { sessionID: "ses_alpha", view: null } }) },
    stop: () => { stop(); terminal.renderer.destroy() },
  }
}

test("package exports and local bridge load shipped universal JS, without source TSX or a bundled runtime", async () => {
  expect(entry).toBe(join(installed, "dist/tui.js"))
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"))
  expect(manifest.files).toContain("dist")
  expect((await import(join(installed, "tui.tsx"))).default).toBe(plugin)
  const code = await readFile(entry, "utf8")
  expect(code).toContain('from "@opentui/solid"')
  expect(code).toContain('from "solid-js"')
  expect(code).toContain('from "solid-js/store"')
  expect(code).not.toContain("jsx-runtime")
  // All remaining runtime imports are external: the bundle requires no src files.
  expect([...code.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).every((s) => ["@opentui/solid", "solid-js", "solid-js/store"].includes(s!))).toBe(true)
})

test("installed native cards and manager react AFTER the initial empty mount, expand before jump, and bind selected actions", async () => {
  const ui = await mount()
  try {
    await ui.render()
    expect(ui.control(`goal-card:${goals[0]!.key}`)).toBeUndefined()
    expect(ui.terminal.captureCharFrame()).toContain("Loading project goals")
    ui.deliver({ goals, directory: ui.location.directory })
    await ui.render()
    const alpha = ui.control(`goal-card:${goals[0]!.key}`), beta = ui.control(`goal-card:${goals[1]!.key}`)
    expect(alpha).toBeDefined()
    expect(beta).toBeDefined()
    expect(ui.control("goal-manager-list").options).toHaveLength(2)
    expect(ui.terminal.captureCharFrame()).toContain("Goals (2)")
    alpha.focus()
    ui.refresh(goals.map((g, i) => i === 0 ? { ...g, status: "paused", proven: 2 } : g))
    await ui.render()
    expect(ui.control(`goal-card:${goals[0]!.key}`)).toBe(alpha)
    expect(alpha.focused).toBe(true)
    expect(alpha.getSelectedOption().description).toContain("paused")
    expect(ui.terminal.captureCharFrame()).toContain("2/2 proven")
    // Native pointer selects the second card: mere expansion cannot jump.
    await ui.terminal.mockMouse.click(beta.x + 1, beta.y + 1)
    await ui.render()
    expect(ui.panels).toContain("goal-dashboard")
    expect(ui.control("goal-manager-details")).toBeDefined()
    expect(ui.terminal.captureCharFrame()).toContain("Verified outcome for beta")
    expect(ui.jumps).toEqual([])
    const actions = ui.control("goal-manager-actions")
    actions.focus()
    ui.terminal.mockInput.pressEnter() // explicit first action: Open goal session
    await ui.render()
    expect(ui.jumps).toEqual(["open:ses_beta", "focus:ses_beta"])
    actions.focus()
    ui.terminal.mockInput.pressArrow("down") // Pause selected goal
    ui.terminal.mockInput.pressEnter()
    await ui.render()
    expect(ui.calls.find((c) => c.method === "manage")).toEqual({
      method: "manage", input: { sessionID: primary, action: "pause", target: { key: goals[1]!.key, lock: goals[1]!.lock, runId: goals[1]!.runId, sessionID: "ses_beta" } },
      options: { location: ui.location },
    })
  } finally { ui.stop() }
})

for (const mode of ["context", "default"] as const) test(`installed inventory uses ${mode} location when session cache is absent; missing inventory is not empty success`, async () => {
  const ui = await mount(mode)
  try {
    ui.deliver({})
    await ui.render()
    expect(ui.calls.filter((c) => ["snapshot", "list"].includes(c.method)).every((c) => c.options?.location === ui.location)).toBe(true)
    expect(ui.terminal.captureCharFrame()).toContain("Inventory unavailable")
    expect(ui.terminal.captureCharFrame()).not.toContain("No goals")
    expect(ui.control("goal-sidebar-manager").getSelectedOption().name).toContain("Retry goals")
    ui.refresh(goals)
    await ui.render()
    expect(ui.control(`goal-card:${goals[1]!.key}`)).toBeDefined()
    expect(ui.terminal.captureCharFrame()).not.toContain("Inventory unavailable")
  } finally { ui.stop() }
})
