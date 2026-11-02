import { expect, test } from "bun:test"
import { parseContract } from "../../src/contract/parse"

// D7 — a contract must not encode the inverse of the owner's intent while
// validating cleanly. The guard is a WARNING: a contract that parses today keeps
// parsing, but a stop rule phrased as "SHALL NOT continue past X" is named at
// review time so the contradiction cannot pass silently.

const base = (stop: string) => `schema: goal/v1
id: demo
title: demo
intent:
  verbatim: "x"
outcome: y
non_goals: [z]
criteria:
  - id: C1
    statement: s
    check: {kind: file, path: f}
${stop}`

test("an inverse-intent stop rule warns, names the rule, and does not reject the contract", () => {
  const parsed = parseContract(base('stop:\n  when: "The run SHALL NOT continue past a first visit to a new project"\n  escalate_when: []\n'), { slug: "demo" })
  expect(parsed.contract).toBeDefined()
  expect(parsed.issues.some((i) => i.level === "error")).toBe(false)
  const warning = parsed.issues.find((i) => i.level === "warning" && i.path === "stop.when")
  expect(warning).toBeDefined()
  expect(warning!.message).toContain("inverse of continuing")
  expect(warning!.message).toContain("SHALL NOT continue past")
})

test("an inverse-intent escalation rule warns on its own path", () => {
  const parsed = parseContract(base('stop:\n  escalate_when:\n    - "Do not continue past an exhausted budget"\n'), { slug: "demo" })
  expect(parsed.contract).toBeDefined()
  const warning = parsed.issues.find((i) => i.level === "warning" && i.path === "stop.escalate_when[0]")
  expect(warning?.message).toContain("inverse of continuing")
})

test("positively phrased stop and escalation rules stay clean", () => {
  const parsed = parseContract(base('stop:\n  when: "The run SHALL continue past a backstop unless a blocker is recorded"\n  escalate_when:\n    - "The fix needs a backend API change"\n    - "A credential is missing"\n'), { slug: "demo" })
  expect(parsed.contract).toBeDefined()
  expect(parsed.issues.filter((i) => i.level === "warning" && i.path.startsWith("stop")).length).toBe(0)
})

test("the rule is a warning, never an error: the contract still parses with its stop text intact", () => {
  const text = 'stop:\n  when: "The run MUST NOT proceed past an exhausted budget"\n  escalate_when: []\n'
  const parsed = parseContract(base(text), { slug: "demo" })
  expect(parsed.contract?.stop.when).toBe("The run MUST NOT proceed past an exhausted budget")
  expect(parsed.issues.filter((i) => i.level === "error").length).toBe(0)
  expect(parsed.issues.filter((i) => i.level === "warning" && i.path === "stop.when").length).toBe(1)
})
