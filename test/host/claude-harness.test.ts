import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initialRun, type RunState } from "../../src/engine/state"
import { parseContract } from "../../src/contract/parse"

// v0.10.0 (adapter-seam C3) — a REAL Claude project, driven only by CLEO.
//
// This is the proof the seam exists for: the goal runtime is not a plugin in the
// harness, and the harness is not OpenCode. A fresh project is initialized with
// the real `cleo` CLI, `cleo goal install --harness claude` installs the
// project-level Stop dispatcher (`.claude/settings.local.json`), and the hook
// command Claude Code would run is executed with a real Stop payload on stdin.
// CLEO's dispatcher then spawns `cleo-goal tick`, the tick declares the harness
// from `CLEO_HOOK_PROVIDER`, and a host-only goal reaches a verified `complete`.
//
// Nothing is stubbed at the harness boundary: the CLI, the dispatcher and the
// tick are the installed processes. The tick's limits are part of the proof —
// no forms, no verifier child, no tools, so the agent claims through `ocg claim`
// and every criterion is a host check.

const REPO = join(import.meta.dir, "..", "..")
// The SHIPPED artifact, not the source: CLEO resolves `cleo-goal` on PATH.
const DIST = join(REPO, "dist", "cli.js")
const CLEO = Bun.which("cleo")
const SLUG = "claude-proof"

const GOAL = `schema: goal/v1
id: ${SLUG}
title: a host-only goal in a Claude project
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

type Reply = { code: number; stdout: string; stderr: string }

function spawn(cmd: string[], cwd: string, env: Record<string, string>, stdin = ""): Reply {
  const proc = Bun.spawnSync(cmd, { cwd, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe", env })
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

/** The hook command Claude Code runs for a Stop, read from the installed settings. */
function stopHook(root: string): string {
  const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.local.json"), "utf8")) as {
    hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> }
  }
  const commands = (settings.hooks?.Stop ?? []).flatMap((group) => group.hooks ?? []).flatMap((h) => (h.command ? [h.command] : []))
  const dispatcher = commands.find((c) => c.includes("cleo hook stop") && c.includes("--provider claude-code"))
  if (!dispatcher) throw new Error(`no Claude Stop dispatcher in .claude/settings.local.json (found: ${commands.join(" | ")})`)
  return dispatcher
}

describe.skipIf(!CLEO || !existsSync(DIST))("a real Claude project completes a host-only goal through CLEO's Stop dispatcher (C3)", () => {
  test("install -> Stop -> continue -> claim -> Stop -> verified complete, and status reports harness claude", async () => {
    // ── 1. a REAL project: git, a README, and CLEO's own project workspace.
    const root = mkdtempSync(join(tmpdir(), "ocg-claude-"))
    dirs.push(root)
    writeFileSync(join(root, "README.md"), "# a Claude project\n")
    const bin = join(root, "bin")
    mkdirSync(bin, { recursive: true })
    symlinkSync(DIST, join(bin, "cleo-goal"))
    symlinkSync(DIST, join(bin, "ocg"))
    const env = {
      ...(process.env as Record<string, string>),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GIT_AUTHOR_NAME: "claude",
      GIT_AUTHOR_EMAIL: "claude@test.invalid",
      GIT_COMMITTER_NAME: "claude",
      GIT_COMMITTER_EMAIL: "claude@test.invalid",
      // The dispatcher's ask-enforce probe is not what this proves, and a session
      // end must never change the outcome of the goal tick.
      CLEO_ASK_ENFORCE: "off",
    }
    expect(spawn(["git", "init", "-q", "-b", "main"], root, env).code).toBe(0)
    expect(spawn(["git", "add", "."], root, env).code).toBe(0)
    expect(spawn(["git", "commit", "-q", "-m", "chore: seed"], root, env).code).toBe(0)
    const init = spawn([CLEO!, "init", "--name", "claude-proof"], root, env)
    expect(init.code).toBe(0)
    expect(existsSync(join(root, ".cleo", "config.json"))).toBe(true)

    // ── 2. install: remove the Stop dispatcher `cleo init` leaves behind, so the
    // goal install has to put it back. Only the project-level file is touched.
    const settingsPath = join(root, ".claude", "settings.local.json")
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks?: Record<string, unknown> }
    delete settings.hooks?.Stop
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    const install = spawn([CLEO!, "goal", "install", "--harness", "claude"], root, env)
    expect(install.code).toBe(0)
    const installed = JSON.parse(install.stdout) as {
      success: boolean
      data: { harness: string; delivery: { provider: string; status: string; target: string } }
    }
    expect(installed.success).toBe(true)
    expect(installed.data.harness).toBe("claude")
    expect(installed.data.delivery.provider).toBe("claude-code")
    expect(installed.data.delivery.status).toBe("installed")
    expect(realpathSync(installed.data.delivery.target)).toBe(realpathSync(settingsPath))
    const hook = stopHook(root) // throws if the dispatcher is not installed
    expect(hook).toContain("cleo-hook") // CLEO's marker, so a later install can find it

    // ── 3. a host-only goal, with a run bound to the Claude session.
    const goalDir = join(root, ".opencode", "goals", SLUG)
    mkdirSync(goalDir, { recursive: true })
    writeFileSync(join(goalDir, "goal.yaml"), GOAL)
    const parsed = parseContract(GOAL, { slug: SLUG })
    const contract = parsed.contract!
    const commit = spawn(["git", "rev-parse", "HEAD"], root, env).stdout.trim()
    const state: RunState = initialRun(contract, { sessionID: "ses_claude", runId: "run1", lock: parsed.lock, commit, now: 1_000 })
    writeFileSync(join(goalDir, "run.json"), JSON.stringify(state, null, 2))
    const run = () => JSON.parse(readFileSync(join(goalDir, "run.json"), "utf8")) as RunState

    // A real Claude Stop payload. `harness: "codex"` is a claim the payload makes
    // about itself and must never rename the run: identity is the dispatcher's.
    const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "ses_claude", cwd: root, harness: "codex" })
    const stopByDispatcher = () => spawn(["/bin/sh", "-c", hook], root, env, stop)

    // ── 4. first Stop: the dispatcher runs the tick, which continues the turn.
    const first = stopByDispatcher()
    expect(first.code).toBe(0)
    const answer = JSON.parse(first.stdout) as { decision?: string; reason?: string }
    expect(answer.decision).toBe("block")
    expect(answer.reason).toContain(`goal_status turn="1"`)
    expect(run().turn).toBe(1)
    // The dispatcher declared the harness; the payload did not.
    expect(run().harness).toEqual({ name: "claude", version: null, capabilities: null })
    const ledger = readFileSync(join(goalDir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(ledger.find((e) => e.type === "harness")).toMatchObject({ name: "claude", source: "tick", capabilities: null })

    // ── 5. the agent does the goal's work and claims through the CLI (the tick
    // path has no OCG tools; claiming is the agent-side surface).
    writeFileSync(join(root, "proof.txt"), "status: ok\n")
    const claim = spawn([join(bin, "ocg"), "claim", "--summary", "wrote proof.txt", "--evidence", "C1=proof.txt exists", "--evidence", "C2=status: ok"], root, env)
    expect(claim.code).toBe(0)
    expect(JSON.parse(claim.stdout)).toMatchObject({ ok: true, slug: SLUG })

    // ── 6. second Stop: the tick verifies every host criterion and finishes. The
    // empty answer is what lets the harness session end.
    const second = stopByDispatcher()
    expect(second.code).toBe(0)
    expect(second.stdout).toBe("")
    const final = run()
    expect(final.status).toBe("complete")
    expect(final.turn).toBe(2)
    expect(final.criteria.C1?.status).toBe("pass")
    expect(final.criteria.C2?.status).toBe("pass")
    expect(final.verdict?.passed).toBe(true)

    // ── 7. the read contract CLEO parses reports the producer, twice over:
    // OCG's own status and CLEO's `goal status` (which shells out to it).
    const status = spawn([join(bin, "ocg"), "status", "--json"], root, env)
    expect(status.code).toBe(0)
    const reported = JSON.parse(status.stdout) as { status: string; harness?: { name: string; version: string | null; capabilities: string[] | null } }
    expect(reported.status).toBe("complete")
    expect(reported.harness).toEqual({ name: "claude", version: null, capabilities: null })
    const cleoStatus = spawn([CLEO!, "goal", "status", "--json"], root, env)
    expect(cleoStatus.code).toBe(0)
    const cleoLive = JSON.parse(cleoStatus.stdout) as { data: { live: { status: string; harness?: { name: string } } } }
    expect(cleoLive.data.live.status).toBe("complete")
    expect(cleoLive.data.live.harness?.name).toBe("claude")
  }, 180000)
})

// Same file, no CLEO: the proof cannot be constructed. Say so loudly instead of
// pretending an unrelated suite proves it.
if (!CLEO) console.warn("claude-harness: skipped — the `cleo` CLI is not on PATH, and C3 needs CLEO's real Stop dispatcher")
if (!existsSync(DIST)) console.warn(`claude-harness: skipped — ${DIST} is missing; run \`bun run build:cli\``)
