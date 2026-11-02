import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { parseContract } from "../../src/contract/parse"
import { initialRun, type RunState } from "../../src/engine/state"

// T150 C4 at the process boundary. `ocg migrate` is the only surface an owner
// actually runs, so these cases spawn the real bin: the dry run prints a plan
// and leaves the tree byte-identical, `--confirm` copies migratable goals and
// keeps the legacy folder, a live run is refused, and a broken
// `.cleo/goal-store.json` fails closed instead of guessing a target.

const BIN = join(import.meta.dir, "..", "..", "cli", "ocg.ts")
const dirs: string[] = []
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const contractText = (slug: string) => `schema: goal/v1\nid: ${slug}\ntitle: ${slug} goal\nintent:\n  verbatim: "x"\noutcome: y\nnon_goals: [z]\ncriteria:\n  - id: C1\n    statement: s\n    check: {kind: file, path: f}\n`

function addGoal(root: string, slug: string, status?: RunState["status"]) {
  const dir = join(root, ".opencode", "goals", slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "goal.yaml"), contractText(slug))
  writeFileSync(join(dir, "notes.md"), `# ${slug}\n`)
  if (status === undefined) return
  const parsed = parseContract(contractText(slug), { slug })
  const run = initialRun(parsed.contract!, { sessionID: `ses_${slug}`, runId: `r_${slug}`, lock: parsed.lock, now: 1000 })
  run.status = status
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`)
  writeFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ t: 1, type: "note" })}\n`)
}

function project(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `ocg-migrate-${name}-`))
  dirs.push(root)
  addGoal(root, "done", "complete")
  addGoal(root, "draft")
  addGoal(root, "live", "running")
  return root
}

/** Relative path → sha256 for every file under the project. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue
      const child = join(dir, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) out[relative(root, child)] = createHash("sha256").update(readFileSync(child)).digest("hex")
    }
  }
  visit(root)
  return out
}

async function runBin(root: string, args: string[]) {
  const proc = Bun.spawn(["bun", BIN, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code: Number(code) }
}

describe("the ocg migrate bin", () => {
  test("the dry run prints every goal and writes nothing", async () => {
    const root = project("dry")
    const before = snapshot(root)
    const { stdout, code } = await runBin(root, ["migrate"])
    expect(code).toBe(0)
    const plan = JSON.parse(stdout)
    expect(plan).toMatchObject({ schemaVersion: 1, dryRun: true, writes: 0 })
    expect(plan.goals.map((g: { slug: string }) => g.slug).sort()).toEqual(["done", "draft", "live"])
    expect(plan.goals.find((g: { slug: string }) => g.slug === "live").migratable).toBe(false)
    expect(snapshot(root)).toEqual(before)
    expect(existsSync(join(root, ".cleo", "goals"))).toBe(false)
  })

  test("--confirm copies migratable goals and keeps the legacy tree byte-identical", async () => {
    const root = project("confirm")
    const legacyBefore = snapshot(join(root, ".opencode", "goals"))
    const { stdout, code } = await runBin(root, ["migrate", "--confirm"])
    expect(code).toBe(0)
    const result = JSON.parse(stdout)
    expect(result).toMatchObject({ dryRun: false, legacyRetained: true, writes: 2 })
    expect(result.moved.map((g: { slug: string }) => g.slug).sort()).toEqual(["done", "draft"])
    expect(result.skipped.map((g: { slug: string }) => g.slug)).toEqual(["live"])

    // the copied bytes match the source exactly …
    for (const slug of ["done", "draft"]) {
      expect(snapshot(join(root, ".cleo", "goals", slug))).toEqual(snapshot(join(root, ".opencode", "goals", slug)))
    }
    // … the live run was not copied, and nothing legacy changed
    expect(existsSync(join(root, ".cleo", "goals", "live"))).toBe(false)
    expect(snapshot(join(root, ".opencode", "goals"))).toEqual(legacyBefore)
  })

  test("a migrated project then reads its goals and its own live run from both stores", async () => {
    const root = project("both")
    await runBin(root, ["migrate", "--confirm"])
    const { stdout, code } = await runBin(root, ["status", "--json"])
    expect(code).toBe(0)
    // the live run still reports from the legacy store after the move
    expect(JSON.parse(stdout)).toMatchObject({ goal: "live", status: "running" })
  })

  test("a broken .cleo/goal-store.json fails closed with a message on stderr", async () => {
    const root = project("bad-config")
    mkdirSync(join(root, ".cleo"), { recursive: true })
    writeFileSync(join(root, ".cleo", "goal-store.json"), "{not json")
    const before = snapshot(root)
    const { stdout, stderr, code } = await runBin(root, ["migrate", "--confirm"])
    expect(code).toBe(1)
    expect(stdout).toBe("")
    expect(stderr).toContain(".cleo/goal-store.json")
    expect(snapshot(root)).toEqual(before)
  })
})
