import type { Contract } from "../contract/types"
import type { RunState } from "./state"

/** Semantic equality, not YAML bytes or object-property order. Statements,
 * essentialness and invariant role are part of the oracle, not just its check. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}

export function amendmentDiff(prior: Contract, next: Contract) {
  const oracles = (contract: Contract) => new Map([
    ...contract.criteria.map((c) => [c.id, canonical({ ...c, invariant: false })] as const),
    ...contract.invariants.map((c) => [c.id, canonical({ ...c, invariant: true })] as const),
  ])
  const before = oracles(prior), after = oracles(next)
  const unchanged = [...after.keys()].filter((id) => before.get(id) === after.get(id))
  const changed = [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id))
  const added = [...after.keys()].filter((id) => !before.has(id))
  const removed = [...before.keys()].filter((id) => !after.has(id))
  const sections = (Object.keys(next) as Array<keyof Contract>).filter((key) => canonical(prior[key]) !== canonical(next[key]))
  const summary = [
    `outcome: ${prior.outcome === next.outcome ? "unchanged" : "CHANGED"}`,
    `criteria unchanged [${unchanged.join(", ") || "-"}] changed [${changed.join(", ") || "-"}] added [${added.join(", ") || "-"}] removed [${removed.join(", ") || "-"}]`,
    `sections changed [${sections.join(", ") || "-"}]`,
  ].join(" · ")
  const details = sections.map((section) => `${section}:\nBEFORE ${canonical(prior[section])}\nAFTER  ${canonical(next[section])}`).join("\n\n")
  return { unchanged, changed, added, removed, sections, summary, details }
}

export function amendedState(state: RunState, prior: Contract, next: Contract, lock: string, rationale: string, at = Date.now()): RunState {
  const result = structuredClone(state)
  const diff = amendmentDiff(prior, next)
  result.amendments = result.amendments.map((a) => a.status === "proposed" ? { ...a, status: "rejected", rationale: "replaced by accepted amendment" } : a)
  result.amendments.push({ change: diff.summary, rationale, at, status: "accepted" })
  result.lock = lock
  result.title = next.title
  if (next.priority) result.priority = next.priority
  else delete result.priority
  for (const id of diff.changed.concat(diff.added)) result.criteria[id] = { status: "unknown", rejections: 0 }
  for (const id of diff.removed) delete result.criteria[id]
  const previousSteps = new Map(prior.plan.map((s) => [s.id, canonical(s)]))
  result.steps = Object.fromEntries(next.plan.map((s) => [s.id, previousSteps.get(s.id) === canonical(s) ? result.steps[s.id] ?? "pending" : "pending"]))
  // An accepted generation is not a claim or a verdict, and is never an
  // implicit resume. The next explicit verification evaluates the new lock.
  delete result.claim
  delete result.verdict
  result.updatedAt = at
  return result
}
