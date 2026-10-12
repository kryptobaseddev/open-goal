import { OwnerReviewStore, processAlive, type ReviewRequest } from "./owner-reviews"
export { processAlive } from "./owner-reviews"

export type LaunchActivity = { phase: "starting" | "rehearsal" | "check"; since: number; detail: string; completed: number; total: number; checkId?: string }
export type LaunchRequest = ReviewRequest & { fresh: boolean; activity?: LaunchActivity; updatedAt?: number }
/** Admission is not a run: expose the host receipt without inventing running state. */
export type LaunchView = Pick<LaunchRequest, "slug" | "sessionID" | "lock" | "fresh" | "status" | "result" | "activity" | "updatedAt" | "expiresAt"> & { decisionId: string }
export function launchView(p: LaunchRequest): LaunchView {
  return { decisionId: p.id, slug: p.slug, sessionID: p.sessionID, lock: p.lock, fresh: p.fresh, status: p.status, expiresAt: p.expiresAt,
    ...(p.result ? { result: p.result } : {}), ...(p.activity ? { activity: p.activity } : {}), updatedAt: p.updatedAt ?? p.createdAt }
}
export const launchChoices = [
  { value: "launch", label: "Start goal now (Recommended)", description: "Launch exactly this validated contract in the displayed session mode." },
  { value: "revise", label: "Revise this goal", description: "Return to the interview with changes; nothing launches." },
  { value: "save", label: "Save for later", description: "Keep the validated draft; nothing launches." },
] as const

export class LaunchStore extends OwnerReviewStore<LaunchRequest> {
  constructor(file: string) { super(file, launchChoices) }

  override update(id: string, change: Partial<Pick<ReviewRequest, "status" | "result" | "comment">>): LaunchRequest {
    return this.mutate((data) => {
      const p = data.requests[id]
      if (!p) throw new Error("Unknown launch decision")
      Object.assign(p, change)
      p.updatedAt = Date.now()
      if (p.status !== "executing") delete p.activity
      return p
    })
  }

  override reserve(id: string): LaunchRequest | undefined {
    return this.mutate((data) => {
      const p = data.requests[id]
      if (!p || p.status !== "pending") return undefined
      if (p.ownerMessageID && Object.values(data.requests).some((other) => other.id !== id && other.ownerMessageID === p.ownerMessageID && ["executing", "succeeded", "failed"].includes(other.status))) return undefined
      if (p.expiresAt < Date.now()) { p.status = "expired"; return undefined }
      if (p.issuerPID !== process.pid && processAlive(p.issuerPID)) return undefined
      // Reserve the actual draft/session too: separate native reviews must
      // not both rehearse or create fresh sessions for one admission.
      if (Object.values(data.requests).some((other) => other.id !== id && other.status === "executing" && (other.slug === p.slug || other.sessionID === p.sessionID))) return undefined
      p.status = "executing"
      p.issuerPID = process.pid
      p.updatedAt = Date.now()
      return p
    })
  }

  activity(id: string, activity?: LaunchActivity): LaunchRequest {
    return this.mutate((data) => {
      const p = data.requests[id]
      if (!p) throw new Error("Unknown launch decision")
      if (activity && p.status !== "executing") throw new Error("Launch admission is not executing")
      p.updatedAt = Date.now()
      if (activity) p.activity = activity
      else delete p.activity
      return p
    })
  }
}
