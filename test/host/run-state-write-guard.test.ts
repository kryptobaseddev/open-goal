import { expect, test } from "bun:test"
import { join } from "node:path"
import { DEMO_GOAL, goalHost, newSession, script, waitStatus } from "./goal.helpers"
import { until } from "./harness"

// The owner reported an agent hand-merging run.json (duplicate keys) because
// the write guard covered only edit/write/patch: a shell command or script
// could write into the live goal folder. This pins the closed hole: every
// reachable write path is refused with a message that names the supported
// tool, reads stay allowed, and another project's or an archived folder is not
// newly blocked by this rule.

const RUN = ".opencode/goals/demo/run.json"

async function toolResults(host: Awaited<ReturnType<typeof goalHost>>) {
  type Message = { role?: string; content?: unknown }
  return (host.fixture.requests as Array<{ messages?: Message[] }>).flatMap((request) =>
    (request.messages ?? []).filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))),
  )
}

async function attempt(host: Awaited<ReturnType<typeof goalHost>>, sessionID: string, command: string, tag: string) {
  const before = (await toolResults(host)).length
  await host.client.session.prompt({ sessionID, text: `SHELL ${tag}` } as never)
  return until(async () => {
    const results = await toolResults(host)
    return results.length > before ? results.at(-1) : undefined
  }, 20000)
}

test("a shell write into a live goal folder is refused and names the supported tool", async () => {
  let command = ""
  const host = await goalHost(script((_request, turn) => {
    if (turn.trigger.startsWith("SHELL ") && turn.results === 0) return { toolCalls: [{ name: "shell", args: { command } }] }
    if (turn.trigger.startsWith("SHELL ")) return { text: "shell done" }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold for the write guard" } }] }
    return { text: "Holding." }
  }), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    await waitStatus(host, ["waiting"], 15000)
    const original = await host.readProject(RUN)

    for (const [tag, cmd] of [
      ["redirection", `echo '{"version":1,"status":"complete"}' > ${RUN}`],
      ["append", `cat ${RUN} >> ${RUN}`],
      ["interpreter", `python3 -c "open('${RUN}','w').write('{\\"version\\":1,\\"status\\":\\"complete\\"}')"`],
      ["in-place edit", `sed -i '' 's/paused/running/' ${RUN}`],
      ["move", `mv /dev/null ${RUN}`],
    ] as const) {
      command = cmd
      const result = await attempt(host, owner, cmd, tag)
      expect(result, `${tag}: a write into a live goal folder must be refused`).toMatch(/host|owner/i)
      expect(result, `${tag}: the refusal names the supported tool`).toMatch(/goal_progress|goal_wait|goal_block|goal_flag|goal_claim|goal_manage|goal_recover_divergence/)
      expect(result, `${tag}: never leaves editing as the apparent option`).not.toMatch(/permission denied/i)
      expect(await host.readProject(RUN), `${tag}: the file must be untouched`).toBe(original)
    }

    // Reads stay allowed: inspecting goal state is not a write.
    for (const cmd of [`cat ${RUN}`, `grep -c version ${RUN}`, `ls -la .opencode/goals/demo`]) {
      command = cmd
      const result = await attempt(host, owner, cmd, "read")
      expect(result, `read "${cmd}" must not be refused`).not.toMatch(/owner and the host|names the supported tool/i)
    }
    expect((await host.readProject(RUN))).toBe(original)
  } finally { await host.stop() }
}, 90000)

test("a shell write to another project's or an archived folder is not newly blocked", async () => {
  let command = ""
  const host = await goalHost(script((_request, turn) => {
    if (turn.trigger.startsWith("OUT ") && turn.results === 0) return { toolCalls: [{ name: "shell", args: { command } }] }
    if (turn.trigger.startsWith("OUT ")) return { text: "done" }
    if (!turn.results) return { toolCalls: [{ name: "goal_wait", args: { seconds: 300, reason: "hold" } }] }
    return { text: "Holding." }
  }), {}, { plugin: process.env.OCGOAL_GIT_SPEC })
  try {
    const owner = await newSession(host)
    await host.client.session.command({ sessionID: owner, name: "goal", text: "start demo" } as never)
    await waitStatus(host, ["waiting"], 15000)
    for (const [tag, cmd] of [
      ["archived", "echo x > .opencode/goals-archive/old/goal.yaml"],
      ["elsewhere", `echo x > ${join(host.project, "notes.txt")}`],
    ] as const) {
      command = cmd
      const result = await attempt(host, owner, cmd, tag)
      expect(result, `${tag}: only a live goal folder is guarded`).not.toMatch(/owned by the owner and the host/i)
    }
  } finally { await host.stop() }
}, 90000)
