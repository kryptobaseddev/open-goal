// T171 — the read-only CLEO evidence rollup.
//
// The goal already turns its PROVEN criteria into per-gate CLEO evidence
// (`cleo-bridge.ts`). This module answers the opposite question without writing
// a byte: for the goal's saga, its epics and its tasks, what is PROVEN and what
// is not — derived from CLEO's own `verification.evidence`, never from a status
// we would have to invent and never from a hand-written note.
//
// Honesty rules:
//  1. A task is "proven" only when every CLEO gate records evidence in the task's
//     `verification.gates` map. A `done` status alone is reported verbatim and
//     does not become proof.
//  2. An acceptance criterion is "proven" only when an evidence atom of kind
//     `satisfies` cites its alias. Nothing is inferred by position.
//  3. Every failed read is listed verbatim in `unread`; a node we could not read
//     is left absent rather than guessed.
//  4. Nothing here writes. All reads are `cleo` CLI reads (`show`, `list`,
//     `saga members`, `saga rollup`); the engine never opens `.cleo` or its DB.

import { cleoRefusal, type CleoRun } from "./cleo-bridge"
import type { CriterionStatus } from "./state"
import { CLEO_GATES, type CleoGate } from "../contract/types"

/** Where a goal's work lands: the saga it rolls into, its epics and its tasks. */
export type CleoRollupTargets = { saga?: string; epics: string[]; tasks: string[] }

/** The goal-side half: the run's criteria and the CLEO ACs each one proves. */
export type GoalCriterionRollup = {
  id: string
  statement: string
  status: CriterionStatus
  essential: boolean
  /** `T123#AC2` references from the criterion's own `proves:` — never positional. */
  proves: string[]
}

export type CleoTaskProof = {
  id: string
  title: string
  /** CLEO's status, verbatim. */
  status: string
  /** Every CLEO gate holds recorded evidence. Definition of "proven work". */
  proven: boolean
  gates: Record<CleoGate, boolean>
  unprovenGates: CleoGate[]
  /** How many evidence atoms the task holds across its gates. */
  evidenceAtoms: number
  acs: { total: number; proven: number; open: string[] }
}

export type CleoProofTotals = {
  tasks: number
  proven: number
  unproven: number
  /** Tasks CLEO reports as `done`, verbatim (may lag their evidence). */
  closed: number
  acs: { total: number; proven: number; unproven: number }
}

export type CleoEpicRollup = {
  id: string
  title?: string
  status?: string
  tasks: CleoTaskProof[]
  proof: CleoProofTotals
}

export type CleoSagaRollup = {
  id: string
  title?: string
  status?: string
  /** CLEO's own `saga rollup` aggregate, reproduced verbatim. */
  cleo?: { total: number; done: number; active: number; blocked: number; pending: number; completionPct: number }
  /** The epics actually read here: the declared ones, else the saga's members. */
  epics: CleoEpicRollup[]
  proof: CleoProofTotals
}

export type CleoRollup = {
  schemaVersion: 1
  source: "cleo-cli"
  /** The goal's criteria and the task ACs they claim to prove. */
  goal: GoalCriterionRollup[]
  saga: CleoSagaRollup | null
  /** Declared epics (or the saga's members when none are declared). */
  epics: CleoEpicRollup[]
  /** Declared tasks that belong to none of the read epics. */
  tasks: CleoTaskProof[]
  totals: CleoProofTotals
  /** Exact reasons a read could not answer. Anything listed here is absent, not zero. */
  unread: string[]
}

const GATE_LIST: readonly CleoGate[] = CLEO_GATES

const emptyTotals = (): CleoProofTotals => ({ tasks: 0, proven: 0, unproven: 0, closed: 0, acs: { total: 0, proven: 0, unproven: 0 } })


/** The LAFS envelope of a successful `cleo` read, else undefined. */
const envelope = (stdout: string): any | undefined => {
  const start = stdout.indexOf("{")
  if (start === -1) return undefined
  try {
    const parsed = JSON.parse(stdout.slice(start))
    return parsed?.success === false ? undefined : parsed
  } catch {
    return undefined
  }
}

const asRecord = (value: unknown): Record<string, any> => (typeof value === "object" && value !== null ? (value as Record<string, any>) : {})

/**
 * Derive one task's proof from its CLEO record. Pure: every fact is read from
 * `verification.gates` and the `satisfies` evidence atoms, nothing by position.
 */
export function taskProof(raw: unknown): CleoTaskProof {
  const task = asRecord(raw)
  const verification = asRecord(task.verification)
  const gateMap = asRecord(verification.gates)
  const gates = Object.fromEntries(GATE_LIST.map((gate) => [gate, gateMap[gate] === true])) as Record<CleoGate, boolean>
  const unprovenGates = GATE_LIST.filter((gate) => !gates[gate])
  const evidence = asRecord(verification.evidence)
  const atoms = GATE_LIST.flatMap((gate) => (Array.isArray(asRecord(evidence[gate]).atoms) ? (asRecord(evidence[gate]).atoms as unknown[]) : []))
  const satisfies = new Set(
    atoms
      .map((atom) => asRecord(atom))
      .filter((atom) => atom.kind === "satisfies")
      .map((atom) => (typeof atom.targetAcAlias === "string" ? atom.targetAcAlias : ""))
      .filter(Boolean),
  )
  const acceptance = Array.isArray(task.acceptance) ? task.acceptance : []
  const aliases = acceptance.map((_: unknown, index: number) => `AC${index + 1}`)
  // An evidence atom may cite an AC beyond the acceptance rows we can see (a
  // typed gate row, for instance). Count it as proven and as part of the total.
  for (const alias of satisfies) if (!aliases.includes(alias)) aliases.push(alias)
  const unproven = aliases.filter((alias) => !satisfies.has(alias))
  return {
    id: typeof task.id === "string" ? task.id : "",
    title: typeof task.title === "string" ? task.title : "",
    status: typeof task.status === "string" ? task.status : "unknown",
    proven: unprovenGates.length === 0 && GATE_LIST.length > 0,
    gates,
    unprovenGates,
    evidenceAtoms: atoms.length,
    acs: { total: aliases.length, proven: aliases.length - unproven.length, open: unproven },
  }
}

/** Aggregate task proofs into the epic/saga totals. Pure. */
export function proofTotals(tasks: CleoTaskProof[]): CleoProofTotals {
  const totals = emptyTotals()
  for (const task of tasks) {
    totals.tasks += 1
    if (task.proven) totals.proven += 1
    else totals.unproven += 1
    if (task.status === "done") totals.closed += 1
    totals.acs.total += task.acs.total
    totals.acs.proven += task.acs.proven
    totals.acs.unproven += task.acs.open.length
  }
  return totals
}

/** A read function that records every refusal verbatim instead of throwing. */
function reader(runCleo: CleoRun, unread: string[]) {
  return async (argv: string[]): Promise<any | undefined> => {
    try {
      const { stdout, exit } = await runCleo(argv)
      if (exit !== 0) {
        unread.push(`cleo ${argv.join(" ")} → exit ${exit}: ${cleoRefusal(stdout)}`)
        return undefined
      }
      const parsed = envelope(stdout)
      if (!parsed) unread.push(`cleo ${argv.join(" ")} returned no usable JSON`)
      return parsed
    } catch (error) {
      unread.push(`cleo ${argv.join(" ")} failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
}

const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/**
 * Read the rollup for a goal's targets. ONE read per epic (`show` + `list`) plus
 * one `show` for any declared task outside those epics; a `saga` adds `members`
 * and `rollup`. Nothing is written, and any failed read appears in `unread`.
 */
export async function readRollup(targets: CleoRollupTargets, runCleo: CleoRun, goal: GoalCriterionRollup[] = []): Promise<CleoRollup> {
  const unread: string[] = []
  const read = reader(runCleo, unread)

  const memberIds: string[] = []
  let cleoSaga: CleoSagaRollup["cleo"]
  let sagaTitle: string | undefined
  let sagaStatus: string | undefined
  if (targets.saga) {
    const members = await read(["saga", "members", targets.saga])
    for (const row of rows(members?.data?.members)) {
      const id = asRecord(row).epicId
      if (typeof id === "string" && id) memberIds.push(id)
    }
    const rollup = await read(["saga", "rollup", targets.saga])
    const data = asRecord(rollup?.data)
    if (typeof data.total === "number")
      cleoSaga = {
        total: Number(data.total),
        done: Number(data.done ?? 0),
        active: Number(data.active ?? 0),
        blocked: Number(data.blocked ?? 0),
        pending: Number(data.pending ?? 0),
        completionPct: Number(data.completionPct ?? 0),
      }
    const shown = await read(["show", targets.saga])
    const task = asRecord(shown?.data?.task)
    if (typeof task.title === "string") sagaTitle = task.title
    if (typeof task.status === "string") sagaStatus = task.status
  }

  const epics: CleoEpicRollup[] = []
  const seen = new Set<string>()
  const epicIds = targets.epics.length ? targets.epics : memberIds
  for (const epicId of epicIds) {
    const shown = await read(["show", epicId])
    const epicTask = asRecord(shown?.data?.task)
    const listed = await read(["list", "--parent", epicId, "--full", "--limit", "0"])
    const tasks = rows(listed?.data?.tasks).map(taskProof)
    for (const task of tasks) seen.add(task.id)
    epics.push({
      id: epicId,
      ...(typeof epicTask.title === "string" ? { title: epicTask.title } : {}),
      ...(typeof epicTask.status === "string" ? { status: epicTask.status } : {}),
      tasks,
      proof: proofTotals(tasks),
    })
  }

  const missing = targets.tasks.filter((id) => !seen.has(id))
  let loose: CleoTaskProof[] = []
  if (missing.length) {
    const shown = await read(["show", ...missing, "--full"])
    loose = rows(shown?.data?.tasks).map(taskProof)
  }

  const sagaProof = proofTotals(epics.flatMap((epic) => epic.tasks))
  const totals = proofTotals([...epics.flatMap((epic) => epic.tasks), ...loose])

  return {
    schemaVersion: 1,
    source: "cleo-cli",
    goal,
    saga: targets.saga
      ? {
          id: targets.saga,
          ...(sagaTitle ? { title: sagaTitle } : {}),
          ...(sagaStatus ? { status: sagaStatus } : {}),
          ...(cleoSaga ? { cleo: cleoSaga } : {}),
          epics,
          proof: sagaProof,
        }
      : null,
    epics,
    tasks: loose,
    totals,
    unread,
  }
}

const mark = (proof: CleoTaskProof) => (proof.proven ? "✓" : proof.acs.proven > 0 || GATE_LIST.some((g) => proof.gates[g]) ? "◐" : "·")
const openList = (task: CleoTaskProof) => (task.acs.open.length ? ` · open ${task.acs.open.join(", ")}` : "")
const proofLine = (totals: CleoProofTotals) => `${totals.proven}/${totals.tasks} tasks proven${totals.closed ? ` · ${totals.closed} closed` : ""} · AC ${totals.acs.proven}/${totals.acs.total}`

/** Full read-only report: one line per task, then the goal's criterion map. */
export function cleoRollupReport(rollup: CleoRollup): string {
  const out: string[] = ["CLEO rollup — read-only, derived from CLEO's own verification evidence"]
  if (rollup.saga) {
    const s = rollup.saga
    const cleo = s.cleo ? ` · CLEO ${s.cleo.done}/${s.cleo.total} epics done (${s.cleo.completionPct}%)` : ""
    out.push(`saga ${s.id}${s.title ? ` ${s.title}` : ""} (${s.status ?? "unknown"})${cleo} · ${proofLine(s.proof)}`)
  }
  for (const epic of rollup.epics) {
    out.push(`  epic ${epic.id}${epic.title ? ` ${epic.title}` : ""} (${epic.status ?? "unknown"}) · ${proofLine(epic.proof)}`)
    for (const task of epic.tasks) out.push(`    ${mark(task)} ${task.id} ${task.title} (${task.status}) · gates ${GATE_LIST.filter((g) => task.gates[g]).length}/${GATE_LIST.length} · AC ${task.acs.proven}/${task.acs.total}${openList(task)}`)
  }
  if (rollup.tasks.length) {
    out.push("tasks outside a listed epic:")
    for (const task of rollup.tasks) out.push(`    ${mark(task)} ${task.id} ${task.title} (${task.status}) · gates ${GATE_LIST.filter((g) => task.gates[g]).length}/${GATE_LIST.length} · AC ${task.acs.proven}/${task.acs.total}${openList(task)}`)
  }
  out.push(`total: ${proofLine(rollup.totals)}`)
  if (rollup.goal.length) {
    out.push("goal criteria → CLEO ACs (from the contract's proves:, never by position):")
    for (const criterion of rollup.goal) out.push(`    ${criterion.status === "pass" ? "✓" : criterion.status === "fail" ? "✗" : "·"} ${criterion.id} ${criterion.statement}${criterion.proves.length ? ` → ${criterion.proves.join(", ")}` : " → (no CLEO AC)"}`)
  }
  if (rollup.unread.length) {
    out.push("not read (reported verbatim, never guessed):")
    for (const reason of rollup.unread) out.push(`    ${reason}`)
  }
  return out.join("\n")
}

/** Compact form for `/goal status`: totals, one line per epic, nothing invented. */
export function cleoRollupSummary(rollup: CleoRollup): string {
  const head = rollup.saga
    ? `CLEO rollup: saga ${rollup.saga.id} (${rollup.saga.status ?? "unknown"})${rollup.saga.cleo ? ` · CLEO ${rollup.saga.cleo.done}/${rollup.saga.cleo.total} epics done` : ""} · ${proofLine(rollup.saga.proof)}`
    : `CLEO rollup: ${proofLine(rollup.totals)}`
  const epics = rollup.epics.map((epic) => `${epic.id} ${epic.proof.proven}/${epic.proof.tasks} proven`)
  const unread = rollup.unread.length ? [`${rollup.unread.length} CLEO read(s) unavailable — /goal cleo rollup for the exact reasons`] : []
  return [head, epics.length ? `epics: ${epics.join(" · ")}` : "", ...unread].filter(Boolean).join("\n")
}
