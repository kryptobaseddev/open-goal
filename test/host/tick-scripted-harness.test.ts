import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initialRun } from "../../src/engine/state"
import { parseContract } from "../../src/contract/parse"

// v0.7.0 - the proof that matters: a SCRIPTED HARNESS drives a real goal from
// kickoff to `complete` using ONLY the `ocg` bin, with no OpenCode anywhere. The
// scripted agent performs the goal's side effect and claims through OCG's own
// CLI, exactly as an agent in another harness would; every tick goes through the
// real process boundary, so what this proves is the shipped behaviour.

const BIN = join(import.meta.dir, "..", "..", "cli", "ocg.ts")
// The published bin is dist/cli.js on plain Node; drive the same goal through it.
const DIST = join(import.meta.dir, "..", "..", "dist", "cli.js")
const RUNNERS: Array<[string, string[]]> = [["bun source", ["bun", BIN]], ...(Bun.which("node") ? ([["node dist/cli.js", ["node", DIST]]] as Array<[string, string[]]>) : [])]
let runner: string[] = RUNNERS[0]![1]
const SLUG = "driven"
// A goal whose verification is HOST-ONLY, so the tick can finish it without the
// adapter's verifier child.
const GOAL = `schema: goal/v1
id: ${SLUG}
title: a goal driven by another harness
intent:
  verbatim: "make proof.txt exist"
outcome: proof.txt exists and states the status
non_goals: [Touching anything else]
criteria:
  - id: C1
    statement: proof.txt SHALL exist
    check: {kind: file, path: proof.txt}
  - id: C2
    statement: proof.txt SHALL contain the marker
    check: {kind: contains, path: proof.txt, text: "status: ok"}
verification: {mode: host}
`

const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...(process.env as Record<string, string>), GIT_AUTHOR_NAME: "harness", GIT_AUTHOR_EMAIL: "h@test.invalid", GIT_COMMITTER_NAME: "harness", GIT_COMMITTER_EMAIL: "h@test.invalid" },
  })

async function ocg(root: string, args: string[], stdin = "") {
  const proc = Bun.spawn([...runner, ...args], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  proc.stdin.write(stdin)
  await proc.stdin.end()
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code: Number(code) }
}

/** A real project with a goal, committed so the fingerprint has a base. */
function project(): { root: string; ledger: () => any[]; run: () => any } {
  const root = mkdtempSync(join(tmpdir(), "ocg-drive-"))
  dirs.push(root)
  const goalDir = join(root, ".opencode", "goals", SLUG)
  mkdirSync(goalDir, { recursive: true })
  writeFileSync(join(goalDir, "goal.yaml"), GOAL)
  writeFileSync(join(root, "README.md"), "# scripted harness project\n")
  git(root, "init", "-q", "-b", "main")
  git(root, "add", ".")
  git(root, "commit", "-q", "-m", "chore: seed")
  const rev = git(root, "rev-parse", "HEAD").stdout.toString().trim()
  const contract = parseContract(GOAL, { slug: SLUG }).contract!
  // The run's lock is the REAL sha256 of goal.yaml: the host re-checks it at
  // verification, and a fabricated lock is (correctly) an integrity failure.
  const lock = parseContract(GOAL, { slug: SLUG }).lock
  const state = initialRun(contract, { sessionID: "ses_harness", runId: "run1", lock, commit: rev, now: 1_000 })
  writeFileSync(join(goalDir, "run.json"), JSON.stringify(state, null, 2))
  return {
    root,
    ledger: () =>
      readFileSync(join(goalDir, "ledger.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    run: () => JSON.parse(readFileSync(join(goalDir, "run.json"), "utf8")),
  }
}

describe.each(RUNNERS)("a scripted harness drives a goal to complete through ocg tick alone (v0.7.0, %s)", (_name, cmd) => {
  beforeAll(() => {
    runner = cmd
  })
  test("kickoff -> the agent's work and claim -> verified complete, driven only by the bin", async () => {
    const p = project()
    const stopPayload = JSON.stringify({ hook_event_name: "Stop", session_id: "ses_harness", cwd: p.root })

    // ── 1. the harness's first Stop: the tick records the turn and says continue.
    const first = await ocg(p.root, ["tick"], stopPayload)
    expect(first.code).toBe(0)
    const firstOut = JSON.parse(first.stdout) // throws if stdout is not pure JSON
    expect(firstOut.decision).toBe("block")
    expect(typeof firstOut.reason).toBe("string")
    expect(p.run().turn).toBe(1)
    expect(p.ledger().filter((e) => e.type === "turn")).toHaveLength(1)

    // ── 2. the SCRIPTED AGENT does the goal's work (no OpenCode involved).
    writeFileSync(join(p.root, "proof.txt"), "status: ok\n")

    // ── 3. the scripted agent claims through OCG's own CLI.
    const claim = await ocg(p.root, ["claim", "--summary", "wrote proof.txt", "--evidence", "C1=proof.txt exists", "--evidence", "C2=status: ok"])
    expect(claim.code).toBe(0)
    expect(JSON.parse(claim.stdout)).toMatchObject({ ok: true, slug: SLUG })

    // ── 4. the next Stop verifies the claim and finishes the goal.
    const second = await ocg(p.root, ["tick"], stopPayload)
    expect(second.code).toBe(0)
    expect(second.stdout).toBe("") // no live goal remains: the session may end
    const final = p.run()
    expect(final.status).toBe("complete")
    expect(final.turn).toBe(2) // one turn per tick, advanced by the tick itself
    expect(final.criteria.C1.status).toBe("pass")
    expect(final.criteria.C2.status).toBe("pass")
    expect(final.verdict.passed).toBe(true)
    expect(final.claim).toBeUndefined() // the claim was consumed by the verification

    const events = p.ledger().map((e) => e.type)
    expect(events.filter((t) => t === "turn")).toHaveLength(2)
    expect(events).toContain("claim")
    expect(events).toContain("verify-start")
    expect(events).toContain("complete")

    // ── 5. a further Stop finds no live goal at all.
    const third = await ocg(p.root, ["tick"], stopPayload)
    expect(third.stdout).toBe("")
    expect(third.code).toBe(0)
  })

  test("the turns it records are the same shape the adapter records, and it states what it could not see", async () => {
    const p = project()
    await ocg(p.root, ["tick"], "")
    const turns = p.ledger().filter((e) => e.type === "turn")
    expect(turns).toHaveLength(1)
    // the fields the adapter's turn event carries
    expect(turns[0]).toMatchObject({ turn: 1, kind: "tick", changed: true, progress: true, noProgress: 0, activity: false, tools: 0 })
    // and the honest gap is visible: no payload, so the tool calls were not seen
    const run = p.run()
    expect(run.turnFacts).toMatchObject({ tools: 0, progressRecorded: false })
  })
})
