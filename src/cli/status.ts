// `cleo-goal status --json`: the read contract CLEO parses (schemaVersion 1).
// CLEO never reads run.json directly; this is the only shape it relies on, so
// a field change here is a schemaVersion bump.
import { parseContract } from "../contract/parse"
import type { Contract } from "../contract/types"
import { budgetUse, isTerminal, type RunState, type Status } from "../engine/state"
import type { HarnessIdentity } from "../engine/harness-identity"
import type { Store } from "../engine/store"

export const STATUS_SCHEMA_VERSION = 1

export type StatusCriterion = {
  id: string
  statement: string
  status: "unknown" | "pass" | "fail" | "claimed"
  essential: boolean
  invariant: boolean
  by: string | null
  detail: string | null
}

export type GoalStatusJson = {
  schemaVersion: typeof STATUS_SCHEMA_VERSION
  goal: string | null
  runId: string | null
  title: string
  status: Status | "none"
  priority?: "low" | "medium" | "high"
  /**
   * v0.9.5: which harness produced this run and what it can do. Optional and
   * additive: `schemaVersion` stays 1 and a run that predates the field simply
   * omits it, so an older CLEO reads the same shape it always did.
   */
  harness?: HarnessIdentity
  turn: number
  reason: string | null
  criteria: StatusCriterion[]
  proven: number
  total: number
  budget: { ratio: number; parts: Array<{ name: string; used: number; limit: number }> }
  verdict: { passed: boolean; lines: string[]; turn: number } | null
  blocker: { key: string; count: number; reason: string } | null
  updatedAt: number
}

const NONE: GoalStatusJson = {
  schemaVersion: STATUS_SCHEMA_VERSION,
  goal: null,
  runId: null,
  title: "",
  status: "none",
  turn: 0,
  reason: null,
  criteria: [],
  proven: 0,
  total: 0,
  budget: { ratio: 0, parts: [] },
  verdict: null,
  blocker: null,
  updatedAt: 0,
}

/** The run to report: the newest live run, else the newest finished one. */
export function selectRun(store: Store): RunState | undefined {
  const runs = store
    .slugs()
    .map((slug) => store.readRun(slug))
    .filter((run): run is RunState => Boolean(run))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return runs.find((run) => !isTerminal(run.status)) ?? runs[0]
}

/** The contract generation the run locked (the disk copy may have moved on). */
function lockedContract(store: Store, run: RunState): Contract | undefined {
  const disk = store.readContract(run.slug)
  if (disk?.contract && disk.lock === run.lock) return disk.contract
  try {
    return parseContract(store.lockedText(run.slug, run.runId, run.lock), { slug: run.slug }).contract ?? disk?.contract
  } catch {
    return disk?.contract
  }
}

/** Build the status reply for the project the store belongs to. */
export function goalStatus(store: Store, now = Date.now()): GoalStatusJson {
  const run = selectRun(store)
  if (!run) return NONE
  const contract = lockedContract(store, run)
  const declared = contract
    ? [...contract.criteria.map((c) => ({ c, invariant: false })), ...contract.invariants.map((c) => ({ c, invariant: true }))]
    : []
  const criteria: StatusCriterion[] = declared.map(({ c, invariant }) => {
    const state = run.criteria[c.id]
    return {
      id: c.id,
      statement: c.statement,
      status: state?.status ?? "unknown",
      essential: c.essential,
      invariant,
      by: state?.by ?? null,
      detail: state?.detail ?? null,
    }
  })
  const states = Object.values(run.criteria).filter((c) => c && typeof c === "object")
  const budget = contract ? budgetUse(run, contract, now) : { ratio: 0, parts: [] }
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    goal: run.slug,
    runId: run.runId,
    title: run.title,
    status: run.status,
    ...(run.priority ? { priority: run.priority } : {}),
    ...(run.harness ? { harness: run.harness } : {}),
    turn: run.turn,
    reason: run.reason ?? null,
    criteria,
    proven: states.filter((c) => c.status === "pass").length,
    total: states.length,
    budget: { ratio: budget.ratio, parts: budget.parts.map((p) => ({ name: p.name, used: p.used, limit: p.limit })) },
    verdict: run.verdict ? { passed: run.verdict.passed, lines: run.verdict.lines, turn: run.verdict.turn } : null,
    blocker: run.blocker ? { key: run.blocker.key, count: run.blocker.count, reason: run.blocker.reason } : null,
    updatedAt: run.updatedAt,
  }
}
