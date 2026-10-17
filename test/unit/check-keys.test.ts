import { expect, test } from "bun:test"
import { parseContract } from "../../src/contract/parse"

// v0.8.0 D6 — a check key the engine does not implement is a validation error,
// never silently dropped. `stderr_contains` used to collapse the criterion to
// bare `expect: {exit: 0}`: a check that passes while proving nothing.

const goal = (expectBlock: string) => `schema: goal/v1
id: strict-keys
title: Strict check keys
intent: {verbatim: prove the key is executed}
outcome: the check runs exactly as written
non_goals: [other files]
criteria:
  - id: C1
    statement: the command passes
    check: {kind: command, run: "true", expect: ${expectBlock}}
`

test("an unknown expectation key is an error naming the key", () => {
  const parsed = parseContract(goal(`{stderr_contains: "x"}`), { slug: "strict-keys" })
  expect(parsed.contract).toBeUndefined()
  const issue = parsed.issues.find((i) => i.path.includes("expect.stderr_contains"))
  expect(issue?.level).toBe("error")
  expect(issue?.message).toContain("stderr_contains")
  expect(issue?.message).toContain("stdout_contains")
})

test("a typo in a supported key is not silently ignored", () => {
  const parsed = parseContract(goal(`{stdout_contains_text: "x"}`), { slug: "strict-keys" })
  expect(parsed.contract).toBeUndefined()
  expect(parsed.issues.some((i) => i.path.includes("stdout_contains_text") && i.level === "error")).toBe(true)
})

test("the supported keys still parse and keep their meaning", () => {
  const parsed = parseContract(goal(`{exit: 0, stdout_contains: "ok", stdout_regex: "^ok$"}`), { slug: "strict-keys" })
  expect(parsed.contract).toBeDefined()
  expect(parsed.contract!.criteria[0]!.check).toEqual({ kind: "command", run: "true", expect: { exit: 0, stdout_contains: "ok", stdout_regex: "^ok$" } })
})

test("an omitted expect still defaults to exit 0 (documented behaviour, not a dropped key)", () => {
  const parsed = parseContract(goal("{}"), { slug: "strict-keys" })
  expect(parsed.contract!.criteria[0]!.check).toEqual({ kind: "command", run: "true", expect: { exit: 0 } })
})
