// Verifies the serving artifact, not a version label or an unrelated cache.
// Host checks receive OCGOAL_CHECK_CONTEXT from their actual GoalApp. Manual
// use requires OPENCODE_SESSION_ID and a host-recorded provenance receipt
// (goal_provenance), and verifies the serving PID belongs to this process's
// ancestry. Never discover/fall back to the default shared service.
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { artifactDiscrepancies, captureArtifactHashes, hashArtifact, isArtifactPath, type RuntimeProvenance } from "../src/verify/artifact"

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  if (i < 0) return undefined
  const value = process.argv[i + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
  return value
}
function git(...args: string[]): Uint8Array {
  const r = Bun.spawnSync(["git", ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", timeout: 30000 })
  if (r.exitCode !== 0) throw new Error(`Git release read failed: ${args[0]}`)
  return r.stdout
}
const decode = (b: Uint8Array) => new TextDecoder().decode(b).trim()
function ancestors(): Set<number> {
  const pids = new Set<number>()
  let pid = process.pid
  for (let depth = 0; pid > 1 && depth < 32; depth++) {
    pids.add(pid)
    const r = Bun.spawnSync(["ps", "-p", String(pid), "-o", "ppid="], { stdout: "pipe", stderr: "pipe" })
    if (r.exitCode) break
    const next = Number(r.stdout.toString().trim())
    if (!Number.isInteger(next) || next <= 0 || next === pid) break
    pid = next
  }
  return pids
}

try {
  const root = realpathSync(process.cwd())
  const minVersion = option("--min-version") ?? "0.3.3"
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version
  const ref = option("--ref") ?? `v${version}`
  if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(ref)) throw new Error("Expected a release tag, not a mutable branch")
  const revision = decode(git("rev-parse", "--verify", `${ref}^{commit}`))
  if (process.argv.includes("--assert-release")) {
    const remote = decode(git("ls-remote", "--tags", "origin", `refs/tags/${ref}`, `refs/tags/${ref}^{}`))
    const rows = remote.split("\n").map((row) => row.split(/\s+/))
    const published = rows.find((row) => row[1] === `refs/tags/${ref}^{}`)?.[0] ?? rows.find((row) => row[1] === `refs/tags/${ref}`)?.[0]
    if (published !== revision) throw new Error("Published release tag does not equal the expected local immutable commit")
  }
  const goals = join(root, ".opencode/goals")
  const context = process.env.OCGOAL_CHECK_CONTEXT ? JSON.parse(process.env.OCGOAL_CHECK_CONTEXT) : undefined
  const sessionID = context?.sessionID ?? process.env.OPENCODE_SESSION_ID
  if (!sessionID) throw new Error("No actual goal-session binding; refusing an unscoped shared-service lookup")
  const states = readdirSync(goals, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => {
    const path = join(goals, d.name, "run.json")
    if (!existsSync(path)) return []
    const state = JSON.parse(readFileSync(path, "utf8"))
    return state.sessionID === sessionID && (!context || state.slug === context.slug && state.runId === context.runId) ? [state] : []
  }).filter((s) => !["complete", "aborted", "superseded", "failed"].includes(s.status))
  if (states.length !== 1) throw new Error(`Expected one bound active/stopped goal, got ${states.length}`)
  const state = states[0]
  const proof = join(goals, state.slug, "evidence", state.runId, "engine-provenance.json")
  if (!existsSync(proof)) throw new Error("The actual serving engine has not recorded provenance; call goal_provenance or run host verification")
  const actual: RuntimeProvenance = JSON.parse(readFileSync(proof, "utf8"))
  if (!ancestors().has(actual.serverPID)) throw new Error(`Provenance server PID ${actual.serverPID} is not this check's serving ancestor`)
  const names = decode(git("ls-tree", "-r", "--name-only", revision)).split("\n").filter(isArtifactPath)
  const artifacts = Object.fromEntries(names.map((path) => [path, hashArtifact(git("show", `${revision}:${path}`))]))
  const errors = artifactDiscrepancies(actual, {
    revision, artifacts, sessionID, runId: state.runId, lock: state.lock,
    serverPID: context?.serverPID ?? actual.serverPID, minVersion,
  })
  if (realpathSync(actual.location) !== root) errors.push("runtime location differs from the goal project")
  // The files have not been changed after their loaded-byte capture either.
  const disk = captureArtifactHashes(actual.packageRoot)
  if (JSON.stringify(disk) !== JSON.stringify(actual.artifacts)) errors.push("installed artifact bytes changed after setup")
  if (errors.length) throw new Error(errors.join("\n"))
  console.log(JSON.stringify({ ok: true, ref, revision, version: actual.packageVersion, serverPID: actual.serverPID, sessionID, runId: state.runId, artifactRoot: actual.packageRoot, artifacts: actual.artifacts }))
} catch (error) {
  console.error(`INSTALL PROOF FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
