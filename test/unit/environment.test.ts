import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { compareEnvironment, captureEnvironment, environmentLine } from "../../src/verify/environment"
import { parseContract } from "../../src/contract/parse"
import { initialRun } from "../../src/engine/state"
import { verifyClaim } from "../../src/verify/pipeline"

// The environment is context, not a criterion. A verdict must say when the
// package version, HEAD or the release tag moved since the last verdict, so a
// "pass" stamped on an older tree is never silently carried forward.

const fake = (map: Record<string, { status: number; stdout: string }>) => (args: string[]) => {
  const key = args.join(" ")
  for (const [prefix, value] of Object.entries(map)) if (key.startsWith(prefix)) return value
  return { status: 1, stdout: "" }
}

describe("environment snapshot", () => {
  test("captures the package version, HEAD and the release tag only when it resolves", () => {
    const git = fake({
      "rev-parse --verify HEAD": { status: 0, stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n" },
      "rev-parse --verify v": { status: 0, stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n" },
      "merge-base --is-ancestor": { status: 0, stdout: "" },
    })
    const snap = captureEnvironment(process.cwd(), 1000, git as never)
    expect(snap.at).toBe(1000)
    // Derive the expected version: the release job runs this file on the tag it is publishing.
    const expected = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")).version
    expect(snap.packageVersion).toBe(expected)
    expect(snap.head).toBe("a".repeat(40))
    expect(snap.tagCommit).toBe("b".repeat(40))
    expect(snap.tagOnHead).toBe(true)
  })

  test("a project without package.json or a tag still yields a snapshot", () => {
    const snap = captureEnvironment("/nonexistent-project", 1, fake({}) as never)
    expect(snap).toEqual({ at: 1 })
  })
})

describe("environment diff", () => {
  const base = { at: 1, packageVersion: "0.12.1", head: "a".repeat(40), tagCommit: "b".repeat(40), tagOnHead: true }

  test("nothing changed is not a line", () => {
    expect(compareEnvironment(base, { ...base, at: 2 })).toEqual({ changed: false, lines: [] })
    expect(environmentLine({ changed: false, lines: [] })).toEqual([])
  })

  test("a version bump is named with both sides", () => {
    const diff = compareEnvironment(base, { ...base, at: 2, packageVersion: "0.12.2" })
    expect(diff.changed).toBe(true)
    expect(diff.lines.join("\n")).toContain("package.json 0.12.1 → 0.12.2")
  })

  test("a HEAD move and a tag that leaves HEAD are named", () => {
    const diff = compareEnvironment(base, { ...base, at: 2, head: "c".repeat(40), tagOnHead: false })
    const text = diff.lines.join("\n")
    expect(text).toContain(`HEAD ${"a".repeat(7)} → ${"c".repeat(7)}`)
    expect(text).toContain("is not on HEAD")
  })

  test("the first verdict of a run never claims a change", () => {
    expect(compareEnvironment(undefined, base)).toEqual({ changed: false, lines: [] })
  })
})

test("a verdict carries the environment line ahead of every criterion line", async () => {
  const text = `schema: goal/v1
id: probe
title: probe
intent:
  verbatim: v
outcome: o
non_goals: [x]
verification: {mode: host}
criteria:
  - id: C1
    statement: s
    essential: true
    check: {kind: command, run: "exit 0"}
`
  const parsed = parseContract(text, { slug: "probe" })
  expect(parsed.contract).not.toBeNull()
  const state = initialRun(parsed.contract!, { sessionID: "sess1", runId: "run1", lock: parsed.lock })
  state.lock = parsed.lock
  const outcome = await verifyClaim(parsed.contract!, state, {
    root: process.cwd(),
    contractText: text,
    environment: ["ENVIRONMENT changed since the last verdict: package.json 0.12.1 → 0.12.2"],
    shell: (() => ({ exit: 0, stdout: "", stderr: "", timedOut: false, ms: 1 })) as never,
  })
  expect(outcome.passed).toBe(true)
  expect(outcome.lines[0]).toBe("ENVIRONMENT changed since the last verdict: package.json 0.12.1 → 0.12.2")
})
