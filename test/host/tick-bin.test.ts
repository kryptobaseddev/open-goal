import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initialRun, type RunState } from "../../src/engine/state"
import { parseContract } from "../../src/contract/parse"

// v0.6.0 - the REAL bin, end to end. CLEO's Stop dispatcher executes `ocg tick`
// with the harness Stop JSON on stdin and treats stdout as JSON ONLY. These tests
// spawn the actual CLI, so they prove the contract at the process boundary:
// stdout parses, logs went to stderr, and nothing is printed when no goal is live.

const BIN = join(import.meta.dir, "..", "..", "cli", "ocg.ts")
const SLUG = "demo"
const GOAL = `schema: goal/v1\nid: ${SLUG}\ntitle: demo goal\nintent:\n  verbatim: "x"\noutcome: y\nnon_goals: [z]\ncriteria:\n  - id: C1\n    statement: s\n    check: {kind: file, path: f}\n`

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const contract = parseContract(GOAL, { slug: SLUG }).contract!

function project(run?: Partial<RunState> | "no-run"): string {
  const root = mkdtempSync(join(tmpdir(), "ocg-tickbin-"))
  dirs.push(root)
  if (run === undefined) return root
  mkdirSync(join(root, ".opencode", "goals", SLUG), { recursive: true })
  writeFileSync(join(root, ".opencode", "goals", SLUG, "goal.yaml"), GOAL)
  if (run === "no-run") return root
  const base = initialRun(contract, { sessionID: "ses_x", runId: "r1", lock: "a".repeat(64), now: 1 })
  writeFileSync(join(root, ".opencode", "goals", SLUG, "run.json"), JSON.stringify({ ...base, ...run, counters: { noProgress: 0, failures: 0, ...(run.counters ?? {}) } }))
  return root
}

async function runBin(root: string, args: string[] = ["tick"], stdin = "") {
  const proc = Bun.spawn(["bun", BIN, ...args], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  proc.stdin.write(stdin)
  await proc.stdin.end()
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code: Number(code) }
}

describe("the ocg tick bin (v0.6.0)", () => {
  test("no goal project: NOTHING on stdout, logs on stderr, exit 0", async () => {
    const { stdout, stderr, code } = await runBin(project())
    expect(stdout).toBe("")
    expect(stderr).toContain("no .opencode/goals")
    expect(code).toBe(0)
  })

  test("a live goal: stdin JSON in, ONLY the contract JSON out", async () => {
    const { stdout, stderr, code } = await runBin(project({ status: "running", turn: 4 }), ["tick"], JSON.stringify({ hook_event_name: "Stop", session_id: "ses_other" }))
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout) // throws if stdout is not pure JSON
    expect(parsed.decision).toBe("block")
    expect(typeof parsed.reason).toBe("string")
    expect(parsed.reason.length).toBeGreaterThan(0)
    // the payload was acknowledged on stderr, never on stdout
    expect(stderr).toContain("Stop payload")
  })

  test("a terminal goal prints NOTHING (no live goal)", async () => {
    const { stdout, code } = await runBin(project({ status: "complete", turn: 5 }))
    expect(stdout).toBe("")
    expect(code).toBe(0)
  })

  test("a goal awaiting the owner holds the session: final false", async () => {
    const { stdout, code } = await runBin(project({ status: "needs_review", turn: 5 }))
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ final: false })
  })

  test("an unknown subcommand is a usage error on stderr with a non-zero exit", async () => {
    const { stdout, stderr, code } = await runBin(project(), ["bogus"])
    expect(stdout).toBe("")
    expect(stderr).toContain("usage: ocg tick")
    expect(code).toBe(2)
  })
})
