// v0.5.2 - the export-to-T102 coherence check (goal criterion C5).
//
// T102 is "done" exactly when the release's dogfood export records the MANAGER
// flow as a pass. This script fails when the two disagree in either direction:
// a task closed while the manager did not pass would be a closure on a
// technicality, and a manager pass with the task still open would be an
// unrecorded result. It reads the export and asks the `cleo` CLI - it never
// writes to CLEO and never reads `.cleo/*.db`.
//
//   bun scripts/dogfood-t102-coherence.ts [--slug T102] [--export <file>]
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { exportPaths, type DogfoodExport } from "../src/engine/dogfood-record"

const argv = process.argv.slice(2)
const argOf = (name: string, fallback: string) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : (argv[i + 1] ?? fallback)
}
const task = argOf("--slug", "T102")
const root = process.cwd()
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string
const revision = Bun.spawnSync(["git", "rev-parse", `v${version}^{commit}`], { cwd: root, stdout: "pipe" }).stdout.toString().trim()
const exportFile = argOf("--export", join(root, exportPaths(version, revision).index))

let exp: DogfoodExport
try {
  exp = JSON.parse(readFileSync(exportFile, "utf8"))
} catch (error) {
  console.error(`cannot read the export at ${exportFile}: ${String(error)}`)
  process.exit(1)
}
const manager = exp.flows.find((f) => f.flow === "manager")
if (!manager) {
  console.error("the export has no manager flow record; nothing to compare against the task")
  process.exit(1)
}

const status = Bun.spawnSync(["cleo", "show", task, "--quiet", "--field", "/data/task/status"], { cwd: root, stdout: "pipe", stderr: "pipe" })
if (status.exitCode !== 0) {
  console.error(`cleo could not report ${task}'s status: ${status.stderr.toString().slice(0, 200)}`)
  process.exit(1)
}
const taskStatus = status.stdout.toString().trim()
const managerPass = manager.label === "pass"

console.log(`export: ${exportFile}`)
console.log(`manager flow: ${manager.label} - ${manager.labelReason.slice(0, 160)}`)
console.log(`cleo ${task}: ${taskStatus}`)

const taskDone = taskStatus === "done"
if (managerPass && !taskDone) {
  console.error(`INCOHERENT: the manager flow passed on real evidence, but ${task} is ${taskStatus}. Close it through the bridge, or record why it cannot be closed.`)
  process.exit(1)
}
if (!managerPass && taskDone) {
  console.error(`INCOHERENT: ${task} is done, but the manager flow is recorded as ${manager.label}. A task must not be closed when its proof did not pass.`)
  process.exit(1)
}
console.log(`coherent: ${task} is ${taskStatus} and the manager flow is ${manager.label}${taskDone ? " (closed on a real pass)" : " (left open on an honest " + manager.label + ")"}`)
