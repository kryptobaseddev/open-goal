// A goal is a folder: <goals>/<slug>/ holds the owner's contract (goal.yaml)
// and the plugin's run.json, ledger.jsonl and evidence/. Where <goals> lives is
// a project setting resolved once in store-root.ts; today, with nothing
// configured, it is still `.opencode/goals`, so existing projects are untouched.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"
import { parseContract, type ParseResult } from "../contract/parse"
import type { RunState, RunWriter } from "./state"
import type { AmendmentRequest } from "./amendments"
import { resolveStoreRoots, type StoreRoots } from "./store-root"

export type LedgerEvent = { t: number; type: string; [key: string]: unknown }

/** T172: one generation of a run row, as a refusal receipt names it. */
export type RunGeneration = {
  revision: number
  runId: string
  lock: string
  status: string
  updatedAt: number
  writtenAt?: number
  writtenBy?: RunWriter
}

export type RunWriteOutcome =
  | { written: true; revision: number }
  | {
      written: false
      /** True the first time this process refuses this (writer, disk) pair. */
      journalled: boolean
      /** `stale`: same run, disk generation ahead. `superseded`: another run owns the row. */
      reason: "stale" | "superseded"
      mine: RunGeneration
      disk: RunGeneration
    }

export const runGeneration = (state: Pick<RunState, "revision" | "runId" | "lock" | "status" | "updatedAt" | "writtenAt" | "writtenBy">): RunGeneration => ({
  revision: state.revision ?? 0,
  runId: state.runId,
  lock: state.lock,
  status: state.status,
  updatedAt: state.updatedAt,
  ...(state.writtenAt !== undefined ? { writtenAt: state.writtenAt } : {}),
  ...(state.writtenBy ? { writtenBy: state.writtenBy } : {}),
})

/** The highest revision mentioned by a file we cannot parse. Used ONLY to keep
 * the counter monotonic across a corruption repair — never to refuse a write. */
function revisionsInText(text: string): number {
  let max = 0
  for (const match of text.matchAll(/"revision"\s*:\s*(\d+)/g)) max = Math.max(max, Number(match[1]))
  return Number.isFinite(max) ? max : 0
}

function parseRunText(text: string): RunState | undefined {
  try {
    const value = JSON.parse(text)
    return value?.version === 1 ? (value as RunState) : undefined
  } catch {
    return undefined
  }
}

export class Store {
  readonly goalsDir: string
  readonly archiveDir: string
  readonly roots: StoreRoots
  /** T172: this process's identity as a run writer. */
  private readonly writerStartedAt = Date.now() - Math.round(process.uptime() * 1000)
  /** T172: one durable receipt per (writer, disk) generation pair per process,
   * so a refused burst cannot fill the ledger with the same refusal. */
  private readonly refused = new Set<string>()
  private readonly logLine: (line: string) => void
  constructor(readonly root: string, roots: StoreRoots = resolveStoreRoots(root), options: { log?: (line: string) => void } = {}) {
    this.roots = roots
    this.goalsDir = roots.goals
    this.archiveDir = roots.archive
    this.logLine = options.log ?? ((line) => process.stderr.write(`${line}\n`))
  }

  dir(slug: string) {
    return join(this.goalsDir, slug)
  }

  /**
   * T150: the folder an existing goal actually lives in — the active store or,
   * for a pre-flip run, the readable legacy store. Reads and run-state writes
   * follow the bytes they belong to, so resuming a legacy run never silently
   * copies it into the new store; a brand-new slug resolves to the active store.
   */
  locate(slug: string, options: { archived?: boolean } = {}): string {
    const base = options.archived ? this.archiveDir : this.goalsDir
    const legacyBase = options.archived ? this.roots.legacy.archive : this.roots.legacy.goals
    const active = join(base, slug)
    if (base === legacyBase) return active
    if (existsSync(join(active, "goal.yaml")) || existsSync(join(active, "run.json"))) return active
    const legacy = join(legacyBase, slug)
    if (existsSync(join(legacy, "goal.yaml")) || existsSync(join(legacy, "run.json"))) return legacy
    return active
  }

  contractPath(slug: string) {
    return join(this.locate(slug), "goal.yaml")
  }

  /** Folder names under one goals directory (a folder needs a goal.yaml). */
  private folderSlugs(dir: string): string[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "goal.yaml")))
      .map((d) => d.name)
  }

  slugs(): string[] {
    return [...new Set([...this.folderSlugs(this.goalsDir), ...this.folderSlugs(this.roots.legacy.goals)])].sort()
  }

  /** T032: the archive tier sits beside goals/ — demoted, never deleted. */
  archivedSlugs(): string[] {
    return [...new Set([...this.folderSlugs(this.archiveDir), ...this.folderSlugs(this.roots.legacy.archive)])].sort()
  }

  archivedPath(slug: string) {
    return this.locate(slug, { archived: true })
  }

  /** Move a goal folder into the archive tier that sits beside its own store
   *  (ledger and evidence travel along). A legacy run archives beside the
   *  legacy store, so its history stays together. */
  archive(slug: string) {
    const from = this.locate(slug)
    const legacySource = from === join(this.roots.legacy.goals, slug) && this.roots.legacy.goals !== this.goalsDir
    const to = legacySource ? join(this.roots.legacy.archive, slug) : join(this.archiveDir, slug)
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
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
    const path = join(options.archived ? this.archivedPath(slug) : this.locate(slug), "run.json")
    if (!existsSync(path)) return undefined
    const text = readFileSync(path, "utf8")
    return { text, duplicates: duplicateJsonKeys(text) }
  }

  readRun(slug: string, options: { archived?: boolean } = {}): RunState | undefined {
    const raw = this.readRunRaw(slug, options)
    if (!raw || raw.duplicates.length) return undefined
    return parseRunText(raw.text)
  }

  /** Keep the exact bytes a corrupt run.json had, beside the run. */
  keepCorruptRun(slug: string, text: string, at = Date.now()): string {
    const dir = this.locate(slug)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `run.json.corrupt-${at}.json`)
    writeFileSync(path, text, { mode: 0o600 })
    return path
  }

  /**
   * T172: write the run row, but never over a newer VALID generation.
   *
   * This is a real defect, seen twice in a sibling project: a dying engine's
   * final `run.json` write landed after the owner had repaired the file and
   * undid the repair. `revision` is a monotonic generation stamped by every
   * accepted write, so the snapshot a writer holds names the generation it has
   * seen. A write is refused when the disk row it would replace is valid and
   *
   *   - belongs to another run (a successor already took the row), or
   *   - carries a higher revision (this writer's snapshot is behind).
   *
   * A malformed or partially-written disk file is NOT newer: it is the
   * existing corruption path, and the repair must still write. A writer that is
   * ahead (or level with) the disk is forward progress and writes normally.
   *
   * Refusal leaves the disk bytes untouched and journals one `stale-write`
   * receipt naming both generations; nothing is a silent no-op.
   *
   * `replace` is the explicit new-run path (a different runId deliberately
   * takes the row over); only the host's start path passes it.
   */
  writeRun(state: RunState, options: { replace?: boolean } = {}): RunWriteOutcome {
    const slug = state.slug
    const raw = this.readRunRaw(slug)
    const disk = raw && !raw.duplicates.length ? parseRunText(raw.text) : undefined
    const mine = runGeneration(state)
    if (disk && !options.replace) {
      if (disk.runId !== state.runId) return this.refuseStale(state, mine, runGeneration(disk), "superseded")
      if ((disk.revision ?? 0) > (state.revision ?? 0)) return this.refuseStale(state, mine, runGeneration(disk), "stale")
    }
    // Preserve monotonicity across a corruption repair: the unreadable bytes may
    // still name a generation, and the repair must not roll the counter back
    // (which would let a demonstrably old writer look current again).
    const corrupt = raw && !disk ? revisionsInText(raw.text) : 0
    const next = Math.max(state.revision ?? 0, disk?.revision ?? 0, corrupt) + 1
    const now = Date.now()
    const writtenBy: RunWriter = { pid: process.pid, startedAt: this.writerStartedAt, sessionID: state.sessionID }
    const dir = this.locate(slug)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, "run.json")
    const tmp = `${path}.${process.pid}.${now}.tmp`
    const fd = openSync(tmp, "w", 0o600)
    try {
      writeSync(fd, `${JSON.stringify({ ...state, revision: next, writtenAt: now, writtenBy }, null, 2)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    // One more read just before the rename closes all but the final instant: a
    // valid newer generation that landed between the check above and this write
    // still wins. `state` is left exactly as it was until the rename succeeds.
    const again = this.readRun(slug)
    if (again && !options.replace && (again.runId !== state.runId || (again.revision ?? 0) > (state.revision ?? 0))) {
      try { unlinkSync(tmp) } catch { /* already gone */ }
      return this.refuseStale(state, mine, runGeneration(again), again.runId !== state.runId ? "superseded" : "stale")
    }
    renameSync(tmp, path)
    state.revision = next
    state.writtenAt = now
    state.writtenBy = writtenBy
    return { written: true, revision: next }
  }

  /** Journal (once per pair per process), log and name both generations. */
  private refuseStale(state: RunState, mine: RunGeneration, disk: RunGeneration, reason: "stale" | "superseded"): RunWriteOutcome {
    const key = `${state.slug}|${mine.runId}|${mine.revision}|${disk.runId}|${disk.revision}|${disk.writtenAt ?? 0}|${disk.writtenBy?.pid ?? "-"}`
    const journalled = !this.refused.has(key)
    if (journalled) {
      this.refused.add(key)
      this.ledger(state.slug, {
        type: "stale-write", slug: state.slug, runId: state.runId, reason,
        pid: process.pid, writerStartedAt: this.writerStartedAt, sessionID: state.sessionID,
        mine, disk, action: "disk-left-untouched",
      })
      this.logLine(`open-goal: refused a ${reason} run.json write for "${state.slug}" (pid ${process.pid}, session ${state.sessionID}): this writer holds generation ${mine.revision} (lock ${mine.lock.slice(0, 12)}), disk is generation ${disk.revision} (lock ${disk.lock.slice(0, 12)}, writer pid ${disk.writtenBy?.pid ?? "unknown"}). The disk bytes were left untouched.`)
    }
    return { written: false, journalled, reason, mine, disk }
  }

  writeContractSnapshot(slug: string, runId: string, lock: string, text: string) {
    const dir = join(this.locate(slug), "evidence", runId)
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
    // T172: the commit re-read the run above and bound this exact runId/lock.
    // Carry that just-read generation so a legitimate amendment commit is
    // forward progress even when its write-ahead snapshot predates it.
    result.revision = Math.max(result.revision ?? 0, state.revision ?? 0)
    this.writeContractSnapshot(request.slug, request.runId, request.lock, read.lock === request.lock ? read.text : this.lockedSnapshot(request.slug, request.runId, request.lock))
    this.writeContractSnapshot(request.slug, request.runId, request.nextLock, request.nextText)
    if (read.lock !== request.nextLock) this.writeAtomic(this.contractPath(request.slug), request.nextText)
    if (state.lock !== request.nextLock) {
      const write = this.writeRun(result)
      if (!write.written) throw new Error(`The run row on disk is a newer generation (${write.disk.revision}) than this accepted amendment (${write.mine.revision}); the accepted generation was not written over it`)
    }
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
    const dir = join(this.locate(slug), "evidence", runId)
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
    const keyed = join(this.locate(slug), "evidence", runId, `contract-${lock}.yaml`)
    const first = join(this.locate(slug), "evidence", runId, "contract.yaml")
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
    const path = join(this.locate(slug), "ledger.jsonl")
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
    const dir = options.archived ? this.archivedPath(slug) : this.locate(slug)
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ t: Date.now(), ...event })}\n`, { mode: 0o600 })
  }

  readLedger(slug: string, limit = 50): LedgerEvent[] {
    const path = join(this.locate(slug), "ledger.jsonl")
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
    const dir = join(this.locate(slug), "evidence", runId)
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
