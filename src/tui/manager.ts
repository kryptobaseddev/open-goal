import type { GoalSummary, GoalTarget, ManageAction } from "../rpc"
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
  const here = (g: GoalSummary) => !g.archived ? g.sessionID === sessionID ? 2 : g.handoff?.fromSessionID === sessionID ? 1 : 0 : 0
  return [...goals].sort((a, b) => here(b) - here(a) || priorityWeight(b.priority) - priorityWeight(a.priority) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export function sidebarCards(goals: readonly GoalSummary[], sessionID: string, width = 40, maxLines = 12) {
  const active = orderedGoals(goals.filter((g) => !g.archived && !g.terminal && !terminal.has(g.status)), sessionID)
  // Header + (one gap, two selectable lines, one progress line) per card;
  // reserve a final SELECTABLE manager pointer whenever anything overflows.
  const capacity = Math.max(1, Math.floor((maxLines - 2) / 4))
  const visible = active.slice(0, capacity)
  return {
    total: active.length, hidden: Math.max(0, active.length - visible.length),
    cards: visible.map((goal) => {
      const here = goal.sessionID === sessionID
      const where = !goal.sessionID ? "draft" : here ? "here" : "elsewhere"
      const tone: Tone = goal.status === "blocked" ? "error" : ["running", "waiting", "verifying"].includes(goal.status) ? "success" : "warning"
      return { key: goalKey(goal), goal, tone, title: fitColumns(goal.title, Math.max(1, width - 2)), description: fitColumns(`${goal.status} · ${where}`, Math.max(1, width - 2)), progress: fitColumns(`${goal.handoff?.fromSessionID === sessionID ? "from here · " : ""}${goal.proven}/${goal.total} proven · ${goal.agent ?? "agent unknown"}`, width) }
    }),
    pointer: fitColumns(active.length > visible.length ? `+${active.length - visible.length} ${active.length - visible.length === 1 ? "goal" : "goals"} — F9 manager` : "F9 goals manager", width),
  }
}
