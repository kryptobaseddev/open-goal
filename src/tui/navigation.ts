import type { Plugin } from "@opencode/plugin/tui"

/** Explicit navigation only. Selection/expansion must never call this. V2
 * opens without focus, then focuses by SESSION id; no invented tab IDs. */
export function openGoalSession(ui: Plugin.Context["ui"], sessionID: string): "tab" | "route" {
  try {
    if (ui.tabs?.enabled() && ui.tabs.open(sessionID) && ui.tabs.focus(sessionID)) return "tab"
  } catch { /* Disabled/unavailable tabs use the verified router fallback. */ }
  ui.router.navigate({ type: "session", sessionID })
  return "route"
}
