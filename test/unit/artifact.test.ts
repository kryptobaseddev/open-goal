import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { artifactDiscrepancies, captureArtifactHashes, isArtifactPath, versionAtLeast, type RuntimeProvenance } from "../../src/verify/artifact"

const artifacts = captureArtifactHashes(join(import.meta.dir, "../.."))
const revision = "c9f84b90080f8b848784122d0e0ac63147530512"
const oldRevision = "1003962ca9adc72800257086c8e02026eb6f03ad"
const actual: RuntimeProvenance = {
  schema: "opencode-goal/provenance/v1", serverPID: 8405, openCodeVersion: "2.0.26",
  location: "/project", packageRoot: "/cache/exact-revision", packageVersion: "0.3.3",
  source: { type: "package", target: "github:owner/project#v0.3.3", version: revision },
  status: "active", features: { server: true, tui: true, rpc: true },
  artifacts, sessionID: "ses_owner", runId: "run_owner", lock: "owner-lock",
  capturedAt: 1, observedAt: 2,
}
const expected = { revision, artifacts, location: actual.location, serverPID: actual.serverPID, sessionID: actual.sessionID, runId: actual.runId, lock: actual.lock, minVersion: "0.3.3" }

test("exact revision, complete artifact bytes and actual caller binding are required", () => {
  expect(artifactDiscrepancies(actual, expected)).toEqual([])
  expect(artifactDiscrepancies({ ...actual, source: { ...actual.source, version: oldRevision } }, expected)).toContain(`running revision ${oldRevision} differs from ${revision}`)
  expect(artifactDiscrepancies({ ...actual, source: { ...actual.source, outdated: true } }, expected)).toContain("the running plugin reports outdated=true")
  expect(artifactDiscrepancies({ ...actual, status: "failed" }, expected)).toContain("the serving plugin is not active with server/TUI/RPC features")
  expect(artifactDiscrepancies({ ...actual, source: { type: "local" } }, expected)).toContain("the running plugin is not a package install")
  expect(artifactDiscrepancies({ ...actual, serverPID: 47629 }, expected)).toContain("runtime serverPID does not match the goal/check caller")
  expect(artifactDiscrepancies({ ...actual, sessionID: "ses_unrelated" }, expected)).toContain("runtime sessionID does not match the goal/check caller")
})

test("a fresh cache with the right version label but old UI bytes is rejected", () => {
  const staleCompiled = { ...actual, artifacts: { ...artifacts, "dist/tui.js": "0".repeat(64) } }
  expect(artifactDiscrepancies(staleCompiled, expected)).toContain("artifact mismatch: dist/tui.js")
  const withoutCompiled = { ...artifacts }
  delete withoutCompiled["dist/tui.js"]
  expect(artifactDiscrepancies({ ...actual, artifacts: withoutCompiled }, { ...expected, artifacts: withoutCompiled })).toContain("release manifest omits dist/tui.js")
  const stale = { ...actual, artifacts: { ...artifacts, "src/tui/index.tsx": "0".repeat(64) } }
  expect(artifactDiscrepancies(stale, expected)).toContain("artifact mismatch: src/tui/index.tsx")
  expect(artifactDiscrepancies(actual, { ...expected, artifacts: {} })).toContain("release manifest omits src/tui/index.tsx")
  const incomplete = { ...artifacts }
  delete incomplete["src/tui/dashboard.ts"]
  expect(artifactDiscrepancies({ ...actual, artifacts: incomplete }, expected)).toContain("artifact mismatch: src/tui/dashboard.ts")
})

test("all production entrypoints, server/TUI modules and skill bytes are captured", () => {
  for (const path of ["server.ts", "tui.tsx", "rpc.ts", "dist/tui.js", "src/server/app.ts", "src/tui/index.tsx", "skills/write-goal/SKILL.md"])
    expect(artifacts[path]).toMatch(/^[a-f0-9]{64}$/)
  expect(Object.keys(artifacts).some((p) => p.startsWith("test/") || p.startsWith(".opencode/"))).toBe(false)
})

test("skill eval fixtures are not production artifacts: the package does not ship them", () => {
  expect(isArtifactPath("skills/write-goal/evals/trigger_queries.json")).toBe(false)
  expect(isArtifactPath("skills/write-goal/evals/nested/README.md")).toBe(false)
  expect(isArtifactPath("skills/write-goal/SKILL.md")).toBe(true)
  expect(isArtifactPath("src/server/app.ts")).toBe(true)
  expect(Object.keys(artifacts).some((p) => p.includes("/evals/"))).toBe(false)
  // Drift guard: the exclusion above must stay in step with the packed file set.
  // If the package starts shipping evals, this fails and the predicate must move.
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8"))
  expect(pkg.files).toContain("!skills/*/evals")
})

test("semantic minimum does not mistake prerelease or malformed labels for a stable release", () => {
  expect(versionAtLeast("0.3.2", "0.3.3")).toBe(false)
  expect(versionAtLeast("0.3.3-alpha.1", "0.3.3")).toBe(false)
  expect(versionAtLeast("0.3.3", "0.3.3")).toBe(true)
  expect(versionAtLeast("0.3.4", "0.3.3")).toBe(true)
  expect(versionAtLeast("0.4.0", "0.3.3")).toBe(true)
  expect(versionAtLeast("local", "0.3.3")).toBe(false)
})
