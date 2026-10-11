import { expect, test } from "bun:test"
import { join } from "node:path"

test("the typed test entry refuses empty suites, options, directories, globbing and escaping inputs before spawning tests", () => {
  const root = join(import.meta.dir, "../..")
  for (const args of [[], ["test/unit"], ["--watch"], ["test/**/*.test.ts"], ["../escape.test.ts"], ["/outside.test.ts"]]) {
    const result = Bun.spawnSync([process.execPath, "scripts/run-scoped-tests.ts", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toMatch(/Explicit|Not an explicit/)
    expect(result.stdout.toString()).not.toContain("bun test")
  }
})
