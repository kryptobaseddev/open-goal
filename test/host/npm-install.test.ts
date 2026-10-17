// Installs the plugin the way a user does: from the npm registry via
// OpenCode's own package installer. Set OCGOAL_NPM_SPEC to test another
// version, or OCGOAL_NPM_INSTALL=1 to enable.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { startHost, until } from "./harness"

const SPEC = process.env.OCGOAL_NPM_SPEC ?? "@cleocode/goal@0.8.1"

/** The newest installed copy of the package in the harness's shared cache. */
function installedManifest(): string | undefined {
  const cacheRoot = join(import.meta.dir, "..", "..", ".tmp", "host-cache", "opencode", "npm")
  if (!existsSync(cacheRoot)) return undefined
  const manifests: Array<{ path: string; mtime: number }> = []
  for (const dir of readdirSync(cacheRoot)) {
    const base = join(cacheRoot, dir)
    let stamps: string[] = []
    try { stamps = readdirSync(base) } catch { continue }
    for (const stamp of stamps) {
      const path = join(base, stamp, "node_modules", "@cleocode", "goal", "package.json")
      if (existsSync(path)) manifests.push({ path, mtime: statSync(path).mtimeMs })
    }
  }
  return manifests.sort((a, b) => b.mtime - a.mtime)[0]?.path
}

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

      // The TUI entry's runtime must resolve in the installed npm package too:
      // @opentui/solid is a production dependency, not a dev one.
      const manifestPath = installedManifest()
      expect(manifestPath).toBeDefined()
      const manifest = JSON.parse(readFileSync(manifestPath!, "utf8"))
      expect(manifest.name).toBe("@cleocode/goal")
      expect(manifest.dependencies?.["@opentui/solid"]).toBeDefined()
      expect(JSON.stringify(manifest)).not.toContain('"private":true')
    } finally {
      await host.stop()
    }
  }, 180000)
})
