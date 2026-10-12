import type { GoalSummary, GoalTarget, LaunchView, ManageAction } from "../rpc"
import { priorityWeight } from "../contract/types"
import type { Tone } from "./format"

const terminal = new Set(["complete", "failed", "aborted", "superseded"])
export const goalKey = (goal: GoalSummary) => goal.key ?? `${goal.archived ? "archive" : "live"}:${goal.slug}:${goal.runId ?? "draft"}`
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const columns = (text: string) => Bun.stringWidth(text, { ambiguousIsNarrow: false })

/** Column-fit, not UTF-16-length-fit. Don't split combining characters or
 * emoji sequences; full labels remain available in the manager details. */
export function fitColumns(text: string, width: number): string {
  const flat = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim()
  const limit = Math.max(1, Math.floor(width))
  if (columns(flat) <= limit) return flat
  const suffix = columns("…") <= limit ? "…" : "."
  let out = ""
  for (const { segment } of graphemes.segment(flat)) {
    if (columns(out + segment + suffix) > limit) break
    out += segment
  }
  return out + suffix
}

export const targetOf = (goal: GoalSummary): GoalTarget => ({ key: goalKey(goal), lock: goal.lock ?? "", ...(goal.runId ? { runId: goal.runId } : {}), ...(goal.sessionID ? { sessionID: goal.sessionID } : {}) })

/** Admission is visible progress, not a fabricated running/proven state. */
export function launchStatusText(launch?: LaunchView): string | undefined {
  if (!launch || launch.status === "succeeded") return undefined
  if (launch.status === "executing") return `Starting ${launch.slug} · ${launch.activity?.detail ?? "owner-approved admission"} · no run yet`
  if (launch.status === "pending" || launch.status === "interrupted") return `Launch review ${launch.slug} · pending in Composer · nothing started`
  return `Launch ${launch.slug} · ${launch.status} · ${launch.result ?? "nothing started; inspect the review"}`
}
export type ManagerAction = { label: string; description: string; action: ManageAction | "jump" | "back" }
export function managerActions(goal: GoalSummary, actorSessionID: string, actorHasGoal: boolean): ManagerAction[] {
  const rows: ManagerAction[] = []
  if (goal.sessionID && goal.sessionState === "present") rows.push({ label: "Open goal session", description: "Deliberately jump after viewing these details", action: "jump" })
  if (goal.valid !== false && !goal.archived && goal.runId) {
    if (["running", "waiting", "verifying"].includes(goal.status)) rows.push({ label: "Pause selected goal", description: "Stop only this goal's loop", action: "pause" })
    if (["paused", "blocked", "needs_review"].includes(goal.status)) rows.push({ label: "Resume selected goal", description: "Continue this stopped run", action: "resume" })
    if (!terminal.has(goal.status) && goal.status !== "verifying") rows.push({ label: "Verify selected goal", description: "Run its declared host checks and verifier", action: "verify" })
    if (goal.attachable && !actorHasGoal && goal.sessionID !== actorSessionID) rows.push({ label: "Attach selected goal here", description: "Move its ownership; preserve history and progress", action: "attach" })
    if (!terminal.has(goal.status)) rows.push({ label: "Abort selected goal", description: "Requires a native confirmation; preserves history", action: "abort" })
    else rows.push({ label: "Archive selected goal", description: "Requires a native confirmation; preserves history", action: "archive" })
  }
  rows.push({ label: "Back to all goals", description: "Collapse details without changing sessions", action: "back" })
  return rows
}

export function wrapColumns(text: string, width: number): string[] {
  const limit = Math.max(2, Math.floor(width))
  const result: string[] = []
  for (const line of text.split("\n")) {
    let out = ""
    for (const { segment } of graphemes.segment(line)) {
      if (out && columns(out + segment) > limit) { result.push(out); out = "" }
      out += segment
    }
    result.push(out)
  }
  return result
}

/** Current first, then the declared priority/recency order. Never sort or
 * mutate the server's inventory in place, or manufacture a task hierarchy. */
export function orderedGoals(goals: readonly GoalSummary[], sessionID: string): GoalSummary[] {
  const here = (g: GoalSummary) => !g.archived ? g.sessionID === sessionID ? 2 : g.handoff?.fromSessionID === sessionID || !g.runId && g.launch?.sessionID === sessionID ? 1 : 0 : 0
  return [...goals].sort((a, b) => here(b) - here(a) || priorityWeight(b.priority) - priorityWeight(a.priority) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export function sidebarCards(goals: readonly GoalSummary[], sessionID: string, width = 40, maxLines = 12) {
  const active = orderedGoals(goals.filter((g) => !g.archived && !g.terminal && !terminal.has(g.status)), sessionID)
  // Header + (one gap, two selectable lines, progress, optional handoff
  // slug/session pointer) per card; reserve for the largest card shape.
  // reserve a final SELECTABLE manager pointer whenever anything overflows.
  const capacity = Math.max(1, Math.floor((maxLines - 2) / 5))
  const visible = active.slice(0, capacity)
  return {
    total: active.length, hidden: Math.max(0, active.length - visible.length),
    cards: visible.map((goal) => {
      const here = goal.sessionID === sessionID
      const where = !goal.sessionID ? goal.launch?.sessionID === sessionID ? "author here" : "draft" : here ? "here" : "elsewhere"
      const tone: Tone = goal.status === "blocked" ? "error" : ["running", "waiting", "verifying"].includes(goal.status) ? "success" : "warning"
      const steps = goal.steps ?? []
      const plan = steps.length ? `${steps.filter((s) => s.status === "done").length}/${steps.length} plan · ` : ""
      const handoffPointer = goal.handoff?.fromSessionID === sessionID && goal.sessionID
        ? `${fitColumns(goal.slug, Math.max(1, width - 17))} · ses…${goal.sessionID.slice(-8)}` : undefined
      return { key: goalKey(goal), goal, tone, title: fitColumns(goal.title, Math.max(1, width - 2)), description: fitColumns(`${goal.status}${goal.launch?.status === "executing" ? " · starting" : goal.launch?.status === "expired" ? " · review expired" : ""} · ${where}`, Math.max(1, width - 2)), progress: fitColumns(`${goal.handoff?.fromSessionID === sessionID ? "from here · " : ""}${plan}${goal.proven}/${goal.total} proven · ${goal.agent ?? "agent unknown"}`, width), handoffPointer: handoffPointer ? fitColumns(handoffPointer, width) : undefined }
    }),
    pointer: fitColumns(active.length > visible.length ? `+${active.length - visible.length} ${active.length - visible.length === 1 ? "goal" : "goals"} — F9 manager` : "F9 goals manager", width),
  }
}
