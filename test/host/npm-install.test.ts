// Installs the plugin the way a user does: from the npm registry via
// OpenCode's own package installer. Set OCGOAL_NPM_SPEC to test another
// version, or OCGOAL_NPM_INSTALL=1 to enable.
import { describe, expect, test } from "bun:test"
import { GoalRpc } from "../../src/rpc"
import { startHost, until } from "./harness"

const SPEC = process.env.OCGOAL_NPM_SPEC ?? "@cleocode/goal@0.9.2"

describe.skipIf(!process.env.OCGOAL_NPM_INSTALL)("install from npm", () => {
  test(`OpenCode installs ${SPEC} and registers /goal, the tools and the skill`, async () => {
    const host = await startHost({ plugins: [SPEC], git: true, script: () => ({ text: "ok" }) })
    try {
      const commands: any = await until(async () => {
        const list: any = await host.client.command.list({ location: host.location } as any)
        const items = Array.isArray(list) ? list : list?.data ?? []
        return items.some((c: any) => c.name === "goal") ? items : undefined
      }, 120000, 500)
      expect(commands.some((c: any) => c.name === "goal")).toBe(true)
      const skills: any = await host.client.skill.list({ location: host.location } as any)
      expect((Array.isArray(skills) ? skills : skills?.data ?? []).some((s: any) => s.id === "write-goal")).toBe(true)

      // The serving package is the npm artifact, not a git checkout: provenance
      // reports the package version and the registry spec it was installed from.
      const session: any = await host.client.session.create({
        location: host.location, agent: "build", model: { providerID: "fixture", id: "test" },
      } as any)
      const rpc: any = (host.client as any).rpc(GoalRpc)
      const provenance = await rpc.provenance({ sessionID: session.id })
      expect(provenance.status).toBe("active")
      expect(provenance.packageVersion).toBe(SPEC.split("@").pop())
      expect(JSON.stringify(provenance.source)).toContain("@cleocode/goal")
      // The TUI entry's runtime is a production dependency, so the plugin's
      // TUI half resolves from the npm artifact too.
      expect(provenance.features?.tui).toBe(true)
    } finally {
      await host.stop()
    }
  }, 180000)
})
