// T107: a repeatable stress command for the protected host suite.
//
// The host's own verify run of these files failed once ("a launch choice cannot
// approve contract bytes changed after the displayed review") and passed on
// three identical re-runs. This script runs the SAME command shape the host
// uses, with deliberate, recorded concurrency, and writes a machine-readable
// per-round outcome plus the retained host logs of any failing round.
//
// It never edits a protected file and never re-implements the tests: the real
// runner over the real files is the measurement. Heavy work still goes through
// `cleo run --wait --class test`, so the machine-wide budget governs it.
//
//   bun scripts/stress-host-suite.ts --runs 3 --concurrency 3 --report /dev/stdout
//   bun scripts/stress-host-suite.ts --runs 5 --concurrency 3 --require-clean
//
// Exit code: 0 when every requested round completed and its artifacts were
// written (a failing test round is still a completed round, reported honestly);
// 1 on a harness error (cleo could not run, junit missing), on --require-clean
// with any failing round, or on --assert-artifacts when an artifact is missing.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, copyFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { basename, join } from "node:path"
import { tmpdir } from "node:os"

/** The protected suite the host verifies with (I1 of the goal contracts). */
export const PROTECTED_SUITE = [
  "test/host/divergent-contract-recovery.test.ts",
  "test/host/goal-launch-flow.test.ts",
  "test/host/target-bound-decisions.test.ts",
  "test/host/composer-amendment.test.ts",
  "test/host/owner-chat-launch.test.ts",
  "test/host/amendment-resume-prerequisite.test.ts",
  // The run that failed also carried these two; keep the same shape.
  "test/host/verifier-diagnostics.test.ts",
  "test/host/autonomy-policy.test.ts",
] as const

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--") ? process.argv[i + 1]! : fallback
}
const flag = (name: string) => process.argv.includes(name)

const runs = Number(arg("--runs", "1"))
const concurrency = Number(arg("--concurrency", "3"))
const report = arg("--report")
const assertArtifacts = flag("--assert-artifacts")
const requireClean = flag("--require-clean")
if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer")
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("--concurrency must be 1..16 (bun --parallel worker processes)")

const root = process.cwd()
const flakeDir = join(root, ".tmp", "verification", "flake")
// Every run gets its own stamp directory: a later stress run must never
// overwrite the artifacts that document an earlier failure.
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const outDir = join(flakeDir, stamp)
mkdirSync(outDir, { recursive: true })

type Round = {
  run: number
  startedAt: string
  finishedAt: string
  durationMs: number
  exitCode: number
  status: "pass" | "fail" | "harness-error"
  failedTests: string[]
  totalTests: number
  junit?: string
  junitSha256?: string
  hostLogs: string[]
  outputTail: string[]
}

const hostsNow = () => new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("ocgoal-host-")).map((name) => join(tmpdir(), name)))
const decode = (text: string) => text.replace(/&#10;/g, "\n").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

/** bun writes junit; a missing file is a harness error, never a silent pass. */
function readJunit(path: string) {
  if (!existsSync(path)) return undefined
  const xml = readFileSync(path, "utf8")
  // bun writes one <testcase ... name="..."> per test, self-closing when it
  // passed and wrapping <failure>/<error> when it failed. The name attribute
  // may carry HTML entities, so it is decoded for the report.
  const open = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]*)"[^>]*?(\/>|>)/g)]
  const failed: string[] = []
  let total = 0
  for (let i = 0; i < open.length; i++) {
    total++
    const match = open[i]!
    if (match[2] === "/>") continue
    const body = xml.slice(match.index! + match[0].length, open[i + 1]?.index ?? xml.length)
    if (/<failure|<error/.test(body)) failed.push(decode(match[1]!))
  }
  return { xml, total, failed }
}

const rounds: Round[] = []
for (let run = 1; run <= runs; run++) {
  const before = hostsNow()
  const junitPath = join(outDir, `round-${run}-junit.xml`)
  const command = [
    "cleo", "run", "--wait", "--class", "test", "--",
    "bun", "test", ...PROTECTED_SUITE,
    `--parallel=${concurrency}`,
    "--reporter=junit", `--reporter-outfile=${junitPath}`,
  ]
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const child = Bun.spawnSync(command, { cwd: root, env: { ...process.env, KEEP_HOST: "1" }, stdout: "pipe", stderr: "pipe", timeout: 3600_000 })
  const durationMs = Date.now() - started
  const stdout = child.stdout?.toString() ?? ""
  const stderr = child.stderr?.toString() ?? ""
  const tail = [...stdout.split("\n").slice(-40), ...stderr.split("\n").slice(-20)].filter(Boolean)

  // Retain the host logs of this round; the harness only keeps them under
  // KEEP_HOST, and only a failure needs them as evidence.
  const created = [...hostsNow()].filter((dir) => !before.has(dir))
  const junit = readJunit(junitPath)
  const failed = junit?.failed ?? []
  const status: Round["status"] = !junit ? "harness-error" : failed.length ? "fail" : "pass"
  const hostLogs: string[] = []
  if (status !== "pass") {
    for (const dir of created) {
      for (const name of ["server.log"]) {
        const path = join(dir, name)
        if (!existsSync(path)) continue
        const kept = join(outDir, `round-${run}-${basename(dir)}-${name}`)
        copyFileSync(path, kept)
        hostLogs.push(kept)
      }
    }
  }
  for (const dir of created) rmSync(dir, { recursive: true, force: true })

  rounds.push({
    run, startedAt, finishedAt: new Date().toISOString(), durationMs,
    exitCode: child.exitCode ?? -1, status, failedTests: failed, totalTests: junit?.total ?? 0,
    ...(existsSync(junitPath) ? { junit: junitPath, junitSha256: sha256(junitPath) } : {}),
    hostLogs, outputTail: tail,
  })
  console.error(`[stress] round ${run}/${runs}: ${status} (${failed.join(", ") || "no failures"}) in ${(durationMs / 1000).toFixed(1)}s`)
}

const summary = {
  schema: "opencode-goal/stress-suite/v1",
  at: new Date().toISOString(),
  stamp,
  suite: PROTECTED_SUITE,
  runs, concurrency,
  runner: "cleo run --wait --class test -- bun test <protected suite> --parallel=<concurrency>",
  protectNote: "no protected file is edited by this script",
  rounds,
  passed: rounds.filter((r) => r.status === "pass").length,
  failed: rounds.filter((r) => r.status === "fail").length,
  harnessErrors: rounds.filter((r) => r.status === "harness-error").length,
}
const summaryPath = join(outDir, "results.json")
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
// A convenience copy of the NEWEST run only; the stamp directory above keeps
// every run's own artifacts intact.
writeFileSync(join(flakeDir, "results.json"), `${JSON.stringify({ ...summary, stampedResults: summaryPath }, null, 2)}\n`)
if (report) writeFileSync(report, `${JSON.stringify(summary, null, 2)}\n`)

let missing: string[] = []
if (assertArtifacts) {
  const required = [summaryPath, ...rounds.flatMap((r) => [r.junit, ...r.hostLogs])].filter(Boolean) as string[]
  missing = required.filter((path) => !existsSync(path) || statSync(path).size === 0)
}
if (missing.length) {
  console.error(`[stress] missing artifacts: ${missing.join(", ")}`)
  process.exit(1)
}
if (summary.harnessErrors) {
  console.error(`[stress] ${summary.harnessErrors} round(s) failed to run; see ${summaryPath}`)
  process.exit(1)
}
if (requireClean && summary.failed) {
  console.error(`[stress] ${summary.failed}/${runs} round(s) had failing tests; see ${summaryPath}`)
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, runs, concurrency, passed: summary.passed, failed: summary.failed, harnessErrors: 0, results: summaryPath }))
