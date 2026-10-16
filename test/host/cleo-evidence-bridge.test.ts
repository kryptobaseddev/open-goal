import { describe, expect, test } from "bun:test"
import {
  acsByGateFromProves,
  cleoRefusal,
  deriveChangeSet,
  executePlan,
  junitToVitestJson,
  planEvidence,
  runBridge,
  sha256Hex,
  suggestLinkedTasks,
  type CleoRun,
} from "../../src/engine/cleo-bridge"

// v0.5.0 — the goal→CLEO evidence bridge. These are the honesty guarantees the
// CLEO maintainer asked for (mbx 01M530W19PFBY97GZ8QRYC7FVJ):
//   * an AC is attached ONLY to the gate whose evidence proves it — never
//     spread across gates by position;
//   * an AC no evidence proves stays OPEN and is reported, so the task is not
//     completed on a fabricated linkage;
//   * a refusal from CLEO is reported verbatim and stops that task;
//   * several tasks are processed independently — one refusal fakes nothing for
//     the others.

const JUNIT = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="test/a.test.ts" tests="2" failures="0" errors="0" skipped="0">
    <testcase name="one" classname="a"></testcase>
    <testcase name="two" classname="a"></testcase>
  </testsuite>
  <testsuite name="test/b.test.ts" tests="1" failures="1" errors="0" skipped="0">
    <testcase name="three" classname="b"><failure message="boom">x</failure></testcase>
  </testsuite>
</testsuites>`

const gitOf = (map: Record<string, string>) => async (args: string[]) => {
  const key = args.join(" ")
  return map[key] ?? ""
}

describe("the goal→CLEO evidence bridge (v0.5.0)", () => {
  test("junitToVitestJson is a faithful transform of a real run", () => {
    const report = junitToVitestJson(JUNIT, 123)
    expect(report.numTotalTests).toBe(3)
    expect(report.numPassedTests).toBe(2)
    expect(report.numFailedTests).toBe(1)
    expect(report.success).toBe(false)
    expect(report.startTime).toBe(123)
    expect(report.testResults.map((r) => r.status)).toEqual(["passed", "failed"])
    expect(report.testResults[1]!.assertionResults[0]).toEqual({ status: "failed", fullName: "three" })
  })

  test("an AC is bound only where the caller DECLARES it; an undeclared AC stays open", () => {
    const plan = planEvidence({
      task: "T081",
      acs: ["AC2", "AC3", "AC4"],
      typedAcs: ["AC5"],
      acsByGate: { testsPassed: ["AC2", "AC3"], qaPassed: ["AC4"] },
      changeSet: { commit: "abc123", files: ["src/a.ts", "test/a.test.ts"], testFiles: ["test/a.test.ts"] },
      reportPath: ".opencode/cleo-reports/report-1.json",
    })
    expect(plan.openAcs).toEqual([]) // AC5 is covered by the task's own typed gate
    const byGate = Object.fromEntries(plan.steps.map((s) => [s.gate, s]))
    // implemented was NOT declared here → no implemented step is invented
    expect(byGate.implemented).toBeUndefined()
    expect(byGate.testsPassed!.argv).toEqual(["verify", "T081", "--gate", "testsPassed", "--evidence", "test-run:.opencode/cleo-reports/report-1.json;satisfies:T081#AC2;satisfies:T081#AC3"])
    expect(byGate.qaPassed!.argv[5]).toBe("tool:typecheck;satisfies:T081#AC4")
  })

  test("an AC no gate can prove is reported open, and the task is never completed", async () => {
    const plan = planEvidence({
      task: "T081",
      acs: ["AC2", "AC3", "AC4"],
      acsByGate: { testsPassed: ["AC2"] }, // AC3, AC4 left unclaimed on purpose
      changeSet: { commit: "abc", files: ["src/a.ts"], testFiles: [] },
      reportPath: ".opencode/cleo-reports/r.json",
    })
    expect(plan.openAcs).toEqual(["AC3", "AC4"])
    const calls: string[][] = []
    const run: CleoRun = async (argv) => {
      calls.push(argv)
      return { stdout: '{"success":true}', exit: 0 }
    }
    const outcome = await executePlan(plan, run)
    expect(outcome.completed).toBe(false)
    expect(outcome.blocker).toContain("AC3, AC4")
    // only the declared verify ran; `complete` was NEVER called
    expect(calls.map((c) => c[0])).toEqual(["verify"])
  })

  test("a gate with no evidence to point at refuses instead of inventing one", async () => {
    const noChange = planEvidence({ task: "T080", acs: [], acsByGate: { implemented: ["AC1"] } })
    expect(noChange.blocker).toContain("no change-set")
    const noReport = planEvidence({
      task: "T080",
      acs: ["AC1"],
      acsByGate: { testsPassed: ["AC1"] },
      changeSet: { commit: "abc", files: ["src/a.ts"], testFiles: ["test/a.test.ts"] },
    })
    expect(noReport.blocker).toContain("no scoped test report")
  })

  test("a CLEO refusal is reported verbatim and stops the task (no complete)", async () => {
    const plan = planEvidence({
      task: "T080",
      acs: ["AC1"],
      acsByGate: { testsPassed: ["AC1"] },
      changeSet: { commit: "abc", files: ["src/a.ts"], testFiles: ["test/a.test.ts"] },
      reportPath: "r.json",
    })
    const calls: string[][] = []
    const run: CleoRun = async (argv) => {
      calls.push(argv)
      return { stdout: '{"success":false,"error":{"message":"testsPassed rests on a stale tree"}}', exit: 1 }
    }
    const outcome = await executePlan(plan, run)
    expect(outcome.completed).toBe(false)
    expect(outcome.blocker).toBe("cleo verify refused: testsPassed rests on a stale tree")
    expect(calls.map((c) => c[0])).toEqual(["verify"])
    expect(cleoRefusal("not json at all")).toBe("not json at all")
  })

  test("the happy path runs the declared gates and completes LAST", async () => {
    const plan = planEvidence({
      task: "T080",
      acs: ["AC1"],
      acsByGate: { implemented: ["AC1"], testsPassed: ["AC1"], qaPassed: ["AC1"] },
      changeSet: { commit: "abc", files: ["src/a.ts", "test/a.test.ts"], testFiles: ["test/a.test.ts"] },
      reportPath: "r.json",
    })
    const calls: string[][] = []
    const run: CleoRun = async (argv) => {
      calls.push(argv)
      return { stdout: '{"success":true}', exit: 0 }
    }
    const outcome = await executePlan(plan, run)
    expect(outcome.completed).toBe(true)
    expect(calls.map((c) => c[0])).toEqual(["verify", "verify", "verify", "complete"])
    expect(calls.at(-1)).toEqual(["complete", "T080"])
  })

  test("a typed REQ gate is executed before the write, because its pass must be cached first", () => {
    const plan = planEvidence({ task: "T081", acs: ["AC2"], typedAcs: ["AC5"], runTyped: true, acsByGate: { testsPassed: ["AC2"] }, changeSet: { commit: "c", files: ["f"], testFiles: [] }, reportPath: "r.json" })
    expect(plan.steps[0]!.argv).toEqual(["verify", "T081", "--run"])
    expect(plan.openAcs).toEqual([])
  })

  test("two tasks are independent: one completes, the other reports its own blocker", async () => {
    const run: CleoRun = async (argv) => {
      const task = argv[1]
      if (argv[0] === "complete" && task === "T999") return { stdout: '{"success":false,"error":{"message":"T999 failed verification gates"}}', exit: 1 }
      return { stdout: '{"success":true}', exit: 0 }
    }
    const ok = await executePlan(planEvidence({ task: "T080", acs: ["AC1"], acsByGate: { qaPassed: ["AC1"] } }), run)
    const bad = await executePlan(planEvidence({ task: "T999", acs: ["AC1"], acsByGate: { qaPassed: ["AC1"] } }), run)
    expect(ok.completed).toBe(true)
    expect(bad.completed).toBe(false)
    expect(bad.blocker).toContain("T999 failed verification gates")
  })

  test("deriveChangeSet uses the referencing commit and git show; an explicit commit wins", async () => {
    const git = gitOf({
      "log --all --format=%H --grep T081": "deadbeef\ncafef00d",
      "show --name-only --format= deadbeef": "src/engine/a.ts\ntest/host/a.test.ts\nREADME.md",
      "show --name-only --format= facefeed": "test/unit/only.test.ts",
    })
    expect(await deriveChangeSet("T081", git)).toEqual({ commit: "deadbeef", files: ["src/engine/a.ts", "test/host/a.test.ts", "README.md"], testFiles: ["test/host/a.test.ts"] })
    expect(await deriveChangeSet("T080", git, "facefeed")).toEqual({ commit: "facefeed", files: ["test/unit/only.test.ts"], testFiles: ["test/unit/only.test.ts"] })
    expect(await deriveChangeSet("T999", gitOf({}))).toEqual({ files: [], testFiles: [] })
  })

  test("suggestLinkedTasks reads the project's type(T###) commit convention", () => {
    expect(suggestLinkedTasks(["feat(T081): integrate", "docs(T081): record", "fix(T090): ship readable", "chore: no task"]).sort()).toEqual(["T081", "T090"])
    expect(suggestLinkedTasks(["chore: release v0.4.9"])).toEqual([])
  })

  test("proves maps each AC to the gate whose evidence demonstrates it — by check kind, never by position", () => {
    const map = acsByGateFromProves(
      [
        { check: { kind: "command", run: "bun test test/host/amend.test.ts" }, proves: ["T081#AC2", "T081#AC3"] },
        { check: { kind: "command", run: "bun run typecheck" }, proves: ["T081#AC4"] },
        { check: { kind: "file", path: "src/x.ts" }, proves: ["T081#AC1"] },
        { check: { kind: "command", run: "bun test other.test.ts" }, proves: ["T082#AC2"] },
      ],
      "T081",
    )
    expect(map).toEqual({ testsPassed: ["AC2", "AC3"], qaPassed: ["AC4"], implemented: ["AC1"] })
    // A diff check is a guard that passes when paths are UNCHANGED, and a
    // verifier/human verdict alone never satisfies implemented or testsPassed:
    // those ACs stay OPEN (agreed with the CLEO maintainer).
    expect(
      acsByGateFromProves(
        [
          { check: { kind: "diff", paths: ["src"] }, proves: ["T081#AC5"] },
          { check: { kind: "verifier", ask: "x?" }, proves: ["T081#AC6"] },
          { check: { kind: "human", ask: "y?" }, proves: ["T081#AC7"] },
        ],
        "T081",
      ),
    ).toEqual({})
    expect(acsByGateFromProves([], "T081")).toEqual({})
  })

  test("runBridge binds the scoped report's sha256 to the outcome, and refuses a red report", async () => {
    const run: CleoRun = async (argv) => {
      if (argv[0] === "done") return { stdout: JSON.stringify({ data: { acMapping: [{ alias: "AC1", mapped: false }], typedGates: [] } }), exit: 0 }
      return { stdout: '{"success":true}', exit: 0 }
    }
    const git = gitOf({ "log --all --format=%H --grep T500": "abc", "show --name-only --format= abc": "src/a.ts\ntest/a.test.ts", "status --porcelain": "" })
    const links = new Map([["T500", { id: "T500", acs: { testsPassed: ["AC1"] } }]])
    const report = { reportPath: ".opencode/cleo-reports/r.json", reportSha256: sha256Hex("{}"), passed: true, total: 1, failed: 0 }
    const ok = await runBridge({ tasks: ["T500"], links, runCleo: run, git, report: async () => report })
    expect(ok[0]!.completed).toBe(true)
    // the outcome carries the report sha256 BESIDE its path (the GoalOutcome emitter's input)
    expect(ok[0]!.report).toEqual({ path: report.reportPath, sha256: report.reportSha256 })
    const red = await runBridge({ tasks: ["T500"], links, runCleo: run, git, report: async () => ({ ...report, passed: false, failed: 1 }) })
    expect(red[0]!.completed).toBe(false)
    expect(red[0]!.blocker).toContain("refusing to record testsPassed evidence on a red run")
    expect(sha256Hex("{}")).toHaveLength(64)
  })
})
