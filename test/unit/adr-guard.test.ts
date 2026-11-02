import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ADR_DECISIONS_PATH, type AdrDecision, adrContradiction, loadAdrDecisions, parseAdrDecisions } from "../../src/contract/adr-guard"
import { parseContract } from "../../src/contract/parse"
import { compileSources, decisionFromSource, renderProjection } from "../../scripts/adr-guard"

// T180 — owner-approved contract memory. A goal must not silently contradict a
// decision the owner already accepted. The check is advisory: a contradiction is
// a WARNING naming the ADR and the contradicting statement, the contract is never
// rewritten, and with no projection the parse is byte-identical to today's.
//
// The fixture below is reduced from the live accepted ADR
// `adr-001-goal-store-root-surface` (cleo docs fetch adr-001-goal-store-root-surface).

const ADR_001: AdrDecision = {
  slug: "adr-001-goal-store-root-surface",
  status: "accepted",
  subject: "goal store",
  statement: "New runs are created under .cleo/goals",
  forbidden: ["created under .opencode/goals"],
}

const goal = (outcome: string, stop = 'stop:\n  when: "The run SHALL continue past a backstop unless a blocker is recorded"\n  escalate_when: []\n') => `schema: goal/v1
id: demo
title: demo
intent:
  verbatim: "make the store decision stand"
outcome: "${outcome}"
non_goals: [z]
criteria:
  - id: C1
    statement: "the store root is recorded"
    check: {kind: file, path: f}
${stop}`

const adrWarnings = (parsed: ReturnType<typeof parseContract>) =>
  parsed.issues.filter((i) => i.level === "warning" && i.message.includes("contradicts accepted ADR"))

const roots: string[] = []
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "ocgoal-adr-guard-"))
  roots.push(root)
  return root
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("a contract that matches the ADR", () => {
  test("parses with no new warning (AC1)", () => {
    // The outcome repeats the accepted decision: no forbidden phrase, no negation flip.
    const parsed = parseContract(goal("New runs are created under .cleo/goals for every project"), { slug: "demo", decisions: [ADR_001] })
    expect(parsed.contract).toBeDefined()
    expect(parsed.contract?.outcome).toBe("New runs are created under .cleo/goals for every project")
    expect(parsed.issues.some((i) => i.level === "error")).toBe(false)
    expect(adrWarnings(parsed)).toEqual([])
    // And the rest of validation is exactly what it was: the baseline warnings, no more.
    const baseline = parseContract(goal("New runs are created under .cleo/goals for every project"), { slug: "demo", decisions: [] })
    expect(parsed.issues).toEqual(baseline.issues)
  })

  test("plenty of ordinary contracts never trip the guard", () => {
    const parsed = parseContract(goal("The goal store lists runs from both roots"), { slug: "demo", decisions: [ADR_001] })
    expect(parsed.contract).toBeDefined()
    expect(adrWarnings(parsed)).toEqual([])
  })
})

describe("a contract that contradicts the ADR", () => {
  test("warns exactly once, names the ADR and the statement, and never rewrites the contract", () => {
    const outcome = "The goal store is rebuilt: new runs are created under .opencode/goals"
    const parsed = parseContract(goal(outcome), { slug: "demo", decisions: [ADR_001] })
    const warnings = adrWarnings(parsed)
    expect(warnings.length).toBe(1)
    expect(warnings[0]!.level).toBe("warning")
    expect(warnings[0]!.path).toBe("outcome")
    expect(warnings[0]!.message).toContain("adr-001-goal-store-root-surface")
    expect(warnings[0]!.message).toContain("New runs are created under .cleo/goals")
    expect(warnings[0]!.message).toContain("created under .opencode/goals")
    expect(warnings[0]!.message).toContain("the contract is not rewritten")
    // A warning, never an error: the contract still parses, byte for byte.
    expect(parsed.contract).toBeDefined()
    expect(parsed.contract?.outcome).toBe(outcome)
    expect(parsed.issues.some((i) => i.level === "error")).toBe(false)
  })

  test("the negation flip catches an opposite stop rule and points at its own path", () => {
    const stop = 'stop:\n  when: "New runs are not created under the goal store root"\n  escalate_when:\n    - "New runs are never created under the goal store root"\n'
    const parsed = parseContract(goal("The goal store decision is recorded", stop), { slug: "demo", decisions: [ADR_001] })
    expect(parsed.contract).toBeDefined()
    const warnings = adrWarnings(parsed)
    expect(warnings.map((w) => w.path)).toEqual(["stop.when", "stop.escalate_when[0]"])
    for (const warning of warnings) expect(warning.message).toContain("adr-001-goal-store-root-surface")
    expect(parsed.contract?.stop.when).toBe("New runs are not created under the goal store root")
  })
})

describe("false-positive guards (no projection, no inference from prose)", () => {
  const silent = (text: string, decisions: readonly AdrDecision[] = [ADR_001]) => {
    const parsed = parseContract(text, { slug: "demo", decisions })
    expect(parsed.contract).toBeDefined()
    expect(adrWarnings(parsed)).toEqual([])
  }

  test("the subject is not named", () => {
    silent(goal("New runs are not created under the plugin settings root"))
    silent(goal("New runs are not created under the legacy root"), [{ ...ADR_001, subject: "goal store" }])
  })

  test("a two-word overlap is not evidence of the same statement", () => {
    // "release is" is shared, but that is ordinary English, not a contradiction.
    silent(goal("This release is not blocked by a missing credential"), [
      { slug: "adr-002-release-ancestry", status: "accepted", subject: "release", statement: "Every release is tagged from main", forbidden: [] },
    ])
  })

  test("a single shared word is not evidence either", () => {
    silent(goal("Token budget is not capped in the second half"), [
      { slug: "adr-003-budget", status: "accepted", subject: "budget", statement: "The budget is capped at 3M tokens", forbidden: [] },
    ])
  })

  test("same subject and same polarity stays silent even with a long overlap", () => {
    silent(goal("The goal store root is .cleo/goals, and new runs are created under .cleo/goals"), [
      { ...ADR_001, statement: "The goal store root is .cleo/goals" },
    ])
  })

  test("a subject list matches any of its explicit phrases", () => {
    const decision: AdrDecision = { ...ADR_001, subject: ["goal store", ".opencode/goals"] }
    const contradicted = parseContract(goal("New runs are created under .opencode/goals"), { slug: "demo", decisions: [decision] })
    expect(adrWarnings(contradicted).length).toBe(1)
    const quiet = parseContract(goal("New runs are created under .cleo/goals"), { slug: "demo", decisions: [decision] })
    expect(adrWarnings(quiet)).toEqual([])
  })

  test("a decision that is not accepted is not enforced", () => {
    expect(parseAdrDecisions({ version: 1, decisions: [{ ...ADR_001, status: "proposed" }] })).toEqual([])
    expect(parseAdrDecisions({ version: 1, decisions: [{ ...ADR_001, status: "superseded" }] })).toEqual([])
    silent(goal("New runs are created under .opencode/goals for every project"), [])
  })
})

describe("the projection is optional and advisory", () => {
  test("absent projection: validation is byte-identical to today", () => {
    const root = tempRoot()
    const text = goal("New runs are not created under the goal store root")
    const withRoot = parseContract(text, { slug: "demo", projectRoot: root })
    const baseline = parseContract(text, { slug: "demo", decisions: [] })
    expect(loadAdrDecisions(root)).toEqual([])
    expect(withRoot.issues).toEqual(baseline.issues)
    expect(withRoot.contract).toEqual(baseline.contract!)
    expect(withRoot.lock).toBe(baseline.lock)
  })

  test("a malformed projection is ignored, never an error", () => {
    const root = tempRoot()
    mkdirSync(dirname(join(root, ADR_DECISIONS_PATH)), { recursive: true })
    writeFileSync(join(root, ADR_DECISIONS_PATH), "{ not json")
    const text = goal("The goal store is rebuilt: new runs are created under .opencode/goals")
    expect(loadAdrDecisions(root)).toEqual([])
    const parsed = parseContract(text, { slug: "demo", projectRoot: root })
    expect(parsed.contract).toBeDefined()
    expect(parsed.issues.some((i) => i.level === "error")).toBe(false)
    expect(adrWarnings(parsed)).toEqual([])
  })

  test("an unreadable entry is skipped, not raised", () => {
    expect(parseAdrDecisions({ version: 1, decisions: [{ slug: "Bad Slug" }, { subject: "x" }, 42, null, ADR_001] })).toEqual([ADR_001])
    expect(parseAdrDecisions("nope")).toEqual([])
  })

  test("a projection on disk is read from the project root", () => {
    const root = tempRoot()
    mkdirSync(dirname(join(root, ADR_DECISIONS_PATH)), { recursive: true })
    writeFileSync(join(root, ADR_DECISIONS_PATH), renderProjection([ADR_001]))
    const parsed = parseContract(goal("The goal store is rebuilt: new runs are created under .opencode/goals"), { slug: "demo", projectRoot: root })
    expect(adrWarnings(parsed).length).toBe(1)
    // The same contract with the projection absent stays clean.
    const quiet = parseContract(goal("The goal store is rebuilt: new runs are created under .opencode/goals"), { slug: "demo", decisions: [] })
    expect(adrWarnings(quiet)).toEqual([])
  })

  test("an invalid regex in the projection is ignored", () => {
    const decision: AdrDecision = { ...ADR_001, forbidden: [{ regex: "([" }] }
    expect(adrContradiction("New runs are created under .cleo/goals in the goal store", decision)).toBeUndefined()
  })
})

describe("the checked-in projection (live ADR-001)", () => {
  const root = join(import.meta.dir, "..", "..")

  test("is fresh against its markdown source", () => {
    const script = join(root, "scripts", "adr-guard.ts")
    const checked = spawnSync(process.execPath, [script, "generate", "--check"], { cwd: root, encoding: "utf8" })
    expect(checked.stderr).toBe("")
    expect(checked.status).toBe(0)
  })

  test("matches the live accepted ADR: a matching goal is clean, a contradicting one warns once", () => {
    const decisions = loadAdrDecisions(root)
    expect(decisions.map((d) => d.slug)).toContain("adr-001-goal-store-root-surface")
    const matching = parseContract(goal("New runs under the goal store are created under .cleo/goals, and the legacy root stays readable"), {
      slug: "demo",
      projectRoot: root,
    })
    expect(adrWarnings(matching)).toEqual([])
    const contradicting = parseContract(goal("The goal store is rebuilt: new runs are created under .opencode/goals"), { slug: "demo", projectRoot: root })
    const warnings = adrWarnings(contradicting)
    expect(warnings.length).toBe(1)
    expect(warnings[0]!.message).toContain("adr-001-goal-store-root-surface")
    expect(contradicting.contract?.outcome).toBe("The goal store is rebuilt: new runs are created under .opencode/goals")
  })
})

describe("scripts/adr-guard.ts compiles the projection", () => {
  const source = (slug: string, extra = "") => `---
adr: ${slug}
status: accepted
subject: goal store
statement: New runs are created under .cleo/goals
${extra}---
# ${slug}

The body is prose for people; it projects to nothing.
`

  test("frontmatter compiles to a decision, deterministically", () => {
    const parsed = decisionFromSource("docs/adr/adr-001.md", source("adr-001-goal-store-root-surface", 'forbidden:\n  - "created under .opencode/goals"\n  - regex: "\\\\bnew runs? are created\\\\b"\n'))
    expect(parsed.error).toBeUndefined()
    expect(parsed.decision).toMatchObject({
      slug: "adr-001-goal-store-root-surface",
      status: "accepted",
      subject: "goal store",
      statement: "New runs are created under .cleo/goals",
      forbidden: ["created under .opencode/goals", { regex: "\\bnew runs? are created\\b" }],
    })
    const rendered = renderProjection([parsed.decision!])
    expect(JSON.parse(rendered)).toEqual({ version: 1, decisions: [parsed.decision!] })
    expect(renderProjection([parsed.decision!])).toBe(rendered)
  })

  test("a malformed source is a build error, not a silent drop", () => {
    expect(decisionFromSource("x.md", "# no frontmatter")!.error).toContain("no --- frontmatter")
    expect(decisionFromSource("x.md", "---\nadr: x\n---\n")!.error).toContain("subject")
    expect(decisionFromSource("x.md", "---\nadr: x\nsubject: s\nstatement: t\nforbidden:\n  - regex: \"([\"\n---\n")!.error).toContain("not a valid regular expression")
    const dupes = compileSources([
      { file: "a.md", text: source("adr-001-x") },
      { file: "b.md", text: source("adr-001-x") },
    ])
    expect(dupes.errors.join(" ")).toContain("duplicate ADR slug")
  })

  test("compile sorts by slug and projects only declared fields", () => {
    const compiled = compileSources([
      { file: "b.md", text: source("adr-002-b", 'forbidden:\n  - "nope"\n') },
      { file: "a.md", text: source("adr-001-a") },
    ])
    expect(compiled.errors).toEqual([])
    expect(compiled.decisions.map((d) => d.slug)).toEqual(["adr-001-a", "adr-002-b"])
    expect(JSON.parse(renderProjection(compiled.decisions)).decisions[1]).toEqual({
      slug: "adr-002-b",
      status: "accepted",
      subject: "goal store",
      statement: "New runs are created under .cleo/goals",
      forbidden: ["nope"],
    })
  })

  test("the CLI generates the projection, --check detects staleness, and check reports the warning", () => {
    const root = tempRoot()
    const script = join(import.meta.dir, "..", "..", "scripts", "adr-guard.ts")
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" })

    expect(run("generate").status).toBe(1) // no sources yet: says so instead of writing an empty projection
    mkdirSync(join(root, "docs/adr"), { recursive: true })
    writeFileSync(join(root, "docs/adr/adr-001-goal-store-root-surface.md"), source("adr-001-goal-store-root-surface", 'forbidden:\n  - "created under .opencode/goals"\n'))

    const generated = run("generate")
    expect(generated.status).toBe(0)
    expect(generated.stdout).toContain(ADR_DECISIONS_PATH)
    expect(readFileSync(join(root, ADR_DECISIONS_PATH), "utf8")).toContain("adr-001-goal-store-root-surface")
    expect(run("generate", "--check").status).toBe(0)

    // A changed source makes the projection stale until it is regenerated.
    writeFileSync(join(root, "docs/adr/adr-001-goal-store-root-surface.md"), source("adr-001-goal-store-root-surface"))
    expect(run("generate", "--check").status).toBe(1)
    writeFileSync(join(root, "docs/adr/adr-001-goal-store-root-surface.md"), source("adr-001-goal-store-root-surface", 'forbidden:\n  - "created under .opencode/goals"\n'))
    expect(run("generate").status).toBe(0)
    expect(run("generate", "--check").status).toBe(0)

    const goalFile = join(root, ".opencode/goals/demo/goal.yaml")
    mkdirSync(dirname(goalFile), { recursive: true })
    writeFileSync(goalFile, goal("The goal store is rebuilt: new runs are created under .opencode/goals"))
    const checked = run("check", ".opencode/goals/demo/goal.yaml")
    expect(checked.status).toBe(0) // a warning is not a failure
    expect(checked.stdout).toContain("contradicts accepted ADR")

    writeFileSync(goalFile, goal("The goal store is rebuilt: new runs are created under .cleo/goals"))
    const clean = run("check", ".opencode/goals/demo/goal.yaml")
    expect(clean.status).toBe(0)
    expect(clean.stdout).not.toContain("contradicts accepted ADR")
    expect(clean.stdout).toContain("goal.yaml is valid")
  })
})
