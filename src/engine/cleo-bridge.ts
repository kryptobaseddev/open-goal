// v0.5.0 — the goal→CLEO evidence bridge.
//
// Turns a goal's PROVEN work into genuine per-gate CLEO evidence and completes
// the linked tasks, THROUGH THE `cleo` CLI ONLY — the engine never opens `.cleo`
// or reads its database.
//
// Honesty rules (adopted from the CLEO maintainer, mbx 01M530W19PFBY97GZ8QRYC7FVJ):
//  1. An AC is attached to a gate ONLY when the evidence on that gate actually
//     demonstrates that AC. ACs are NEVER spread across gates by position — a
//     positional mapping fabricates linkage.
//  2. Several ACs may sit on one gate; a single AC may be proven by the goal.
//  3. An AC that no evidence proves stays OPEN and is reported as the exact
//     blocker. The task is then not completed.
//  4. Every refusal from CLEO is reported verbatim. A closure is never faked.
//
// The module is pure where it can be (planning, parsing, report conversion) so
// it is unit/host testable with injected `git` and `cleo` runners and no real
// CLI, and it is the same code the real `/goal cleo sync` path executes.

import { createHash } from "node:crypto"
import type { CleoGate } from "../contract/types"

export const CLEO_GATES: readonly CleoGate[] = ["implemented", "testsPassed", "qaPassed"]

/** A task's change-set: the commit that implemented it and the files it moved. */
export type ChangeSet = { commit?: string; files: string[]; testFiles: string[] }

export type CleoStep = { argv: string[]; gate?: CleoGate; acs: string[] }

export type EvidencePlan = {
  task: string
  steps: CleoStep[]
  /** ACs no evidence proves — left open and reported, never positionally bound. */
  openAcs: string[]
  /** Present when the task cannot even be attempted (no change-set, etc.). */
  blocker?: string
}

export type StepResult = { argv: string[]; exit: number; out: string }
export type TaskOutcome = {
  task: string
  completed: boolean
  steps: StepResult[]
  openAcs: string[]
  blocker?: string
  /** v0.5.1 - the scoped report this task's testsPassed evidence was bound to. */
  report?: { path: string; sha256: string }
}

export type CleoRun = (argv: string[]) => Promise<{ stdout: string; exit: number }>
export type Git = (args: string[]) => Promise<string>

/** The vitest-shaped JSON report CLEO's `test-run:` atom parses. */
export type VitestReport = {
  numTotalTests: number
  numPassedTests: number
  numFailedTests: number
  numPendingTests: number
  success: boolean
  startTime: number
  testResults: Array<{ name: string; status: "passed" | "failed"; assertionResults: Array<{ status: "passed" | "failed"; fullName: string }> }>
}

/**
 * Convert a real `bun test --reporter=junit` report into the vitest-shaped JSON
 * that `test-run:<json>` expects. A faithful transform: every count and status
 * comes from the actual run; nothing is invented. Pure.
 */
export function junitToVitestJson(xml: string, startTime: number): VitestReport {
  const num = (attrs: string, name: string) => {
    const m = new RegExp(`${name}="(\\d+)"`).exec(attrs)
    return m ? Number(m[1]) : 0
  }
  const testResults: VitestReport["testResults"] = []
  let total = 0, passed = 0, failed = 0, skipped = 0
  for (const suite of xml.matchAll(/<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g)) {
    const attrs = suite[1] ?? ""
    const body = suite[2] ?? ""
    const name = (/name="([^"]*)"/.exec(attrs) ?? [, "suite"])[1] as string
    const tests = num(attrs, "tests"), failures = num(attrs, "failures"), errors = num(attrs, "errors"), skips = num(attrs, "skipped")
    total += tests
    failed += failures + errors
    skipped += skips
    passed += Math.max(0, tests - failures - errors - skips)
    const assertionResults: VitestReport["testResults"][number]["assertionResults"] = []
    const caseRe = /<testcase\b([^>]*?)(\/?)>/g
    for (let c = caseRe.exec(body); c; c = caseRe.exec(body)) {
      const caseAttrs = c[1] ?? ""
      const fullName = (/name="([^"]*)"/.exec(caseAttrs) ?? [, name])[1] as string
      // A self-closing <testcase/> passes; otherwise look inside its body for a failure child.
      let bad = false
      if (c[2] !== "/") {
        const end = body.indexOf("</testcase>", caseRe.lastIndex)
        const inner = body.slice(c.index, end === -1 ? body.length : end)
        bad = /<failure\b|<error\b/.test(inner)
      }
      assertionResults.push({ status: bad ? "failed" : "passed", fullName })
    }
    testResults.push({ name, status: failures + errors ? "failed" : "passed", assertionResults })
  }
  // bun's junit may omit <testsuite> wrappers for some reporters; fall back to counting testcases.
  if (!testResults.length) {
    const cases = [...xml.matchAll(/<testcase\b[^>]*>/g)].length
    total = cases
    passed = cases
  }
  return { numTotalTests: total, numPassedTests: passed, numFailedTests: failed, numPendingTests: skipped, success: failed === 0, startTime, testResults }
}

/** The LAFS error message from a `cleo` refusal, else the raw tail. Pure. */
export function cleoRefusal(stdout: string): string {
  const text = stdout.trim()
  const start = text.indexOf("{")
  if (start !== -1) {
    try {
      const parsed = JSON.parse(text.slice(start))
      const message = parsed?.error?.message
      if (typeof message === "string" && message.trim()) return message.trim()
    } catch {
      // not JSON — fall through to the raw tail
    }
  }
  return text.split("\n").slice(-3).join(" ").slice(0, 500) || "cleo refused with no message"
}

/**
 * Build the exact `cleo verify` steps for a task from a DECLARED, non-positional
 * AC map. The caller declares which AC each gate's evidence proves; anything not
 * declared (and not backed by the task's own typed gate) is left open.
 */
export function planEvidence(input: {
  task: string
  /** The task's AC aliases that are not backed by a typed gate. */
  acs: string[]
  /** AC aliases backed by a typed gate — satisfied by `cleo verify <task> --run`. */
  typedAcs?: string[]
  /** True when the task's typed REQ gate has no cached pass yet. */
  runTyped?: boolean
  acsByGate?: Partial<Record<CleoGate, string[]>>
  changeSet?: ChangeSet
  reportPath?: string
}): EvidencePlan {
  const { task } = input
  const typed = new Set(input.typedAcs ?? [])
  const declared = new Set(CLEO_GATES.flatMap((g) => input.acsByGate?.[g] ?? []))
  const openAcs = input.acs.filter((ac) => !declared.has(ac) && !typed.has(ac))
  const steps: CleoStep[] = []
  let blocker: string | undefined
  // A typed REQ gate the write cannot link must be executed and cached first.
  if (input.runTyped) steps.push({ argv: ["verify", task, "--run"], acs: [] })

  const evidenceOf = (gate: CleoGate, acs: string[]): string | undefined => {
    const parts: string[] = []
    if (gate === "implemented") {
      if (!input.changeSet?.commit || !input.changeSet.files.length) return undefined
      parts.push(`commit:${input.changeSet.commit}`)
      parts.push(`files:${input.changeSet.files.join(",")}`)
    }
    if (gate === "testsPassed") {
      if (!input.reportPath) return undefined
      parts.push(`test-run:${input.reportPath}`)
    }
    if (gate === "qaPassed") parts.push("tool:typecheck")
    for (const ac of acs) parts.push(`satisfies:${task}#${ac}`)
    return parts.join(";")
  }

  for (const gate of CLEO_GATES) {
    const acs = input.acsByGate?.[gate] ?? []
    if (!acs.length) continue
    const evidence = evidenceOf(gate, acs)
    if (!evidence) {
      blocker ??= gate === "implemented" ? "no change-set (no commit or files) to record as implemented evidence" : "no scoped test report is available for the testsPassed gate"
      continue
    }
    steps.push({ argv: ["verify", task, "--gate", gate, "--evidence", evidence], gate, acs })
  }
  return { task, steps, openAcs, ...(blocker ? { blocker } : {}) }
}

/** Run a plan: the verify steps, then `cleo complete` only if no AC is open. */
export async function executePlan(plan: EvidencePlan, runCleo: CleoRun): Promise<TaskOutcome> {
  const steps: StepResult[] = []
  if (plan.blocker) return { task: plan.task, completed: false, steps, openAcs: plan.openAcs, blocker: plan.blocker }
  for (const step of plan.steps) {
    const { stdout, exit } = await runCleo(step.argv)
    steps.push({ argv: step.argv, exit, out: stdout })
    if (exit !== 0) return { task: plan.task, completed: false, steps, openAcs: plan.openAcs, blocker: `cleo ${step.argv[0]} refused: ${cleoRefusal(stdout)}` }
  }
  if (plan.openAcs.length)
    return { task: plan.task, completed: false, steps, openAcs: plan.openAcs, blocker: `${plan.openAcs.length} acceptance criterion/criteria have no evidence from this goal (left open, not positionally bound): ${plan.openAcs.join(", ")}` }
  const { stdout, exit } = await runCleo(["complete", plan.task])
  steps.push({ argv: ["complete", plan.task], exit, out: stdout })
  return { task: plan.task, completed: exit === 0, steps, openAcs: [], ...(exit === 0 ? {} : { blocker: `cleo complete refused: ${cleoRefusal(stdout)}` }) }
}

/**
 * Derive a task's change-set from the commits whose message references the task
 * id (the `type(T###): …` convention), or from an explicit commit for a legacy
 * task no commit names. The file list comes from `git show`, exactly like the
 * manual pass that defeated human hands.
 */
export async function deriveChangeSet(task: string, git: Git, explicitCommit?: string): Promise<ChangeSet> {
  let commit = explicitCommit?.trim()
  if (!commit) {
    const found = (await git(["log", "--all", "--format=%H", "--grep", task])).trim().split("\n").filter(Boolean)
    commit = found[0]
  }
  if (!commit) return { files: [], testFiles: [] }
  const isTest = (f: string) => /\.test\.[cm]?tsx?$/.test(f)
  const files = (await git(["show", "--name-only", "--format=", commit])).split("\n").map((s) => s.trim()).filter(Boolean)
  // CLEO binds a report to the TREE it ran on, so the change it judges is the
  // commit PLUS whatever the working tree changed. The report must therefore
  // also run the test files the working tree adds or edits, or CLEO refuses it.
  const working = (await git(["status", "--porcelain"]))
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((f) => f && isTest(f))
  return { commit, files, testFiles: [...new Set([...files.filter(isTest), ...working])] }
}

/** The CLEO task ids a set of commit subjects appears to reference (`type(T###): …`). */
export function suggestLinkedTasks(subjects: string[]): string[] {
  const found = new Set<string>()
  for (const subject of subjects) for (const m of subject.matchAll(/\(([A-Z]{1,4}\d+)\)/g)) found.add(m[1]!)
  return [...found].sort()
}

/**
 * Map a contract's per-criterion `proves: ["T123#AC2"]` bindings to the gate whose
 * evidence demonstrates each AC. The gate follows the criterion's OWN check, not
 * its position (agreed with the CLEO maintainer, mbx 01M532QTTHFWRWT62HEMK278M8):
 *
 *  - `command` running tests           → `testsPassed`
 *  - `command` running typecheck/lint  → `qaPassed` (CLEO records it through its own
 *                                        tool runner at head, never from our exit code)
 *  - `file` / `contains` / `absent`    → `implemented`
 *  - `diff`                            → NO gate: it passes when paths are UNCHANGED,
 *                                        so it is a guard that proves nothing was built
 *  - `verifier` / `human`              → NO gate: a verdict alone never satisfies
 *                                        implemented or testsPassed
 *
 * An AC whose criterion maps to no gate stays OPEN and is reported. Pure.
 */
export function acsByGateFromProves(
  criteria: ReadonlyArray<{ check: { kind: string; run?: string; [key: string]: unknown }; proves?: string[] }>,
  task: string,
): Partial<Record<CleoGate, string[]>> {
  const gateFor = (check: { kind: string; run?: string }): CleoGate | undefined => {
    if (check.kind === "command") return /\btypecheck\b|\blint\b/.test(String(check.run ?? "")) ? "qaPassed" : "testsPassed"
    if (check.kind === "file" || check.kind === "contains" || check.kind === "absent") return "implemented"
    return undefined
  }
  const map: Partial<Record<CleoGate, string[]>> = {}
  for (const criterion of criteria) {
    const gate = gateFor(criterion.check)
    if (!gate) continue
    for (const ref of criterion.proves ?? []) {
      const [refTask, ac] = ref.split("#")
      if (refTask !== task || !ac) continue
      map[gate] = [...(map[gate] ?? []), ac]
    }
  }
  return map
}

/** The sha256 of any bytes, hex. Used to bind a report to its exact content. */
export const sha256Hex = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

export type BridgeReport = {
  reportPath: string
  /** v0.5.1 - sha256 of the report BYTES, so CLEO can bind test-run: to them. */
  reportSha256: string
  passed: boolean
  total: number
  failed: number
}

/** Everything the bridge needs, injected so it is testable without a real CLI. */
export type BridgeInputs = {
  tasks: string[]
  links: ReadonlyMap<string, { id: string; acs?: Partial<Record<CleoGate, string[]>> }>
  runCleo: CleoRun
  git: Git
  /** Run the given test files and return a vitest-shaped report (undefined when none can be run). */
  report: (testFiles: string[]) => Promise<BridgeReport | undefined>
  /** A legacy task no commit message names may be given its implementing commit explicitly. */
  commitByTask?: Record<string, string>
}

/**
 * The whole bridge for a set of tasks, one per goal. Reads CLEO's OWN AC map,
 * derives each change-set, runs a scoped report, then records the DECLARED
 * per-gate evidence and completes — through the CLI only. Tasks are independent:
 * one refusal never fakes another, and a red report is never recorded as a pass.
 */
export async function runBridge(input: BridgeInputs): Promise<TaskOutcome[]> {
  const outcomes: TaskOutcome[] = []
  for (const task of input.tasks) {
    const planResponse = await input.runCleo(["done", task, "--plan"])
    let acs: string[] = [], typedAcs: string[] = [], runTyped = false
    try {
      const parsed = JSON.parse(planResponse.stdout.slice(planResponse.stdout.indexOf("{")))
      const mapping: Array<{ alias: string; mapped: boolean }> = parsed?.data?.acMapping ?? []
      acs = mapping.filter((a) => !a.mapped).map((a) => a.alias)
      const typed: Array<{ alias: string; status?: string }> = parsed?.data?.typedGates ?? []
      typedAcs = typed.map((g) => g.alias)
      runTyped = typed.some((g) => g.status !== "pass")
    } catch {
      outcomes.push({ task, completed: false, steps: [], openAcs: [], blocker: `cleo done --plan did not return a usable plan for ${task}: ${cleoRefusal(planResponse.stdout)}` })
      continue
    }
    const changeSet = await deriveChangeSet(task, input.git, input.commitByTask?.[task])
    const report = await input.report(changeSet.testFiles)
    const link = input.links.get(task)
    const declaredTests = link?.acs?.testsPassed?.length ?? 0
    if (report && !report.passed && declaredTests)
      outcomes.push({ task, completed: false, steps: [], openAcs: [], blocker: `the scoped report for ${task} did not pass (${report.failed}/${report.total} failed) — refusing to record testsPassed evidence on a red run` })
    else {
      const outcome = await executePlan(planEvidence({ task, acs, typedAcs, runTyped, acsByGate: link?.acs, changeSet, reportPath: report?.reportPath }), input.runCleo)
      if (report) outcome.report = { path: report.reportPath, sha256: report.reportSha256 }
      outcomes.push(outcome)
    }
  }
  return outcomes
}

/** Render outcomes honestly: what ran, and the exact blocker when it refused. */
export function bridgeReport(outcomes: TaskOutcome[]): string {
  return (
    outcomes
      .map((o) => {
        const head = o.completed ? `✓ ${o.task} completed through the CLEO CLI` : `✗ ${o.task} not completed`
        const ran = o.steps.map((s) => `  ran: cleo ${s.argv.join(" ")} → exit ${s.exit}`).join("\n")
        return [head, ran, o.blocker ? `  blocker: ${o.blocker}` : ""].filter(Boolean).join("\n")
      })
      .join("\n") || "No linked CLEO tasks."
  )
}
