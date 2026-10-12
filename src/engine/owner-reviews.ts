import { randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export type ReviewRequest = {
  id: string
  sessionID: string
  slug: string
  lock: string
  title: string
  question: string
  createdAt: number
  expiresAt: number
  /** Target-bound lifecycle decisions have no clock expiry; legacy records
   * and sealed launch approvals remain timed by default. */
  expiryPolicy?: "time" | "target"
  issuerPID: number
  status: "pending" | "interrupted" | "executing" | "succeeded" | "rejected" | "commented" | "cancelled" | "expired" | "failed"
  formID?: string
  fieldKey?: string
  choiceValues?: Record<string, string>
  result?: string
  comment?: string
  /** Authenticated owner-message identity, when this is a direct owner command. */
  ownerMessageID?: string
}
type ReviewData<T> = { version: 1; requests: Record<string, T> }
export type ReviewChoice = { value: string; label: string; description: string }

/** Clock expiry is reserved for explicitly timed/legacy reviews. */
export function reviewExpired(request: Pick<ReviewRequest, "expiresAt" | "expiryPolicy">, now = Date.now()): boolean {
  return request.expiryPolicy !== "target" && request.expiresAt < now
}

/** Interpret only the values actually offered in the bound field. Internal
 * aliases typed as custom commentary are not selectable owner consent. */
export function selectedReviewChoice(request: ReviewRequest, choices: readonly ReviewChoice[], answer: Record<string, unknown>): ReviewChoice | undefined {
  const value = request.fieldKey ? answer[request.fieldKey] : undefined
  return typeof value === "string" ? choices.find((c) => request.choiceValues?.[c.value] === value) : undefined
}

export const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error: any) { return error?.code === "EPERM" }
}

/** The host-owned sidecar is outside individual runs, so authoring sessions
 * can recover approvals before any run exists. A short cross-process lock
 * makes reservation one-use even when two servers share a project folder. */
export class OwnerReviewStore<T extends ReviewRequest> {
  constructor(readonly file: string, readonly choices: readonly ReviewChoice[]) {}
  protected reviewChoices(_request: T): readonly ReviewChoice[] { return this.choices }

  private read(): ReviewData<T> {
    if (!existsSync(this.file)) return { version: 1, requests: {} }
    const data = JSON.parse(readFileSync(this.file, "utf8"))
    if (data?.version !== 1 || !data.requests || Array.isArray(data.requests)) throw new Error("Owner decision store is invalid; refusing consent")
    return data
  }
  protected mutate<R>(fn: (data: ReviewData<T>) => R): R {
    mkdirSync(dirname(this.file), { recursive: true })
    const lock = `${this.file}.lock`
    // Do not steal an active lock. An abandoned lock can be recovered only
    // after its recorded process has exited, never merely because it is old.
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8"))
      if (Number.isInteger(pid) && pid > 0 && !processAlive(pid)) unlinkSync(lock)
    }
    const fd = openSync(lock, "wx", 0o600)
    try {
      writeFileSync(fd, String(process.pid))
      const data = this.read()
      const result = fn(data)
      const tmp = `${this.file}.${randomUUID()}.tmp`
      const output = openSync(tmp, "wx", 0o600)
      try { writeFileSync(output, `${JSON.stringify(data, null, 2)}\n`); fsyncSync(output) } finally { closeSync(output) }
      renameSync(tmp, this.file)
      return result
    } finally { closeSync(fd); unlinkSync(lock) }
  }
  all(sessionID?: string): T[] {
    return Object.values(this.read().requests).filter((p) => !sessionID || p.sessionID === sessionID)
  }
  get(id: string): T | undefined { return this.read().requests[id] }
  create(input: Omit<T, "id" | "status">): T {
    return this.mutate((data) => {
      for (const p of Object.values(data.requests))
        if (p.sessionID === input.sessionID && ["pending", "interrupted"].includes(p.status)) p.status = "cancelled"
      const p = { ...input, id: randomUUID(), status: "pending" } as T
      // The nonce is in the displayed question and must match the actual
      // question field. A matching label in an unrelated form is not enough.
      p.question += `\nDecision: ${p.id}`
      data.requests[p.id] = p
      return p
    })
  }
  bind(form: { id: string; sessionID: string; fields?: Array<{ key?: string; title?: string; description?: string; options?: Array<{ value: string; label: string }> }> }): T | undefined {
    const matches = (p: T) => {
      const choices = this.reviewChoices(p)
      return p.sessionID === form.sessionID && p.status === "pending" && !p.formID && !reviewExpired(p) && form.fields?.length === 1 && form.fields.some((f) => !!f.key && (f.title === p.question || f.description === p.question) && f.options?.length === choices.length && choices.every((c) => f.options?.some((o) => o.label === c.label && (o.value === c.value || o.value === c.label))))
    }
    // Most forms have nothing to do with this store. Do not fsync an empty
    // sidecar on every unrelated form; revalidate under the lock if matched.
    if (!this.all(form.sessionID).some(matches)) return undefined
    return this.mutate((data) => {
      const p = Object.values(data.requests).find(matches)
      if (!p) return undefined
      if (p.issuerPID !== process.pid && processAlive(p.issuerPID)) return undefined
      p.formID = form.id
      const field = form.fields?.find((f) => f.title === p.question || f.description === p.question)
      p.fieldKey = field?.key
      p.choiceValues = Object.fromEntries(this.reviewChoices(p).map((c) => [c.value, field!.options!.find((o) => o.label === c.label)!.value]))
      return p
    })
  }
  byForm(sessionID: string, formID: string): T | undefined {
    return this.all(sessionID).find((p) => p.formID === formID)
  }
  update(id: string, change: Partial<Pick<ReviewRequest, "status" | "result" | "comment">>): T {
    return this.mutate((data) => {
      const p = data.requests[id]
      if (!p) throw new Error("Unknown owner decision")
      Object.assign(p, change)
      return p
    })
  }
  reopenForm(id: string): T | undefined {
    return this.mutate((data) => {
      const p = data.requests[id]
      if (!p || !["pending", "interrupted"].includes(p.status)) return undefined
      p.status = "pending"
      delete p.formID
      delete p.fieldKey
      delete p.choiceValues
      return p
    })
  }
  interruptForm(id: string): T | undefined {
    return this.mutate((data) => {
      const p = data.requests[id]
      if (!p || p.status !== "pending") return undefined
      p.status = "interrupted"
      p.result = "The form was dismissed or interrupted by the host; no operation was authorized."
      delete p.formID
      delete p.fieldKey
      delete p.choiceValues
      return p
    })
  }
  reserve(id: string): T | undefined {
    return this.mutate((data) => {
      const p = data.requests[id]
      if (!p || p.status !== "pending") return undefined
      // Different processes can create separate proposals for the same real
      // message. Enforce consumption under THIS cross-process lock, not only
      // with an earlier all() read in the caller.
      if (p.ownerMessageID && Object.values(data.requests).some((other) => other.id !== id
        && other.ownerMessageID === p.ownerMessageID && ["executing", "succeeded", "failed"].includes(other.status))) return undefined
      if (reviewExpired(p)) { p.status = "expired"; return undefined }
      if (p.issuerPID !== process.pid && processAlive(p.issuerPID)) return undefined
      p.status = "executing"
      p.issuerPID = process.pid
      return p
    })
  }
}
