// v0.5.0 — the goal→CLEO evidence bridge as a terminal/CI command.
//
// It uses the SAME shipped module (src/engine/cleo-bridge.ts) that the engine's
// `/goal cleo sync` and the automatic at-completion path use, so there is one
// implementation and one honesty rule: an AC is bound only where explicitly
// declared, an unprovable AC stays open and is reported, and a CLEO refusal is
// never turned into a fabricated closure.
//
// Usage:
//   bun scripts/cleo-sync.ts --dry-run T080 T081 T082
//   bun scripts/cleo-sync.ts \
//     --commit T080=c0f6c13 --commit T081=c0f6c13 --commit T082=c0f6c13 \
//     --acs '{"T080":{"testsPassed":["AC1"]}}' \
//     T080 T081 T082
//
// Every CLEO interaction is the `cleo` CLI; this script never opens .cleo.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { bridgeReport, deriveChangeSet, junitToVitestJson, planEvidence, runBridge, type CleoGate, type CleoRun, type Git } from "../src/engine/cleo-bridge"

const argv = process.argv.slice(2)
const value = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}
const every = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]!] : []))
const root = value("--root") ?? process.cwd()
const dryRun = argv.includes("--dry-run")
const tasks = argv.filter((a) => /^[A-Z]{1,4}\d+$/.test(a))
const commitByTask: Record<string, string> = {}
for (const pair of every("--commit")) {
  const [id, sha] = pair.split("=")
  if (id && sha) commitByTask[id] = sha
}
const acsMap: Record<string, Partial<Record<CleoGate, string[]>>> = JSON.parse(value("--acs") ?? "{}")
if (!tasks.length) {
  console.error("usage: bun scripts/cleo-sync.ts [--dry-run] [--commit T123=sha] [--acs <json>] [--root <dir>] T123 [T124 …]")
  process.exit(2)
}

const git: Git = async (args) => {
  const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" })
  const [out] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return out
}

const runCleo: CleoRun = async (args) => {
  const child = Bun.spawn(["cleo", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" })
  const timer = setTimeout(() => child.kill(), 180_000)
  const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited])
  clearTimeout(timer)
  return { stdout, exit: Number(exit) }
}

const report = async (testFiles: string[]) => {
  if (!testFiles.length) return undefined
  const dir = join(root, ".tmp", "cleo-reports")
  mkdirSync(dir, { recursive: true })
  const stamp = String(Date.now())
  const xml = join(dir, `bun-${stamp}.xml`)
  const json = join(dir, `report-${stamp}.json`)
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
  const shell = process.env.SHELL && process.env.SHELL.startsWith("/") ? process.env.SHELL : "/bin/sh"
  const child = Bun.spawn([shell, "-lc", `bun test ${testFiles.map(quote).join(" ")} --reporter=junit --reporter-outfile=${quote(xml)}`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, CI: process.env.CI ?? "1" },
  })
  await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  let parsed
  try { parsed = junitToVitestJson(readFileSync(xml, "utf8"), Date.now()) } catch { return undefined }
  writeFileSync(json, JSON.stringify(parsed, null, 2))
  return { reportPath: relative(root, json), passed: parsed.success, total: parsed.numTotalTests, failed: parsed.numFailedTests }
}

/** CLEO's own AC map for a task: which aliases still need a binding, which are typed. */
async function acState(task: string): Promise<{ acs: string[]; typedAcs: string[]; runTyped: boolean }> {
  const response = await runCleo(["done", task, "--plan"])
  const parsed = JSON.parse(response.stdout.slice(response.stdout.indexOf("{")))
  const mapping: Array<{ alias: string; mapped: boolean }> = parsed?.data?.acMapping ?? []
  const typed: Array<{ alias: string; status?: string }> = parsed?.data?.typedGates ?? []
  return { acs: mapping.filter((a) => !a.mapped).map((a) => a.alias), typedAcs: typed.map((g) => g.alias), runTyped: typed.some((g) => g.status !== "pass") }
}

if (dryRun) {
  for (const task of tasks) {
    const { acs, typedAcs, runTyped } = await acState(task)
    const changeSet = await deriveChangeSet(task, git, commitByTask[task])
    const plan = planEvidence({ task, acs, typedAcs, runTyped, acsByGate: acsMap[task], changeSet, reportPath: changeSet.testFiles.length ? "<scoped-report.json>" : undefined })
    console.log(JSON.stringify({ task, commit: changeSet.commit ?? null, testFiles: changeSet.testFiles.length, needsAcs: acs, typedAcs, runTyped, openAcs: plan.openAcs, blocker: plan.blocker ?? null, steps: plan.steps.map((s) => s.argv.join(" ")) }, null, 2))
  }
} else {
  const links = new Map(tasks.map((t) => [t, { id: t, ...(acsMap[t] ? { acs: acsMap[t]! } : {}) }] as const))
  const outcomes = await runBridge({ tasks, links, runCleo, git, report, commitByTask })
  console.log(bridgeReport(outcomes))
  process.exit(outcomes.every((o) => o.completed) ? 0 : 1)
}
