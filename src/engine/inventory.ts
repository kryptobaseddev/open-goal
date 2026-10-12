import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Contract } from "../contract/types"
import { parseContract } from "../contract/parse"
import type { GoalSummary } from "../rpc"
import { isActive, isTerminal, type RunState } from "./state"
import { Store } from "./store"
import { byPriorityThenRecency } from "./registry"
import { launchView, type LaunchRequest } from "./launches"

const readableRun = (value?: RunState): value is RunState => !!value && typeof value.slug === "string" && typeof value.runId === "string" && typeof value.lock === "string" && typeof value.sessionID === "string" && typeof value.status === "string" && !!value.criteria && typeof value.criteria === "object" && !Array.isArray(value.criteria) && !!value.steps && typeof value.steps === "object"

/** Project-local, source-of-truth inventory. Archives are READ ONLY. The
 * machine registry and CLEO task tree are not a substitute for goal folders. */
export function projectInventory(store: Store, live: Iterable<RunState> = [], options: { detailsForKey?: string; launches?: LaunchRequest[] } = {}): GoalSummary[] {
  const liveBySlug = new Map([...live].filter(readableRun).map((s) => [s.slug, s]))
  const rows: GoalSummary[] = []
  for (const archived of [false, true]) {
    for (const slug of archived ? store.archivedSlugs() : store.slugs()) {
      const dir = archived ? store.archivedPath(slug) : store.dir(slug)
      const issues: string[] = []
      let read: ReturnType<Store["readContract"]> = undefined
      try { read = store.readContract(slug, { archived }) } catch { issues.push("Contract could not be read") }
      for (const i of read?.issues ?? []) if (i.level === "error") issues.push(`${i.path}: ${i.message}`)
      const saved = !archived ? liveBySlug.get(slug) ?? store.readRun(slug) : store.readRun(slug, { archived: true })
      const run = readableRun(saved) ? saved : undefined
      if (existsSync(join(dir, "run.json")) && !run) issues.push("Run state is unreadable; status/progress/session cannot be inferred")
      let contract: Contract | undefined = read?.contract
      // The locked generation, not an unaccepted disk edit, defines the
      // started goal's title, oracle count, plan and relationship metadata.
      if (run && read?.lock !== run.lock) {
        contract = undefined
        for (const name of [`contract-${run.lock}.yaml`, "contract.yaml"]) {
          try {
            const locked = parseContract(readFileSync(join(dir, "evidence", run.runId, name), "utf8"), { slug })
            if (locked.contract && locked.lock === run.lock) { contract = locked.contract; break }
          } catch { /* Try the original snapshot; never mutate history. */ }
        }
        issues.push("Disk contract differs from the locked generation")
      }
      const states = run ? Object.values(run.criteria).filter((c) => c && typeof c === "object") : []
      const status = run?.status ?? (existsSync(join(dir, "run.json")) ? "unknown" : "draft")
      const terminal = run ? isTerminal(run.status) : false
      let updatedAt = run?.updatedAt ?? 0
      if (!run) try { updatedAt = statSync(join(dir, "goal.yaml")).mtimeMs } catch { /* Unknown remains 0. */ }
      const key = `${archived ? "archive" : "live"}:${slug}:${run?.runId ?? read?.lock ?? "invalid"}`
      const launch = !archived ? options.launches?.filter((p) => p.slug === slug).sort((a, b) => Number(b.status === "executing") - Number(a.status === "executing") || b.createdAt - a.createdAt)[0] : undefined
      rows.push({
        key,
        slug, title: run?.title ?? contract?.title ?? slug, status,
        archived, terminal, attachable: !archived && !!run && !terminal && !isActive(run.status),
        valid: !!contract && !issues.length, updatedAt,
        proven: states.filter((c) => c.status === "pass").length,
        total: run ? states.length : contract ? contract.criteria.length + contract.invariants.length : 0,
        ...(run ? { sessionID: run.sessionID, runId: run.runId, lock: run.lock, turn: run.turn, ...(run.progress ? { progress: { ...run.progress } } : {}) } : read?.lock ? { lock: read.lock } : {}),
        ...(run?.handoff ? { handoff: { ...run.handoff } } : {}),
        ...(launch ? { launch: launchView(launch) } : {}),
        ...(run?.priority ?? contract?.priority ? { priority: run?.priority ?? contract?.priority } : {}),
        ...(contract ? { outcome: contract.outcome, meta: contract.meta, ...(contract.supersedes ? { supersedes: contract.supersedes } : {}), ...(contract.execution.agent ? { configuredAgent: contract.execution.agent } : {}), steps: contract.plan.map((s) => ({ id: s.id, title: s.title, status: run?.steps[s.id] ?? "pending" })) } : {}),
        sessionState: run || existsSync(join(dir, "run.json")) ? "unknown" : "unassigned",
        ...(issues.length ? { issues } : {}),
        ...(options.detailsForKey === key && contract ? { details: { criteria: [...contract.criteria.map((c) => ({ ...c, invariant: false })), ...contract.invariants.map((c) => ({ ...c, invariant: true }))].map((c) => {
          const state = run?.criteria[c.id]
          return { id: c.id, statement: c.statement, essential: c.essential, invariant: c.invariant, kind: c.check.kind, status: state?.status ?? "unknown", ...(state?.by ? { by: state.by } : {}), ...(state?.detail ? { detail: state.detail } : {}) }
        }), constraints: contract.constraints, nonGoals: contract.non_goals } } : {}),
      })
    }
  }
  return rows.sort(byPriorityThenRecency)
}
