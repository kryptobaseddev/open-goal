import { describe, expect, test } from "bun:test"
import { until } from "./harness"
import { goalHost, newSession, script } from "./goal.helpers"
import { GoalRpc } from "../../src/rpc"

// v0.5.0 — the /goal cleo health surface, end-to-end against a real host. It
// reports the true state of the running project and NEVER installs or
// initializes anything by itself: every offered command waits for the owner.

const idle = script(() => ({ text: "ok" }))

async function command(host: Awaited<ReturnType<typeof goalHost>>, sessionID: string, text: string, match: RegExp): Promise<string> {
  const goalRpc = (host.client as any).rpc(GoalRpc)
  const notices: string[] = []
  const off = goalRpc.events.on("notice", (e: any) => notices.push(String(e?.data?.text ?? e?.text ?? "")))
  await host.client.session.command({ sessionID, name: "goal", text } as any)
  const found = await until(async () => notices.find((n) => match.test(n)) ?? undefined, 30000)
  off?.()
  return found ?? notices.join("\n")
}

describe("the /goal cleo health surface (v0.5.0)", () => {
  test("a project with no .cleo reports uninitialized and offers `cleo init` — and runs nothing", async () => {
    const host = await goalHost(idle)
    try {
      const sessionID = await newSession(host)
      const text = await command(host, sessionID, "cleo", /CLEO/)
      expect(text).toContain("no .cleo workspace")
      expect(text).toContain("cleo init")
      expect(text).toContain("never runs this silently")
      // Nothing was initialized: the project still has no .cleo workspace.
      await expect(host.readProject(".cleo/project-context.json")).rejects.toBeDefined()
    } finally {
      await host.stop()
    }
  }, 120000)

  test("a project WITH a .cleo workspace reports initialized", async () => {
    const host = await goalHost(idle, { ".cleo/project-context.json": JSON.stringify({ schemaVersion: "1.0.0", projectTypes: ["unknown"] }) })
    try {
      const sessionID = await newSession(host)
      const text = await command(host, sessionID, "cleo", /CLEO/)
      expect(text).toContain("initialized")
      expect(text).not.toContain("never runs this silently") // nothing is offered to run
    } finally {
      await host.stop()
    }
  }, 120000)

  test("`/goal cleo install` on an initialized project is refused — never a silent reinstall", async () => {
    const host = await goalHost(idle, { ".cleo/project-context.json": "{}" })
    try {
      const sessionID = await newSession(host)
      const text = await command(host, sessionID, "cleo install", /already initialized/)
      expect(text).toContain("already initialized")
    } finally {
      await host.stop()
    }
  }, 120000)

  test("an unknown subcommand prints the usage instead of guessing", async () => {
    const host = await goalHost(idle)
    try {
      const sessionID = await newSession(host)
      const text = await command(host, sessionID, "cleo bogus", /Usage: \/goal cleo/)
      expect(text).toContain("Usage: /goal cleo")
    } finally {
      await host.stop()
    }
  }, 120000)
})
