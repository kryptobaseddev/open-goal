// Owner-set autonomy policy. The OWNER lists change classes in the launched
// contract (autonomy.amend); the agent may apply a change itself only when
// every difference falls inside those classes. Criteria statements, checks
// (other than their timeout), roles, protect, scope, verification, stop
// rules and the policy itself are never agent-applicable.
import type { AmendClass, Contract, Criterion } from "../contract/types"
import { canonical } from "./amendment"

export type ChangeClassification = { classes: AmendClass[]; blocked: string[] }

const withoutTimeout = (c: Criterion) => ({ ...c, check: { ...c.check, timeout: undefined } })

export function classifyChange(prior: Contract, next: Contract): ChangeClassification {
  const classes = new Set<AmendClass>()
  const blocked: string[] = []
  for (const key of ["criteria", "invariants"] as const) {
    const a = prior[key], b = next[key]
    if (a.length !== b.length || a.some((c, i) => c.id !== b[i]!.id)) { blocked.push(`${key} added, removed or reordered`); continue }
    a.forEach((c, i) => {
      const d = b[i]!
      if (canonical(c) === canonical(d)) return
      if (canonical(withoutTimeout(c)) === canonical(withoutTimeout(d))) classes.add("timeout")
      else blocked.push(`${c.id} statement, check or role changed`)
    })
  }
  if (canonical(prior.budget) !== canonical(next.budget)) classes.add("budget")
  if (canonical(prior.plan) !== canonical(next.plan) || canonical(prior.assumptions) !== canonical(next.assumptions)) classes.add("plan")
  if (canonical(prior.autonomy) !== canonical(next.autonomy)) blocked.push("the autonomy policy itself changed (owner only)")
  const handled = new Set<string>(["criteria", "invariants", "budget", "plan", "assumptions", "autonomy"])
  for (const key of new Set([...Object.keys(prior), ...Object.keys(next)]))
    if (!handled.has(key) && canonical((prior as any)[key]) !== canonical((next as any)[key])) blocked.push(`${key} changed`)
  return { classes: [...classes], blocked }
}

/** Whether `policy` lets the agent apply this change (or recovery) itself. */
export function policyAllows(policy: readonly AmendClass[], change: ChangeClassification, recovery = false): { ok: boolean; reasons: string[] } {
  const reasons = [...change.blocked]
  if (recovery && !policy.includes("recover")) reasons.push("divergence recovery is not in the policy")
  for (const c of change.classes) if (!policy.includes(c)) reasons.push(`${c} changes are not in the policy`)
  if (!change.classes.length && !change.blocked.length) reasons.push("no change")
  return { ok: policy.length > 0 && reasons.length === 0, reasons }
}
