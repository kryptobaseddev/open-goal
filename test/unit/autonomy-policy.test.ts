import { describe, expect, test } from "bun:test"
import { parseContract } from "../../src/contract/parse"
import { classifyChange, policyAllows } from "../../src/engine/policy"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const base = readFileSync(join(import.meta.dir, "..", "fixtures", "valid.goal.yaml"), "utf8")
const parse = (text: string) => {
  const r = parseContract(text, { slug: parseContract(base).contract!.id })
  if (!r.contract) throw new Error(JSON.stringify(r.issues))
  return r.contract
}

describe("owner-set autonomy policy", () => {
  test("parses amend classes and verifier read paths; rejects unknown classes and globs", () => {
    const ok = parseContract(`${base}\n`.replace(/^autonomy:.*$/m, "") + "verification: {read: [../sibling]}\n")
    expect(ok.contract?.verification.read).toEqual(["../sibling"])
    const bad = parseContract(base.replace(/^verification:.*$/m, "") + "autonomy: {amend: [criteria]}\nverification: {read: [\"../*\"]}\n")
    expect(bad.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["autonomy.amend", "verification.read"]))
  })

  test("only the listed classes are agent-applicable; criteria and the policy itself never are", () => {
    const prior = parse(base)
    const budget = { ...prior, budget: { ...prior.budget, turns: (prior.budget.turns ?? 1) + 5 } }
    expect(classifyChange(prior, budget)).toEqual({ classes: ["budget"], blocked: [] })
    expect(policyAllows(["budget"], classifyChange(prior, budget)).ok).toBe(true)
    expect(policyAllows([], classifyChange(prior, budget)).ok).toBe(false)
    expect(policyAllows(["plan"], classifyChange(prior, budget)).ok).toBe(false)

    const statement = { ...prior, criteria: prior.criteria.map((c, i) => (i === 0 ? { ...c, statement: `${c.statement} (weaker)` } : c)) }
    expect(policyAllows(["timeout", "budget", "plan", "recover"], classifyChange(prior, statement)).ok).toBe(false)

    const policy = { ...prior, autonomy: { ...prior.autonomy, amend: ["timeout" as const] } }
    expect(classifyChange(prior, policy).blocked.join()).toContain("autonomy policy")

    const scope = { ...prior, scope: { in: [...prior.scope.in, "everything"], out: prior.scope.out } }
    expect(classifyChange(prior, scope).blocked).toContain("scope changed")
    expect(policyAllows(["budget"], classifyChange(prior, budget), true).ok).toBe(false)
  })
})
