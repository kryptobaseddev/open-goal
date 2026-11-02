// T169 — declared workstreams: one goal, several CLEO tasks, named workers.
//
// A contract may declare `workstreams`: each is one CLEO task under this goal's
// saga, an explicit worker address, and the return the host will believe. The
// pure rules live here so the dispatch brief, the acceptance bar and the
// aggregate status are one testable model; the transport (AgentMBX), the ledger
// and the persisted run state stay in the host.
//
// Two rules carry the safety:
//   - the worker address is explicit in the contract, so the owner's consent to
//     send outward is written down, never inferred;
//   - a return is accepted only with machine-checkable evidence atoms the task
//     declared, so prose alone can never mark a workstream proven.

import { CLEO_GATES, type CleoGate, type Contract, type Workstream } from "../contract/types"

export type WorkstreamStatus = "pending" | "dispatched" | "accepted" | "rejected"

/** What the host persists about one workstream on the run. Optional and additive. */
export type WorkstreamState = {
  id: string
  task: string
  worker: string
  status: WorkstreamStatus
  /** The dispatch message id, once the brief was sent. */
  messageId?: string
  /** When the return was judged (or the dispatch failed). */
  at?: number
  /** Why a return was rejected, or why the dispatch could not be sent. */
  reason?: string
  /** The evidence atoms an accepted return carried. */
  atoms?: string[]
}

/** A declared workstream joined with the ACs and gates its task link carries. */
export type PlannedWorkstream = Workstream & { acs: string[]; gates: CleoGate[] }

/** Each declared workstream with the task link's ACs and effective gates. */
export function planWorkstreams(contract: Contract): PlannedWorkstream[] {
  const links = new Map((contract.cleo?.tasks ?? []).map((task) => [task.id, task]))
  return (contract.workstreams ?? []).map((workstream) => {
    const acs: string[] = []
    const gates = new Set<CleoGate>(workstream.gates ?? [])
    for (const [gate, aliases] of Object.entries(links.get(workstream.task)?.acs ?? {}) as Array<[CleoGate, string[] | undefined]>) {
      for (const alias of aliases ?? []) if (!acs.includes(alias)) acs.push(alias)
      if ((aliases ?? []).length) gates.add(gate)
    }
    return { ...workstream, acs, gates: CLEO_GATES.filter((gate) => gates.has(gate)) }
  })
}

/** One bounded brief: what to do, what to return, and nothing it must not do. */
export function dispatchBrief(input: { contract: Contract; workstream: PlannedWorkstream }): string {
  const { contract, workstream } = input
  const gates = workstream.gates.length ? `Gates: ${workstream.gates.join(", ")}` : "Gates: none declared — return any evidence atom below"
  const acs = workstream.acs.length
    ? `ACs: ${workstream.acs.map((ac) => `satisfies:${workstream.task}#${ac}`).join(", ")}`
    : `ACs: satisfies:${workstream.task}#<ac> for each AC this task names`
  return [
    `T169 workstream ${workstream.id} — ${workstream.title}`,
    `Goal: ${contract.id} — ${contract.title}`,
    `Outcome: ${contract.outcome}`,
    `CLEO task: ${workstream.task}`,
    `Done when: ${workstream.done_when}`,
    gates,
    acs,
    "Return: a short summary plus the exact evidence atoms above (commit:<sha> + files:<paths>, test-run:<path>, tool:<name>).",
    "A prose-only return is rejected by name. Do not create a goal for this work — it belongs to the goal named here.",
  ].join("\n").slice(0, 1_200)
}

export type ReturnedEvidence = {
  atoms: string[]
  satisfies: Array<{ task: string; ac: string }>
  prose: string
}

const ATOM = /(?:^|[\s;,(])(commit:[a-f0-9]{7,40}|files:[^\s;)]+|test-run:[^\s;)]+|tool:[a-z0-9][a-z0-9._-]*)/gi
const SATISFIES = /\bsatisfies:([A-Z]{1,4}\d+)#(AC\d+)\b/gi

/** Pull the evidence atoms out of a worker's return. Prose alone yields none. */
export function parseReturn(text: string): ReturnedEvidence {
  const atoms = [...text.matchAll(ATOM)].map((match) => match[1]!)
  const satisfies = [...text.matchAll(SATISFIES)].map((match) => ({ task: match[1]!, ac: match[2]! }))
  return { atoms: [...new Set(atoms)], satisfies, prose: text.trim() }
}

export type ReturnVerdict = { ok: boolean; reason?: string; atoms: string[] }

/**
 * Decide whether a workstream return is proven. Every declared AC must be
 * attributed to this task, and every gate the workstream owns must carry its
 * atom; anything else is rejected with a reason that names what is missing.
 */
export function validateReturn(workstream: PlannedWorkstream, text: string): ReturnVerdict {
  const returned = parseReturn(text)
  const atoms = returned.atoms
  if (!atoms.length) {
    return { ok: false, reason: `prose-only return for ${workstream.id}: no machine-checkable evidence atom (commit:, files:, test-run: or tool:)`, atoms }
  }
  const attributed = new Set(returned.satisfies.filter((s) => s.task === workstream.task).map((s) => s.ac))
  const missingAcs = workstream.acs.filter((ac) => !attributed.has(ac))
  if (missingAcs.length) {
    return { ok: false, reason: `return for ${workstream.id} does not prove ${workstream.task} AC(s) ${missingAcs.join(", ")} (expected satisfies:${workstream.task}#<ac>)`, atoms }
  }
  const has = (prefix: string) => atoms.some((atom) => atom.startsWith(prefix))
  const missingGates = workstream.gates.filter((gate) =>
    gate === "implemented" ? !(has("commit:") && has("files:")) : gate === "testsPassed" ? !has("test-run:") : !has("tool:"),
  )
  if (missingGates.length) {
    return { ok: false, reason: `return for ${workstream.id} lacks the evidence atom(s) for ${missingGates.join(", ")}`, atoms }
  }
  return { ok: true, atoms }
}

/** One aggregate over the declared workstreams — never a second goal. */
export function aggregate(states: Iterable<WorkstreamState>): { total: number; accepted: number; rejected: number; pending: number; proven: boolean } {
  const list = [...states]
  const count = (status: WorkstreamStatus) => list.filter((state) => state.status === status).length
  return {
    total: list.length,
    accepted: count("accepted"),
    rejected: count("rejected"),
    pending: count("pending") + count("dispatched"),
    proven: list.length > 0 && list.every((state) => state.status === "accepted"),
  }
}

/** The owner-facing rows: declared order, host state, no invented progress. */
export function workstreamRows(contract: Contract, states: Record<string, WorkstreamState> | undefined): Array<{
  id: string
  title: string
  task: string
  worker: string
  done_when: string
  status: WorkstreamStatus
  reason?: string
  at?: number
}> {
  return planWorkstreams(contract).map((workstream) => {
    const state = states?.[workstream.id]
    return {
      id: workstream.id,
      title: workstream.title,
      task: workstream.task,
      worker: workstream.worker,
      done_when: workstream.done_when,
      status: state?.status ?? "pending",
      ...(state?.reason ? { reason: state.reason } : {}),
      ...(state?.at ? { at: state.at } : {}),
    }
  })
}
