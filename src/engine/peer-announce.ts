// v0.8.0 — when the loop may tell peers it is available.
//
// Owner policy: announce on an idle transition, always, but never nag. The two
// brakes are mechanical:
//   1. one outstanding announcement at a time — while a peer has not answered,
//      another announcement is spam, not availability;
//   2. a cooldown floor after the last announcement — a rapid sequence of idle
//      transitions (complete → resume → complete) is one idle period, not five.
//
// Pure. The transport (AgentMBX) lives in peer-transport.ts and is injected, so
// the unit suite never touches the network.

export type AnnounceState = {
  /** When this run last announced. */
  lastAt?: number
  /** The announcement still waiting for an answer, if any. */
  outstanding?: { id: string; at: number }
}

export type AnnounceDecision =
  | { due: true }
  | { due: false; reason: "outstanding" | "cooldown" }

export function announceDue(state: AnnounceState, now: number, cooldownMs: number): AnnounceDecision {
  if (state.outstanding) return { due: false, reason: "outstanding" }
  if (state.lastAt !== undefined && now - state.lastAt < cooldownMs) return { due: false, reason: "cooldown" }
  return { due: true }
}

/** What a peer reads. Short, factual, no task invention and no secrets. */
export function announcementText(input: { project: string; slug: string; taskId?: string }): string {
  const task = input.taskId ? ` (CLEO ${input.taskId})` : ""
  return `Available for work. Project: ${input.project}. Last goal: ${input.slug}${task}. Reply with a task id or a one-line work request; I will treat it as a candidate, not as consent.`
}

export type PeerReply = {
  id: string
  from: string
  text: string
  at: number
  project?: string
}

/** The injectable transport. The policy above never imports this. */
export type PeerChannel = {
  announce(input: { text: string; sessionID?: string }): Promise<{ id: string } | undefined>
  replies(input: { since: number; sessionID?: string }): Promise<PeerReply[]>
}

/**
 * A reply becomes CANDIDATE work, never an instruction. A task id in the text
 * is recorded so the next-work decision can offer it; the body is kept verbatim
 * and labelled as a peer claim.
 */
export function candidateFromReply(reply: PeerReply, currentProject: string) {
  const task = /\bT\d{1,7}\b/.exec(reply.text)?.[0]
  const firstLine = reply.text.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "(empty reply)"
  return {
    source: "peer" as const,
    project: reply.project ?? currentProject,
    ...(task ? { taskId: task } : {}),
    title: firstLine.slice(0, 200),
    from: reply.from,
    messageId: reply.id,
    at: reply.at,
  }
}
