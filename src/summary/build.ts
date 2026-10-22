// T045 — the post-goal summary. One pure builder turning what the run
// already has (contract, run state, ledger) into a summary the owner and the
// agent both see on terminal transitions: per-criterion outcomes WITH
// provenance — owner-approved and fallback-passed criteria carry explicit
// caveats, never silently equal to host-proven — the scope audit flags
// (T046), restated non-goals, mid-run findings from the ledger, and
// follow-up prompts including the CLEO-install suggestion when the project
// has no .cleo workspace. Rendered by the TUI dialog, a one-line
// goal.summary notice and a persisted evidence file.
import type { Contract } from "../contract/types"
import type { RunState } from "../engine/state"

export type Provenance = "host" | "verifier" | "verifier-fallback" | "human"

export type SummaryCriterion = {
  id: string
  statement: string
  status: "pass" | "fail" | "unknown"
  by?: Provenance
  detail?: string
  caveat?: string
}

export type ScopeAuditFlag = {
  /** what was discussed but left unproven: a plan step or a scope.in item */
  kind: "step" | "scope"
  id: string
  title: string
  why: string
}

export type SummaryFinding = { kind: string; text: string; at?: number }

export type PostGoalSummary = {
  slug: string
  title: string
  status: string
  turns: number
  headline: string
  /** One line saying what this run actually finished, for a 3-second read. */
  completed: string
  /** What went right, most load-bearing first. */
  wentRight: string[]
  /** What went wrong (failures, flags, blockers, verifier trouble). */
  wentWrong: string[]
  /** What still needs a fix or an owner decision. Empty ⇒ nothing blocking. */
  stillOpen: string[]
  /** Linked CLEO tasks and follow-ups the run logged. */
  tasks: string[]
  /** Concrete suggested next actions. */
  nextSteps: string[]
  /** A screen-fit digest (≤14 lines) for the dialog; `text` is the full report. */
  digest: string
  criteria: SummaryCriterion[]
  caveats: string[]
  scopeAudit: ScopeAuditFlag[]
  nonGoals: string[]
  findings: SummaryFinding[]
  followUps: string[]
  text: string
}

const countBy = (criteria: SummaryCriterion[], by: Provenance) => criteria.filter((c) => c.status === "pass" && c.by === by).length

/** The provenance split on one line, e.g. "host 6 · verifier 2 · owner 1". */
export function provenanceSplit(criteria: SummaryCriterion[]): string | undefined {
  const parts = [
    ["host", countBy(criteria, "host")],
    ["verifier", countBy(criteria, "verifier")],
    ["owner", countBy(criteria, "human")],
    ["fallback", countBy(criteria, "verifier-fallback")],
  ].filter(([, n]) => Number(n) > 0) as Array<[string, number]>
  return parts.length ? parts.map(([k, n]) => `${k} ${n}`).join(" · ") : undefined
}

/** The screen-fit digest: what a human needs in 3–5 seconds, then the three
 *  things they act on. Hard-capped at 14 lines so it never overflows a
 *  dialog — the full report (criteria, non-goals, findings) stays in `text`. */
export function buildDigest(s: Omit<PostGoalSummary, "digest" | "text">): string {
  const lines: string[] = []
  const icon = s.status === "complete" ? "✓" : s.status === "failed" ? "✗" : s.status === "budget_limited" ? "⊘" : s.status === "backstop_limited" ? "⏱" : "⚑"
  const proven = s.criteria.filter((c) => c.status === "pass").length
  const terminal = new Set(["complete", "failed", "aborted", "needs_review", "budget_limited", "backstop_limited"])
  const stopped = terminal.has(s.status) ? "loop stopped" : "loop running"
  lines.push(`${icon} ${s.status.replace(/_/g, " ")} · ${proven}/${s.criteria.length} proven · ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${stopped}`)
  lines.push(s.completed)
  if (s.tasks.length) lines.push(`TASKS  ${s.tasks.slice(0, 2).join(" · ")}${s.tasks.length > 2 ? ` · +${s.tasks.length - 2}` : ""}`)
  const section = (title: string, items: string[], mark: string, cap: number, overflow = true) => {
    lines.push(title)
    for (const item of items.slice(0, cap)) lines.push(`  ${mark} ${item}`)
    if (overflow && items.length > cap) lines.push(`  … +${items.length - cap} more — F9 for all`)
  }
  section("WENT RIGHT", s.wentRight.length ? s.wentRight : ["nothing recorded"], "+", 2)
  section("WENT WRONG", s.wentWrong.length ? s.wentWrong : ["nothing — no failed checks"], "−", 2)
  section("STILL OPEN", s.stillOpen.length ? s.stillOpen : ["nothing blocking"], "·", 1)
  section("NEXT", s.nextSteps.length ? s.nextSteps : ["/goal status"], "→", 2, false)
  return lines.slice(0, 14).join("\n")
}

/** The caveat a provenance carries. Owner approvals and fenced-json
 *  fallbacks are real evidence but weaker than host/verifier proof — the
 *  summary says so instead of laundering them as equivalent. */
export function provenanceCaveat(by: Provenance | undefined): string | undefined {
  if (by === "human") return "approved by the owner — final; not independently re-checked"
  if (by === "verifier-fallback") return "parsed from the verifier's prose fallback (fenced json, not a tool call); quotes were re-read by the host"
  return undefined
}

const label = (status: string) => (status === "pass" ? "✓ pass" : status === "fail" ? "✗ fail" : "· unknown")

/** Mid-run findings worth surfacing at the end, from the run's ledger:
 *  criterion flags, blocker keys, empty verifier rounds, fallback parses,
 *  amendments and budget stops. Unknown types are ignored. */
export function findingsFromLedger(events: Array<Record<string, unknown>>): SummaryFinding[] {
  const out: SummaryFinding[] = []
  for (const e of events) {
    const at = typeof e.at === "number" ? e.at : typeof e.turn === "number" ? e.turn : undefined
    if (e.type === "flag") out.push({ kind: "flag", text: `${e.criterion ? `${e.criterion}: ` : ""}${String(e.reason ?? e.kind ?? "flagged")}`, at })
    else if (e.type === "blocked") {
      const blocker = (e.blocker ?? {}) as { key?: string; reason?: string; count?: number }
      out.push({ kind: "blocked", text: `${blocker.key ?? "blocker"} — ${blocker.reason ?? "owner decision needed"}${blocker.count ? ` (raised ${blocker.count}×)` : ""}`, at })
    } else if (e.type === "verifier-empty") out.push({ kind: "verifier-empty", text: `verifier round ${e.round} returned an empty exchange (retried/recorded)`, at })
    else if (e.type === "verifier-fallback") out.push({ kind: "verifier-fallback", text: `${e.count} verdict(s) parsed from a prose-answering verifier`, at })
    else if (e.type === "amended") out.push({ kind: "amended", text: `contract amended (generation ${e.generation ?? "?"}): ${e.summary ?? ""}`, at })
    else if (e.type === "amend-proposed") out.push({ kind: "amend-proposed", text: `amendment proposed: ${e.summary ?? ""}`, at })
    else if (e.type === "budget_limited") out.push({ kind: "budget_limited", text: "the run hit its budget", at })
    else if (e.type === "backstop_limited") out.push({ kind: "backstop_limited", text: `the run hit the ${e.backstopTurns ?? "turn"} backstop because no budget was set`, at })
  }
  return out
}

export type SummaryInput = {
  contract: Contract
  state: RunState
  ledgerEvents?: Array<Record<string, unknown>>
  /** the project's cleo-linkage probe result; absent → install suggestion */
  cleo?: { source: string } | undefined
  /** T046: flagged unproven plan steps / scope.in items; empty until wired */
  scopeAudit?: ScopeAuditFlag[]
  /** v0.8.0 C4: the loop started the next ready item, so it did not stop. */
  continued?: boolean
}

export function buildPostGoalSummary(input: SummaryInput): PostGoalSummary {
  const { contract, state } = input
  const criteria: SummaryCriterion[] = [...contract.criteria, ...contract.invariants].map((c) => {
    const s = state.criteria[c.id]
    const status = s?.status === "pass" ? ("pass" as const) : s?.status === "fail" ? ("fail" as const) : ("unknown" as const)
    const by = (s?.by as Provenance | undefined) ?? undefined
    return { id: c.id, statement: c.statement, status, by, detail: s?.detail, caveat: status === "pass" ? provenanceCaveat(by) : undefined }
  })
  const caveats = criteria.filter((c) => c.caveat).map((c) => `${c.id} — ${c.caveat}`)
  const scopeAudit = input.scopeAudit ?? []
  const findings = findingsFromLedger(input.ledgerEvents ?? [])
  const proven = criteria.filter((c) => c.status === "pass").length

  const followUps: string[] = []
  if (state.status === "complete") {
    followUps.push(input.continued
      ? "The loop kept going: the next ready item was started by itself. Inspect it in the Goal manager (/goal list)."
      : "Start the next goal: /goal new <what you want done> — the non-goals below are the ready-made backlog.")
  } else if (state.status === "needs_review") {
    followUps.push("Resolve the review: /goal approve <C#> (final) or /goal reject <C#> <why>, then /goal verify.")
  } else if (state.status === "budget_limited") {
    followUps.push("Raise the budget in goal.yaml and start a new run, or wrap up: /goal archive after aborting.")
  } else if (state.status === "backstop_limited") {
    followUps.push("No budget was set, so the run stopped at the turn backstop. Set budget.turns in goal.yaml and amend it, or wrap up: /goal archive after aborting.")
  }
  if (scopeAudit.length) followUps.push("Break the discussed-but-unproven items out into a follow-up goal so they stop riding on this one.")
  followUps.push("Decompose long-running work with CLEO" + (input.cleo ? " (this project is already linked; keep tasks completing with evidence)." : ": this project has no .cleo workspace — installing it gives goals a task board that outlives any single run (the link stays optional and CLI-only)."))

  const headline =
    state.status === "complete"
      ? `goal complete — ${proven}/${criteria.length} criteria proven${caveats.length ? `, ${caveats.length} with provenance caveats` : ""}`
      : `goal ${state.status} — ${proven}/${criteria.length} criteria proven, ${criteria.length - proven} not yet`

  // What actually finished, in one sentence a human can scan. The contract's
  // outcome is the end state; the linked CLEO tasks are the durable record.
  const cleoTasks = (contract.cleo?.tasks ?? []).map((t) => t.id)
  const completed = state.status === "complete"
    ? `${contract.outcome}${cleoTasks.length ? ` — ${cleoTasks.join(", ")} closed` : ""}`
    : `${contract.outcome} — ${proven}/${criteria.length} proven, ${criteria.length - proven} still open`

  // What went right: proof first, then the run's own clean facts.
  const wentRight: string[] = []
  const split = provenanceSplit(criteria)
  const rejections = Object.values(state.criteria).reduce((n, c) => n + (c.rejections ?? 0), 0)
  wentRight.push(`${proven}/${criteria.length} criteria proven${split ? ` (${split})` : ""}`)
  if (!criteria.some((c) => c.status === "fail")) wentRight.push(rejections === 0 ? "no failed checks and no rejected claims" : "no failed criteria at the end")
  const acceptedAmendments = state.amendments.filter((a) => a.status === "accepted").length
  if (acceptedAmendments) wentRight.push(`${acceptedAmendments} amendment${acceptedAmendments === 1 ? "" : "s"} accepted and re-locked`)

  // What went wrong: failures, then the ledger findings that cost time.
  const wentWrong: string[] = []
  for (const c of criteria.filter((c) => c.status === "fail")) {
    wentWrong.push(`${c.id} ${c.statement} — ${(c.detail ?? "failed").split("\n")[0]}`)
  }
  for (const f of findings) {
    if (f.kind === "amended" || f.kind === "amend-proposed") continue
    wentWrong.push(f.text)
  }
  if (rejections) wentWrong.push(`${rejections} rejected claim${rejections === 1 ? "" : "s"} before the final pass`)

  // What still needs a fix or an owner decision. Empty is a success state.
  const stillOpen: string[] = []
  for (const c of criteria.filter((c) => c.status !== "pass")) stillOpen.push(`${c.id} ${c.statement} — ${c.status}`)
  for (const f of scopeAudit) stillOpen.push(`${f.kind === "step" ? `plan step ${f.id}` : `scope.in ${f.id}`} ${f.title} — discussed but unproven`)
  if (state.blocker) stillOpen.push(`${state.blocker.key} — ${state.blocker.reason}`)
  if (state.status === "needs_review") stillOpen.push("owner review is waiting")

  // Tasks the run logged: linked CLEO tasks and peer candidates (follow-up
  // prompts are separate, so the digest can stay one short line).
  const tasks: string[] = []
  if (cleoTasks.length) tasks.push(`CLEO ${cleoTasks.join(", ")}`)
  for (const candidate of state.peer?.candidates ?? []) tasks.push(`peer ${candidate.from ?? candidate.project}: ${candidate.title}${candidate.taskId ? ` (${candidate.taskId})` : ""}`)

  // Suggested next actions, shortest path first.
  const nextSteps: string[] = []
  if (state.status === "complete") {
    nextSteps.push(input.continued ? "Inspect the goal that started by itself — /goal list" : "Start the next goal — /goal new <what you want done>")
    nextSteps.push(`Break this into tasks — /goal decompose ${state.slug}`)
    nextSteps.push("Close it out — /goal archive")
  } else if (state.status === "needs_review") {
    nextSteps.push("Answer the review — /goal approve <C#> or /goal reject <C#> <why>")
    nextSteps.push("Re-run the checks — /goal verify")
  } else if (state.status === "budget_limited") {
    nextSteps.push("Raise the budget in goal.yaml, then start a new run")
    nextSteps.push("Or wrap up — /goal archive")
  } else if (state.status === "backstop_limited") {
    nextSteps.push("Set budget.turns in goal.yaml, then amend the run")
    nextSteps.push("Or wrap up — /goal archive")
  } else {
    nextSteps.push("Inspect the goal — /goal status")
    nextSteps.push("Start a goal yourself — /goal new <what you want done>")
  }

  const lines: string[] = []
  lines.push(`# Post-goal summary — ${contract.title}`)
  lines.push(`${headline} · ${state.turn} turn(s)`)
  lines.push("")
  // T071: completion silence read as broken — the summary states plainly
  // what stopped. v0.8.0 C4: when the loop took the next item, this goal is
  // still finished but the loop is not.
  lines.push(input.continued
    ? `This goal has stopped (${state.status}); the loop started the next ready item and kept going. This goal itself no longer runs, verifies, or spends.`
    : `The loop has stopped (${state.status}). Nothing further runs, verifies, or spends on its own.`)
  lines.push(`Follow-ups live here: the list below, the Goal panel (F9), and .opencode/goals/${state.slug}/ (ledger, evidence, this summary).`)
  lines.push("")
  lines.push("## The short version")
  lines.push(completed)
  lines.push("")
  lines.push("## What went right")
  for (const item of wentRight) lines.push(`- ${item}`)
  lines.push("")
  lines.push("## What went wrong")
  for (const item of wentWrong.length ? wentWrong : ["nothing — no failed checks, flags, or blockers"]) lines.push(`- ${item}`)
  lines.push("")
  lines.push("## Still needs fixing")
  for (const item of stillOpen.length ? stillOpen : ["nothing — every contracted criterion is proven"]) lines.push(`- ${item}`)
  if (tasks.length) {
    lines.push("")
    lines.push("## Tasks")
    for (const item of tasks) lines.push(`- ${item}`)
  }
  lines.push("")
  lines.push("## Next steps")
  nextSteps.forEach((item, i) => lines.push(`${i + 1}. ${item}`))
  lines.push("")
  lines.push(`Outcome (as contracted): ${contract.outcome}`)
  lines.push("")
  lines.push("## Criteria")
  for (const c of criteria) {
    lines.push(`- ${label(c.status)} ${c.id} [${c.by ?? "unattributed"}] ${c.statement}${c.caveat ? `\n    caveat: ${c.caveat}` : ""}${c.status !== "pass" && c.detail ? `\n    ${c.detail.split("\n")[0]}` : ""}`)
  }
  if (scopeAudit.length) {
    lines.push("")
    lines.push("## Scope audit — discussed but unproven (flagged, not blocking)")
    for (const f of scopeAudit) lines.push(`- ${f.kind === "step" ? `plan step ${f.id}` : `scope.in ${f.id}`} — ${f.title}: ${f.why}`)
  }
  if (contract.non_goals.length) {
    lines.push("")
    lines.push("## Non-goals (deliberately not done)")
    for (const ng of contract.non_goals) lines.push(`- ${ng}`)
  }
  if (findings.length) {
    lines.push("")
    lines.push("## Mid-run findings")
    for (const f of findings) lines.push(`- ${f.kind}: ${f.text}`)
  }
  if (caveats.length) {
    lines.push("")
    lines.push("## Provenance caveats")
    for (const c of caveats) lines.push(`- ${c}`)
  }
  lines.push("")
  lines.push("## Follow-ups")
  for (const f of followUps) lines.push(`- ${f}`)

  const base = {
    slug: state.slug,
    title: state.title,
    status: state.status,
    turns: state.turn,
    headline,
    completed,
    wentRight,
    wentWrong,
    stillOpen,
    tasks,
    nextSteps,
    criteria,
    caveats,
    scopeAudit,
    nonGoals: contract.non_goals,
    findings,
    followUps,
  }
  return { ...base, digest: buildDigest(base), text: lines.join("\n") }
}

