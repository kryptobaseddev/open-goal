// A goal is a folder: .opencode/goals/<slug>/ holds the owner's contract
// (goal.yaml) and the plugin's run.json, ledger.jsonl and evidence/.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import { parseContract, type ParseResult } from "../contract/parse"
import type { RunState } from "./state"
import type { AmendmentRequest } from "./amendments"

export type LedgerEvent = { t: number; type: string; [key: string]: unknown }

export class Store {
  readonly goalsDir: string
  constructor(readonly root: string) {
    this.goalsDir = join(root, ".opencode", "goals")
  }

  dir(slug: string) {
    return join(this.goalsDir, slug)
  }

  contractPath(slug: string) {
    return join(this.dir(slug), "goal.yaml")
  }

  slugs(): string[] {
    if (!existsSync(this.goalsDir)) return []
    return readdirSync(this.goalsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.goalsDir, d.name, "goal.yaml")))
      .map((d) => d.name)
      .sort()
  }

  /** T032: the archive tier sits beside goals/ — demoted, never deleted. */
  get archiveDir() {
    return join(this.root, ".opencode", "goals-archive")
  }

  archivedSlugs(): string[] {
    if (!existsSync(this.archiveDir)) return []
    return readdirSync(this.archiveDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.archiveDir, d.name, "goal.yaml")))
      .map((d) => d.name)
      .sort()
  }

  archivedPath(slug: string) {
    return join(this.archiveDir, slug)
  }

  /** Move a goal folder into the archive tier (ledger and evidence travel along). */
  archive(slug: string) {
    mkdirSync(this.archiveDir, { recursive: true })
    renameSync(this.dir(slug), this.archivedPath(slug))
  }

  readContract(slug: string, options: { archived?: boolean } = {}): (ParseResult & { text: string }) | undefined {
    const path = options.archived ? join(this.archivedPath(slug), "goal.yaml") : this.contractPath(slug)
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, "utf8")
    return { ...parseContract(text, { slug }), text }
  }

  /** T108: the raw bytes plus any duplicated object keys. JSON.parse silently
   * keeps the last duplicate, so a hand merge (the reported shape: two
   * "updatedAt", "tokens", "tools", "lastUsageEmit") would otherwise become the
   * run's state without anyone writing it on purpose. */
  readRunRaw(slug: string, options: { archived?: boolean } = {}): { text: string; duplicates: string[] } | undefined {
    const path = join(options.archived ? this.archivedPath(slug) : this.dir(slug), "run.json")
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, "utf8")
    return { text, duplicates: duplicateJsonKeys(text) }
  }

  readRun(slug: string, options: { archived?: boolean } = {}): RunState | undefined {
    const raw = this.readRunRaw(slug, options)
    if (!raw || raw.duplicates.length) return undefined
    try {
      const value = JSON.parse(raw.text)
      return value?.version === 1 ? (value as RunState) : undefined
    } catch {
      return undefined
    }
  }

  /** Keep the exact bytes a corrupt run.json had, beside the run. */
  keepCorruptRun(slug: string, text: string, at = Date.now()): string {
    const dir = this.dir(slug)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `run.json.corrupt-${at}.json`)
    writeFileSync(path, text, { mode: 0o600 })
    return path
  }

  writeRun(state: RunState) {
    const dir = this.dir(state.slug)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, "run.json")
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    const fd = openSync(tmp, "w", 0o600)
    try {
      writeSync(fd, `${JSON.stringify(state, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  }

  writeContractSnapshot(slug: string, runId: string, lock: string, text: string) {
    const dir = join(this.dir(slug), "evidence", runId)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `contract-${lock}.yaml`)
    if (existsSync(path)) return
    this.writeAtomic(path, text)
  }

  /** Redo an accepted generation from a durable host write-ahead receipt.
   * Recovery runs before hooks admit work: consumers cannot see half of a
   * generation. Neither a new run nor an unexpected third lock is overwritten. */
  commitAmendment(request: AmendmentRequest): RunState {
    if (!request.commit || request.status !== "executing") throw new Error("Amendment has no host-recorded acceptance")
    const read = this.readContract(request.slug), state = this.readRun(request.slug)
    const next = parseContract(request.nextText, { slug: request.slug })
    if (!next.contract || next.lock !== request.nextLock) throw new Error("Approved amendment payload is invalid")
    if (!state || state.runId !== request.runId || state.sessionID !== request.targetSessionID) throw new Error("Amendment target identity changed")
    if (state.lock !== request.lock && state.lock !== request.nextLock) throw new Error("Amendment run lock conflicts with a different generation")
    if (!read || read.lock !== request.lock && read.lock !== request.nextLock) throw new Error("Amendment disk contract changed outside the reviewed generation")
    if (request.commit.state.lock !== request.nextLock || request.commit.state.runId !== state.runId) throw new Error("Invalid host write-ahead state")
    const result = state.lock === request.nextLock ? state : request.commit.state
    this.writeContractSnapshot(request.slug, request.runId, request.lock, read.lock === request.lock ? read.text : this.lockedSnapshot(request.slug, request.runId, request.lock))
    this.writeContractSnapshot(request.slug, request.runId, request.nextLock, request.nextText)
    if (read.lock !== request.nextLock) this.writeAtomic(this.contractPath(request.slug), request.nextText)
    if (state.lock !== request.nextLock) this.writeRun(result)
    const generation = result.amendments.filter((a) => a.status === "accepted").length
    this.evidence(request.slug, request.runId, `amendment-${generation}-${request.id}`, {
      decisionId: request.id, generation, oldLock: request.lock, newLock: request.nextLock,
      by: request.appliedBy ?? "owner", ...(request.policyClasses ? { policyClasses: request.policyClasses } : {}), at: request.commit.acceptedAt, rationale: request.rationale,
      ...request.diff, contract: request.nextText,
    })
    if (!this.recent(request.slug, 1000).some((e) => e.type === "amended" && e.decisionId === request.id))
      this.ledger(request.slug, { type: "amended", decisionId: request.id, generation, oldLock: request.lock, newLock: request.nextLock, summary: request.diff.summary, by: request.appliedBy ?? "owner", ...(request.policyClasses ? { policyClasses: request.policyClasses } : {}), ...(request.recovery ? { recovery: true } : {}) })
    return result
  }

  /** Owner-chosen divergence restore: keep the divergent disk bytes as
   * evidence, then write the locked generation's exact bytes back. */
  restoreLocked(slug: string, runId: string, lock: string, discarded: { text: string; lock: string }): string {
    const locked = this.lockedSnapshot(slug, runId, lock)
    const dir = join(this.dir(slug), "evidence", runId)
    mkdirSync(dir, { recursive: true })
    const kept = join(dir, `divergent-${discarded.lock}-${Date.now()}.yaml`)
    this.writeAtomic(kept, discarded.text)
    const current = this.readContract(slug)
    if (!current || current.lock !== discarded.lock) throw new Error("Disk contract changed again during restore; nothing written")
    this.writeAtomic(this.contractPath(slug), locked)
    return kept
  }

  lockedText(slug: string, runId: string, lock: string): string { return this.lockedSnapshot(slug, runId, lock) }

  private lockedSnapshot(slug: string, runId: string, lock: string): string {
    const keyed = join(this.dir(slug), "evidence", runId, `contract-${lock}.yaml`)
    const first = join(this.dir(slug), "evidence", runId, "contract.yaml")
    const text = readFileSync(existsSync(keyed) ? keyed : first, "utf8")
    if (parseContract(text, { slug }).lock !== lock) throw new Error("Prior locked amendment snapshot is unavailable")
    return text
  }

  private writeAtomic(path: string, text: string) {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    const fd = openSync(tmp, "wx", 0o600)
    try { writeSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, path)
  }

  /** The last n ledger events, oldest first; tolerant of a torn final line. */
  recent(slug: string, n: number): LedgerEvent[] {
    const path = join(this.dir(slug), "ledger.jsonl")
    if (!existsSync(path)) return []
    const lines = readFileSync(path, "utf8").trimEnd().split("\n")
    const out: LedgerEvent[] = []
    for (const line of lines.slice(-n)) {
      try {
        out.push(JSON.parse(line) as LedgerEvent)
      } catch {
        // a half-written trailing line is skipped, never fatal
      }
    }
    return out
  }

  ledger(slug: string, event: Omit<LedgerEvent, "t"> & { t?: number }, options: { archived?: boolean } = {}) {
    const dir = options.archived ? this.archivedPath(slug) : this.dir(slug)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ t: Date.now(), ...event })}\n`, { mode: 0o600 })
  }

  readLedger(slug: string, limit = 50): LedgerEvent[] {
    const path = join(this.dir(slug), "ledger.jsonl")
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LedgerEvent]
        } catch {
          return []
        }
      })
  }

  evidence(slug: string, runId: string, name: string, data: unknown): string {
    const dir = join(this.dir(slug), "evidence", runId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${name}.json`)
    const fd = openSync(file, "w", 0o600)
    try {
      writeSync(fd, `${JSON.stringify(data, null, 2)}\n`)
    } finally {
      closeSync(fd)
    }
    return file
  }
}

/** Duplicated keys inside any JSON object, as dotted paths. A tiny scanner,
 * because JSON itself cannot report them. */
export function duplicateJsonKeys(text: string): string[] {
  const duplicates: string[] = []
  const stack: Array<{ keys: Set<string>; path: string }> = []
  let i = 0, pending = ""
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '"') {
      let j = i + 1, raw = ""
      while (j < text.length) {
        if (text[j] === "\\") { raw += text[j + 1] ?? ""; j += 2; continue }
        if (text[j] === '"') break
        raw += text[j]
        j++
      }
      i = j + 1
      // A string is a key when the next non-space character is ':'.
      let k = i
      while (k < text.length && /\s/.test(text[k]!)) k++
      if (text[k] === ":" && stack.length) {
        const level = stack[stack.length - 1]!
        const path = level.path ? `${level.path}.${raw}` : raw
        if (level.keys.has(raw)) duplicates.push(path)
        level.keys.add(raw)
        pending = path
      }
      continue
    }
    if (ch === "{") { stack.push({ keys: new Set(), path: pending }); pending = ""; i++; continue }
    if (ch === "}") { stack.pop(); pending = ""; i++; continue }
    if (ch === "," || ch === ":" || ch === "[" || ch === "]") { if (ch === ",") pending = ""; i++; continue }
    i++
  }
  return [...new Set(duplicates)]
}
