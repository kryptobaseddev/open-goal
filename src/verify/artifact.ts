// Runtime provenance belongs to the plugin instance that is executing the
// goal, not whichever shared service an unscoped `opencode api` happens to
// find. Pin the loaded bytes once at setup; registry metadata is re-read
// through that instance's own location-scoped API.
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { HarnessIdentity } from "../engine/harness-identity"

export type ArtifactHashes = Record<string, string>
export type ArtifactSource = { type: string; target?: string; version?: string; outdated?: boolean; path?: string }
export type RuntimeProvenance = {
  schema: "opencode-goal/provenance/v1"
  serverPID: number
  openCodeVersion: string
  location: string
  packageRoot: string
  packageVersion: string
  capturedAt: number
  observedAt: number
  source: ArtifactSource
  status: string
  features: { server: boolean; tui: boolean; rpc: boolean }
  artifacts: ArtifactHashes
  sessionID?: string
  runId?: string
  lock?: string
  /** v0.9.5: the harness serving this run, as the run recorded it. */
  harness?: HarnessIdentity
}

const entrypoints = ["package.json", "server.ts", "tui.tsx", "rpc.ts"]
const directories = ["src", "skills", "dist"]
/** The package's `files` excludes the skill eval fixtures under
 * `skills/<name>/evals/`; those are neither shipped nor loaded, so they are not
 * production artifacts and can never be byte-proven from an installed package. */
const notShipped = /^skills\/[^/]+\/evals\//
export const isArtifactPath = (path: string) =>
  !notShipped.test(path) && (entrypoints.includes(path) || directories.some((dir) => path.startsWith(`${dir}/`)))
export const hashArtifact = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

export function captureArtifactHashes(root: string): ArtifactHashes {
  const files = [...entrypoints]
  const walk = (relative: string) => {
    for (const item of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${item.name}`
      if (item.isSymbolicLink()) throw new Error(`Artifact symlink is not a loaded-byte proof: ${path}`)
      if (item.isDirectory()) walk(path)
      else if (item.isFile() && isArtifactPath(path)) files.push(path)
    }
  }
  for (const dir of directories) walk(dir)
  return Object.fromEntries(files.sort().map((path) => {
    if (!lstatSync(join(root, path)).isFile()) throw new Error(`Missing artifact file: ${path}`)
    return [path, hashArtifact(readFileSync(join(root, path)))]
  }))
}

/** Return all discrepancies, never let a matching semantic label substitute
 * for a Git revision or the actual bytes. Absent outdated means no update is
 * reported by V2; an absent revision is still an error. */
export function artifactDiscrepancies(actual: RuntimeProvenance, expected: {
  revision: string
  artifacts: ArtifactHashes
  location?: string
  serverPID?: number
  sessionID?: string
  runId?: string
  lock?: string
  minVersion?: string
}): string[] {
  const errors: string[] = []
  if (actual.schema !== "opencode-goal/provenance/v1") errors.push("missing runtime provenance schema")
  if (!/^[a-f0-9]{40}$/.test(expected.revision)) errors.push("expected revision must be a full immutable Git SHA")
  if (actual.source.type !== "package") errors.push("the running plugin is not a package install")
  if (actual.source.version !== expected.revision) errors.push(`running revision ${actual.source.version ?? "unknown"} differs from ${expected.revision}`)
  if (actual.source.outdated === true) errors.push("the running plugin reports outdated=true")
  if (actual.status !== "active" || !actual.features?.server || !actual.features?.tui || !actual.features?.rpc) errors.push("the serving plugin is not active with server/TUI/RPC features")
  for (const key of ["location", "serverPID", "sessionID", "runId", "lock"] as const) {
    if (expected[key] !== undefined && actual[key] !== expected[key]) errors.push(`runtime ${key} does not match the goal/check caller`)
  }
  const required = ["package.json", "server.ts", "tui.tsx", "rpc.ts", "dist/tui.js", "src/server/app.ts", "src/tui/index.tsx", "src/tui/dashboard.ts", "skills/write-goal/SKILL.md"]
  for (const path of required) if (!expected.artifacts[path]) errors.push(`release manifest omits ${path}`)
  const paths = new Set([...Object.keys(expected.artifacts), ...Object.keys(actual.artifacts)])
  for (const path of paths) {
    if (!isArtifactPath(path) || !/^[a-f0-9]{64}$/.test(expected.artifacts[path] ?? "") || actual.artifacts[path] !== expected.artifacts[path])
      errors.push(`artifact mismatch: ${path}`)
  }
  if (expected.minVersion && !versionAtLeast(actual.packageVersion, expected.minVersion)) errors.push(`package ${actual.packageVersion} is below ${expected.minVersion}`)
  return errors
}

export function versionAtLeast(actual: string, minimum: string): boolean {
  const parse = (s: string) => /^(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?(?:\+[\w.-]+)?$/.exec(s)
  const a = parse(actual), b = parse(minimum)
  if (!a || !b) return false
  for (let i = 1; i <= 3; i++) {
    if (Number(a[i]) !== Number(b[i])) return Number(a[i]) > Number(b[i])
  }
  // A prerelease is below its corresponding stable minimum. This checker
  // deliberately does not rank arbitrary prerelease identifiers.
  return !a[4] || a[4] === b[4]
}
