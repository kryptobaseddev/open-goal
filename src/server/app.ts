// The goal engine: owns run state for this location, drives continuations from
// session.execution.* events, injects the contract into every request, and runs
// verification. Spike findings referenced as S1-S9 live in docs/spikes.md.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Plugin } from "@opencode/plugin"
import { formatIssues, parseContract } from "../contract/parse"
import { renderSystemBlock, renderTailNote, triggerText, type TailKind } from "../contract/render"
import type { Contract } from "../contract/types"
import { isHostCheck } from "../contract/types"
import { GoalRpc, type GoalSummary, type GoalTarget, type GoalView, type ManageAction } from "../rpc"
import { account, budgetUse, initialRun, isActive, isTerminal, modelCan, ownerCan, setStatus, type Handoff, type PendingKind, type RunState, type Status } from "../engine/state"
import { Store } from "../engine/store"
import { Registry, byPriorityThenRecency } from "../engine/registry"
import { LaunchStore, launchChoices, launchView, processAlive, type LaunchActivity, type LaunchRequest } from "../engine/launches"
import { amendmentDiff, amendedState } from "../engine/amendment"
import { AmendmentStore, recoveryChoices, type AmendmentRequest } from "../engine/amendments"
import { classifyChange, policyAllows } from "../engine/policy"
import { selectedReviewChoice, reviewExpired } from "../engine/owner-reviews"
import { DecisionStore, decisionChoices, shouldReaskDecision, type DecisionKind, type DecisionRequest, type DecisionTarget } from "../engine/decisions"
import { projectInventory } from "../engine/inventory"
import { admissionNote } from "../engine/similarity"
import { goalHelp } from "./help"
import { decide } from "../engine/loop"
import { restartDecision } from "../engine/interrupt-policy"
import { staleDecision } from "../engine/stale-decisions"
import { cleoFacts, cleoHealth, cleoHealthReport, cleoLinkEvent, CLEO_INIT_COMMAND, CLEO_INSTALL_COMMAND, type Runner } from "../engine/cleo-link"
import { bridgeReport, acsByGateFromProves, junitToVitestJson, runBridge, sha256Hex, suggestLinkedTasks, type BridgeReport, type CleoRun, type TaskOutcome } from "../engine/cleo-bridge"
import type { CleoTaskLink } from "../contract/types"
import { buildPostGoalSummary } from "../summary/build"
import { completionAudit } from "../summary/audit"
import { M, renderMessage, type EngineMessage } from "./messages"
import { directGoalCommand } from "./intent"
import { ownerAmendmentMessage, ownerLaunchMessage, ownerResumeMessage } from "../engine/owner-intent"
import { nextWork, type WorkCandidate } from "../engine/next-work"
import { candidateFromReply, announcementText, type PeerChannel } from "../engine/peer-announce"
import { createPeerChannel } from "../engine/peer-transport"
import { readyCleoTask, continuationContractYaml, continuationSlug } from "../engine/continue-work"
import { buildHandoff, handoffDigest } from "../engine/handoff"

/** Decisions whose native form has already been presented in THIS process.
 *  Kept at module scope so a re-run of `setup` (which creates a new GoalApp)
 *  cannot silently ask again; a real process reload clears it, which is the
 *  documented "reload restores it once" path. */
const askedDecisionIds = new Set<string>()

/** Spawn the cleo CLI with a hard timeout; all failures resolve safely. */const defaultRunner: Runner = (command, args, timeoutMs = 2500) =>
  new Promise((resolve) => {
    const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "ignore" })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    Promise.all([new Response(child.stdout).text(), child.exited])
      .then(([stdout, exit]) => resolve({ stdout, exit: Number(exit) }))
      .catch(() => resolve({ stdout: "", exit: 1 }))
      .finally(() => clearTimeout(timer))
  })
import { ascendingId, runId as newRunId } from "../util/ids"
import { fingerprint, gitDigest, headCommit, topLevel } from "../util/git"
import { runHostCheck, verifyClaim, type VerifierVerdict } from "../verify/pipeline"
import { runShell } from "../util/shell"
import { captureArtifactHashes, type RuntimeProvenance } from "../verify/artifact"

type Context = Plugin.Context

export const LAUNCH_LABEL = "Start goal now"

export type Options = {
  /** Hard ceiling on goal-driven turns when the contract sets no turn budget. */
  backstopTurns: number
  cooldownMs: number
  /** Consecutive turns without a worktree or criterion change before pausing. */
  stallTurns: number
  /** No-progress count at which the continuation switches to the recovery prompt. */
  recoveryAt: number
  blockerRepeats: number
  maxPromptFailures: number
  verifierAgent: string
  /** Verifier round budget in ms (each of the 2 rounds gets this; 240s default; config-overridable). */
  verifierTimeoutMs: number
  /** T110: the floor a round budget is clamped to. 60s by default, config-overridable so a host test can exercise verdict handling far below the 60s floor. */
  verifierMinRoundMs: number
  /** Grace after the per-round budget during which a late goal_verdict counts. */
  verifierGraceMs: number
  liveChecks: boolean
  launchApprovalMs: number
}

export const DEFAULTS: Options = {
  backstopTurns: 200,
  cooldownMs: 1500,
  stallTurns: 3,
  recoveryAt: 2,
  blockerRepeats: 3,
  maxPromptFailures: 3,
  verifierAgent: "goal-verifier",
  verifierTimeoutMs: 240_000,
  verifierMinRoundMs: 60_000,
  verifierGraceMs: 30_000,
  liveChecks: true,
  launchApprovalMs: 10 * 60_000,
}

type Loaded = { contract: Contract; lock: string; text: string }
type SessionFacts = { busy: boolean; forms: Set<string>; launchApprovedAt?: number; cancelledAt?: number; lastFormAnswer?: { labels: string[]; at: number }; deferred: string[] }
type LegacyLaunchApproval = { at: number; label: string; slug?: string; lock?: string; fresh?: false; formID?: string }
type StartOptions = { acknowledgeSupersede?: boolean; expectedLock?: string; decisionId?: string; handoff?: Handoff }

const canonical = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

const json = (value: unknown) => JSON.stringify(value, null, 2)

export class GoalApp {
  readonly root: string
  readonly rootReal: string
  readonly store: Store
  readonly registry: Registry
  readonly options: Options
  private readonly launches: LaunchStore
  private readonly amendmentReviews: AmendmentStore
  private readonly decisions: DecisionStore
  private runs = new Map<string, RunState>()
  private loaded = new Map<string, Loaded>()
  private notes = new Map<string, string>()
  private facts = new Map<string, SessionFacts>()
  private legacyLaunchForms = new Map<string, { sessionID: string; slug: string; lock: string; fieldKey: string; value: string; label: string }>()
  /** T066: the session's offered-but-unanswered decision, for resolution pairing. */
  private pendingDecisions = new Map<string, { id: string; kind: string; slug: string; at: number; message: EngineMessage }>()
  /** T075: the decision whose native form is (being) asked in the composer —
   *  a reply dispatches the same act the TUI dialog would. */
  private pendingFormDecisions = new Map<string, { decisionId: string; kind: string; slug: string; choices: Array<{ label: string; act?: string; arg?: string }>; formID?: string; askedAt: number }>()
  private verifierInbox = new Map<string, VerifierVerdict[]>()
  /** Verifier child → extra READ-ONLY roots the contract grants, and the
   * external paths Core denied it (to name the cause of a stuck round). */
  private verifierScopes = new Map<string, { allow: string[] }>()
  /** Per-scope verifier agents (base agent + contract-listed read roots). */
  private scopedVerifierAgents = new Set<string>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private registrations: Array<{ dispose: () => Promise<void> | void }> = []
  private rpc?: { events: { emit: (name: any, data: any) => Promise<void> } }
  private controller = new AbortController()
  private disposed = false
  private queue = Promise.resolve()
  private readonly packageRoot = join(dirname(fileURLToPath(import.meta.url)), "../..")
  private readonly capturedAt = Date.now()
  private readonly artifacts = captureArtifactHashes(this.packageRoot)
  private readonly packageVersion: string = JSON.parse(readFileSync(join(this.packageRoot, "package.json"), "utf8")).version
  private launchRecoveryTimer?: ReturnType<typeof setTimeout>
  /** Runs a clean restart decided to resume; admitted after setup completes. */
  private pendingResumes: RunState[] = []
  /** Runs whose owner-accepted amendment was committed during startup recovery. */
  private recoveredAmendmentRuns = new Set<string>()
  /** v0.8.0: lazily created AgentMBX transport (only with an identity). */
  private peerChannelInstance?: PeerChannel

  constructor(private ctx: Context) {
    this.root = ctx.location.directory
    this.rootReal = canonical(this.root)
    this.store = new Store(this.root)
    this.launches = new LaunchStore(join(this.root, ".opencode/goals/.owner-launches.json"))
    this.amendmentReviews = new AmendmentStore(join(this.root, ".opencode/goals/.owner-amendments.json"))
    this.decisions = new DecisionStore(join(this.root, ".opencode/goals/.owner-decisions.json"))
    this.registry = new Registry()
    this.options = { ...DEFAULTS, ...(ctx.options as Partial<Options>) }
  }

  // ───────────────────────────── lifecycle

  async start() {
    this.recoverAmendmentCommits()
    this.recover()
    await this.registerAgents()
    await this.registerSkill()
    await this.registerTools()
    await this.registerCommand()
    await this.registerHooks()
    await this.registerRpc()
    void this.eventLoop()
    // Prompt admission waits for location plugins to finish setup. Awaiting
    // a recovery prompt here would wait for our own setup and deadlock.
    this.launchRecoveryTimer = setTimeout(() => {
      if (!this.disposed) void this.recoverOwnerReviews().catch((error) => this.store.ledger("_errors", { type: "owner-review-recovery-error", error: String(error) }))
      if (!this.disposed) this.resumeRestarted()
    }, 0)
  }

  /**
   * v0.8.0 C1: a clean restart's runs resume without an owner decision. The
   * work is deferred until setup is complete (admitting during setup would wait
   * on our own hooks). A run that was verifying a claim re-verifies; a run that
   * was waiting re-arms its deadline; anything else receives the same
   * continuation it had pending, or an ordinary continue.
   */
  private resumeRestarted() {
    for (const state of this.pendingResumes.splice(0)) {
      void this.serial(async () => {
        const live = this.runs.get(state.sessionID)
        if (this.disposed || !live || live.runId !== state.runId) return
        if (!isActive(live.status)) return
        const contract = this.contractOf(live)
        if (!contract) {
          setStatus(live, "paused", "contract unavailable after restart; resume when ready")
          this.persist(live)
          return
        }
        this.store.ledger(live.slug, { type: "restart-resume", runId: live.runId, lock: live.lock, status: live.status, turn: live.turn })
        // A claim that was mid-verification is re-verified, never skipped.
        if (live.claim) return this.verify(live, contract, "claim")
        if (live.status === "verifying") {
          // No claim survives: the checks were interrupted and their partial
          // results are not evidence. Pause rather than invent a verdict.
          setStatus(live, "paused", "host restarted during verification; resume when ready")
          this.store.ledger(live.slug, { type: "restart-verify-interrupted", turn: live.turn })
          this.persist(live)
          return
        }
        if (live.status === "waiting" && live.wait && live.wait.until > Date.now())
          return this.schedule(live, live.wait.until - Date.now(), "continue")
        if (live.status === "waiting") {
          live.wait = undefined
          setStatus(live, "running")
        }
        await this.admit(live, live.pending?.kind ?? "continue")
      })
    }
  }

  async stop() {
    this.disposed = true
    this.controller.abort()
    clearTimeout(this.launchRecoveryTimer)
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const r of this.registrations.splice(0)) await Promise.resolve(r.dispose()).catch(() => {})
  }

  /**
   * Running goals from a previous process: v0.8.0 resumes a clean restart by
   * itself (unchanged lock, intact run) and still pauses on a changed contract,
   * a repaired/divergent run or an interrupted write. The decision is the pure
   * `restartDecision`; this method only gathers the facts and applies it.
   */
  private recover() {
    for (const slug of this.store.slugs()) {
      const { state, intact } = this.recoverRunState(slug)
      if (!state) continue
      if (isActive(state.status)) {
        let disk: { lock: string } | undefined
        try { disk = this.store.readContract(slug) } catch { disk = undefined }
        const decision = restartDecision({
          status: state.status,
          lock: state.lock,
          ...(disk ? { diskLock: disk.lock } : {}),
          runIntact: intact,
          interruptedWrite: this.amendmentReviews.all().some((p) => p.slug === slug && p.runId === state.runId && p.status === "executing"),
        })
        const recoveredAccept = this.recoveredAmendmentRuns.has(state.runId) && state.status === "paused" && intact && !!disk && disk.lock === state.lock
        if (decision.action === "resume" || recoveredAccept) {
          this.store.ledger(slug, { type: "recovered", status: "resumed", reason: recoveredAccept ? "an owner-accepted amendment was committed before the restart" : decision.reason })
          this.store.writeRun(state)
          this.pendingResumes.push(state)
        } else if (decision.action === "pause") {
          setStatus(state, "paused", `host restarted; ${decision.reason}`)
          this.store.ledger(slug, { type: "recovered", status: "paused", code: decision.code, reason: decision.reason })
          this.store.writeRun(state)
        }
      }
      // T072: EVERY goal on disk — terminal ones included — is mirrored in
      // memory. A re-attaching TUI's snapshot then reads the disk truth
      // (complete/N) instead of nothing, so a server reload can never strand
      // the sidebar card at its last pre-restart view.
      // One session can own several goals over time (finish one, start the
      // next). `runs` is keyed by session, so the mirror must never let a
      // terminal sibling shadow the live run — that made goal_status, the
      // injected contract and provenance report a finished goal after reload.
      const held = this.runs.get(state.sessionID)
      if (held && held.runId !== state.runId && !isTerminal(held.status) && isTerminal(state.status)) {
        this.store.ledger(state.slug, { type: "recovery-shadow-avoided", sessionID: state.sessionID, kept: held.slug, ignored: state.slug })
        continue
      }
      this.runs.set(state.sessionID, state)
    }
  }

  /** T108: a run.json that is malformed or carries duplicate keys is never
   * silently trusted (JSON would keep the last duplicate). Repair exactly what
   * the run's own ledger and evidence prove; otherwise refuse and leave it to
   * the owner. */
  private recoverRunState(slug: string): { state?: RunState; intact: boolean } {
    const raw = this.store.readRunRaw(slug)
    if (!raw) return { intact: true }
    let parsed: RunState | undefined
    try {
      const value = JSON.parse(raw.text)
      parsed = value?.version === 1 ? (value as RunState) : undefined
    } catch { parsed = undefined }
    if (parsed && !raw.duplicates.length) return { state: parsed, intact: true }

    const reason = raw.duplicates.length
      ? `run.json carried duplicate keys (${raw.duplicates.join(", ")}); JSON keeps the last value silently`
      : "run.json is not valid JSON"
    this.store.ledger(slug, { type: "run-state-corruption", duplicateKeys: raw.duplicates, reason })

    const repaired = this.repairRunState(slug, raw.text, raw.duplicates)
    if (repaired) return { state: repaired, intact: false }
    this.store.ledger(slug, { type: "run-state-unprovable", duplicateKeys: raw.duplicates, reason,
      detail: "the run's own ledger/evidence cannot prove its runId, lock and session; owner decision required" })
    return { intact: false }
  }

  /** Prove the run's identity from its own bytes: the ledger's last start event
   * plus the locked contract snapshot. Nothing is taken from the corrupt file. */
  private repairRunState(slug: string, text: string, duplicates: string[]): RunState | undefined {
    const start = this.store.recent(slug, 5000).filter((e) => e.type === "start" && typeof e.runId === "string" && typeof e.sessionID === "string" && typeof e.lock === "string").at(-1)
    if (!start) return undefined
    const runId = String(start.runId), sessionID = String(start.sessionID), lock = String(start.lock)
    const snapshot = join(this.store.dir(slug), "evidence", runId, `contract-${lock}.yaml`)
    const plain = join(this.store.dir(slug), "evidence", runId, "contract.yaml")
    const source = existsSync(snapshot) ? snapshot : existsSync(plain) ? plain : undefined
    if (!source) return undefined
    const parsed = parseContract(readFileSync(source, "utf8"), { slug })
    if (!parsed.contract || parsed.lock !== lock) return undefined

    const kept = this.store.keepCorruptRun(slug, text)
    const lastTurn = this.store.recent(slug, 5000).filter((e) => e.type === "turn" && typeof e.turn === "number").at(-1)
    const state = initialRun(parsed.contract, { sessionID, runId, lock, ...(typeof start.commit === "string" ? { commit: start.commit } : {}) })
    state.turn = Number(lastTurn?.turn ?? 0)
    for (const id of Object.keys(state.criteria)) {
      const recorded = this.store.recent(slug, 5000).findLast((e) => e.type === "criterion" && e.criterion === id) as any
      if (recorded?.status) state.criteria[id] = { status: recorded.status, rejections: 0, ...(recorded.by ? { by: recorded.by } : {}) }
    }
    setStatus(state, "paused", "run state was repaired from its own ledger and evidence; resume when ready")
    this.store.writeRun(state)
    this.store.ledger(slug, { type: "run-state-repaired", kept, runId, lock, sessionID, duplicateKeys: duplicates, turn: state.turn })
    this.noticeM(sessionID, M.runStateRepaired(slug, kept))
    return state
  }

  /** Serialize state mutations so concurrent events cannot interleave writes. */
  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  // ───────────────────────────── contracts and state helpers

  private load(slug: string, fresh = false): Loaded | { error: string } {
    const cached = this.loaded.get(slug)
    if (cached && !fresh) return cached
    const read = this.store.readContract(slug)
    if (!read) return { error: `no goal named "${slug}" (expected .opencode/goals/${slug}/goal.yaml)` }
    if (!read.contract) return { error: `goal.yaml for "${slug}" is invalid:\n${formatIssues(read.issues)}` }
    const value = { contract: read.contract, lock: read.lock, text: read.text }
    this.loaded.set(slug, value)
    return value
  }

  private contractOf(state: RunState): Contract | undefined {
    const cached = this.loaded.get(state.slug)
    if (cached && cached.lock === state.lock) return cached.contract
    // The locked contract is the one the run started with; if the file changed,
    // keep using the locked copy from the evidence of the run start.
    const locked = this.store.readContract(state.slug)
    if (locked?.contract && locked.lock === state.lock) {
      this.loaded.set(state.slug, { contract: locked.contract, lock: locked.lock, text: locked.text })
      return locked.contract
    }
    const currentSnapshot = join(this.store.dir(state.slug), "evidence", state.runId, `contract-${state.lock}.yaml`)
    const snapshot = existsSync(currentSnapshot) ? currentSnapshot : join(this.store.dir(state.slug), "evidence", state.runId, "contract.yaml")
    if (existsSync(snapshot)) {
      const parsed = parseContract(readFileSync(snapshot, "utf8"), { slug: state.slug })
      if (parsed.contract && parsed.lock === state.lock) return parsed.contract
    }
    return undefined
  }

  /** The exact supported recovery call for a divergent generation. */
  private recoveryCall(slug: string, lock: string): string {
    return `goal_recover_divergence {"slug":"${slug}","expectedLock":"${lock}"}`
  }

  /** The run's live target in the shape goal_manage accepts. */
  private targetOf(state: RunState): GoalTarget {
    return { key: `live:${state.slug}:${state.runId}`, lock: state.lock, runId: state.runId, sessionID: state.sessionID }
  }

  /** T106: the disk contract differing from its locked generation is a
   * distinct, detectable cause. Read the locked snapshot versus the disk bytes
   * — never infer it from the presence of a pending proposal. */
  private divergenceOf(state: RunState): { diskLock: string; diskText: string } | undefined {
    const disk = this.store.readContract(state.slug)
    if (!disk?.contract || disk.lock === state.lock) return undefined
    return { diskLock: disk.lock, diskText: disk.text }
  }

  /** T106: name the real cause, both hashes and the exact recovery call so no
   * unauthorizing answer is retried and no round is lost to discovery. */
  private divergenceRefusal(state: RunState, disk: { diskLock: string }): string {
    return [
      `The disk goal.yaml of "${state.slug}" differs from its locked generation, so no amendment answer can be applied.`,
      `Locked SHA256 ${state.lock}; disk SHA256 ${disk.diskLock}.`,
      `Run ${this.recoveryCall(state.slug, state.lock)} and choose Adopt disk version or Restore locked version (Leave unchanged changes nothing).`,
      "No earlier proposal, byte match or owner message is counted as acceptance.",
    ].join(" ")
  }

  private persist(state: RunState) {
    account(state)
    if (!isActive(state.status)) state.activity = undefined // T053: no stale tracer on stopped/terminal states
    this.store.writeRun(state)
    // T026: every persisted transition refreshes the derived machine-level
    // index (skipped when nothing changed, since usage bursts persist often).
    // T061: priority rides the registry entry (absent stays absent).
    this.registry.update(this.rootReal, state.slug, { title: state.title, status: state.status, ...(state.runId ? { runId: state.runId } : {}), ...(state.lock ? { lock: state.lock } : {}), ...(state.priority ? { priority: state.priority } : {}), updatedAt: Date.now() })
    this.emitUpdate(state)
  }

  private factsOf(sessionID: string): SessionFacts {
    let f = this.facts.get(sessionID)
    if (!f) this.facts.set(sessionID, (f = { busy: false, forms: new Set(), deferred: [] }))
    return f
  }

  /** T100: the run's exact execution root. With a contract `workspace` the host
   *  checks, the protect/diff base and the fingerprint resolve here; otherwise
   *  this is the project root (today's behaviour). `.opencode/goals/**` always
   *  resolves at the project root. */
  private executionRoot(contract: Contract | undefined): string {
    const ws = contract?.workspace?.trim()
    return ws && ws !== "." ? resolve(this.root, ws) : this.root
  }

  /** T069: /goal commands issued while the session is mid-turn (or holding a
   *  form) used to land invisibly — the owner sent them and nothing visibly
   *  happened until the turn ended. They now acknowledge IMMEDIATELY (a
   *  notice) and execute when the turn/form resolves — never silent. */
  private deferIfHeld(sessionID: string, text: string, sub: string): boolean {
    const f = this.factsOf(sessionID)
    if (!f.busy && f.forms.size === 0) return false
    // control + read + decision-answer commands stay immediate: pause/abort
    // are how you stop a runaway turn; approve/reject ARE the decision's
    // answers (deferring them behind the decision-form's own ask turn would
    // be circular); status/list/help just read state
    if (["", "status", "list", "help", "pause", "abort", "approve", "reject"].includes(sub)) return false
    // A direct OWNER command can resume this session's stopped run while
    // an unrelated inspection turn is still busy. ownerAct still validates
    // the exact state/lock/reviews and never admits a competing kickoff.
    // Do not bypass an actual native form or a cross-session hold.
    const own = this.runs.get(sessionID)
    if (sub === "resume" && f.forms.size === 0 && own && !ownerCan(own, "resume")) return false
    f.deferred.push(text)
    this.noticeM(sessionID, M.commandDeferred(sub, f.busy ? "turn" : "form"))
    return true
  }

  /** Runs whatever /goal commands deferred while the session was busy. */
  private flushDeferred(sessionID: string) {
    const f = this.factsOf(sessionID)
    if (f.busy || f.forms.size > 0 || !f.deferred.length) return
    for (const text of f.deferred.splice(0)) void this.command(sessionID, text)
  }

  // T068: launch approvals persist across plugin/server restarts inside the
  // TTL — in-memory state died with the process, so a legitimately approved
  // launch refused after a restart (live: two restarts voided one). The
  // sidecar lives beside the goal folders; a file there never matches a slug
  // (directories with goal.yaml only).
  private get approvalsFile() {
    return join(this.root, ".opencode", "goals", ".launch-approvals.json")
  }
  private readLaunchApprovals(): Record<string, LegacyLaunchApproval> {
    try {
      const parsed = JSON.parse(readFileSync(this.approvalsFile, "utf8"))
      return typeof parsed === "object" && parsed ? (parsed as Record<string, LegacyLaunchApproval>) : {}
    } catch {
      return {}
    }
  }
  private writeLaunchApproval(sessionID: string, approval: LegacyLaunchApproval) {
    const all = this.readLaunchApprovals()
    all[sessionID] = approval
    writeFileSync(this.approvalsFile, JSON.stringify(all, null, 2))
  }
  private clearLaunchApproval(sessionID: string) {
    const all = this.readLaunchApprovals()
    if (!(sessionID in all)) return
    delete all[sessionID]
    writeFileSync(this.approvalsFile, JSON.stringify(all, null, 2))
  }
  /** The approval state for a session: fresh in memory, else fresh on disk, else none. */
  private launchApproval(sessionID: string): LegacyLaunchApproval | undefined {
    const disk = this.readLaunchApprovals()[sessionID]
    if (disk && Date.now() - disk.at <= this.options.launchApprovalMs) return disk
    return undefined
  }

  private bindLegacyLaunchForm(form: any) {
    // Compatibility with the shipped skill's old launch question: only an
    // explicitly OFFERED launch choice, a launch-specific form and one
    // unambiguous validated candidate. Modern flows use nonce-bound review.
    if (this.launches.all(form?.sessionID).length || this.amendmentReviews.all(form?.sessionID).length) return
    if (!/\blaunch\b.*\bgoal\b/i.test(String(form?.title ?? "")) || form.fields?.length !== 1) return
    const field = form.fields[0]
    const choice = field.options?.find((o: any) => o.label === LAUNCH_LABEL || o.label === `${LAUNCH_LABEL} (Recommended)`)
    if (!choice || typeof field.key !== "string" || typeof choice.value !== "string") return
    const candidates = this.store.slugs().flatMap((slug) => {
      const state = this.store.readRun(slug)
      if (state && !isTerminal(state.status)) return []
      const parsed = this.store.readContract(slug)
      return parsed?.contract ? [{ slug, lock: parsed.lock }] : []
    })
    if (candidates.length !== 1) return
    this.legacyLaunchForms.set(form.id, { sessionID: form.sessionID, slug: candidates[0]!.slug, lock: candidates[0]!.lock, fieldKey: field.key, value: choice.value, label: choice.label })
  }

  /** Recent ledger events for the dashboard's Timeline section, oldest first. */
  private timelineOf(state: RunState) {
    return this.store
      .recent(state.slug, 30)
      .slice(-18)
      .map((e) => ({ t: e.t, kind: e.type, text: timelineText(e) }))
  }

  view(state: RunState): GoalView | undefined {
    const contract = this.contractOf(state)
    if (!contract) return undefined
    const use = budgetUse(state, contract)
    const all = [...contract.criteria.map((c) => ({ c, invariant: false })), ...contract.invariants.map((c) => ({ c, invariant: true }))]
    return {
      slug: state.slug,
      title: contract.title,
      outcome: contract.outcome,
      status: state.status,
      ...(state.reason ? { reason: state.reason } : {}),
      runId: state.runId,
      sessionID: state.sessionID,
      lock: state.lock,
      target: this.targetOf(state),
      turn: state.turn,
      timeline: this.timelineOf(state),
      activeMs: state.activeMs,
      activeSince: state.activeSince,
      usage: { tokens: state.usage.tokens, cost: state.usage.cost },
      budget: use.parts,
      budgetRatio: use.ratio,
      criteria: all.map(({ c, invariant }) => {
        const s = state.criteria[c.id] ?? { status: "unknown" as const, rejections: 0 }
        return { id: c.id, statement: c.statement, essential: c.essential, invariant, kind: c.check.kind, status: s.status, ...(s.by ? { by: s.by } : {}), ...(s.detail ? { detail: s.detail.slice(0, 400) } : {}), ...(s.at ? { at: s.at } : {}) }
      }),
      steps: contract.plan.map((s) => ({ id: s.id, title: s.title, status: state.steps[s.id] ?? "pending" })),
      ...(state.progress ? { progress: state.progress } : {}),
      ...(state.verdict ? { verdict: { passed: state.verdict.passed, lines: state.verdict.lines.slice(0, 6), at: state.verdict.at, turn: state.verdict.turn } } : {}),
      ...(state.blocker ? { blocker: { key: state.blocker.key, count: state.blocker.count, reason: state.blocker.reason, ...(state.blocker.needs ? { needs: state.blocker.needs } : {}) } } : {}),
      ...(state.wait ? { wait: state.wait } : {}),
      ...(state.activity ? { activity: state.activity } : {}),
      awaitingUser: this.factsOf(state.sessionID).forms.size > 0,
      // T052: derived from the persisted status — the sidebar keeps showing it
      // until the owner resolves the decision, never a transient toast.
      ...(state.status === "needs_review"
        ? { actionRequired: `sign-off needed: ${state.reason?.replace("owner sign-off needed: ", "") ?? "criteria await your decision"} (/goal approve <C#>)` }
        : state.status === "blocked"
          ? { actionRequired: `blocked on ${state.blocker?.key ?? "owner decision"}: ${state.blocker?.reason ?? state.reason ?? ""}${state.blocker?.needs ? ` — needs ${state.blocker.needs}` : ""}` }
          : state.status === "budget_limited"
            ? { actionRequired: `budget used: raise the budget and amend, or abort (${state.reason ?? ""})` }
            : {}),
      amendments: state.amendments.filter((a) => a.status === "proposed").length,
      flags: state.flags.length,
      updatedAt: state.updatedAt,
    }
  }

  private emitUpdate(state: RunState) {
    const view = this.view(state)
    void this.rpc?.events.emit("updated", { sessionID: state.sessionID, view: view ?? null }).catch(() => {})
  }

  /**
   * T045: the post-goal summary, emitted on every complete / needs_review /
   * budget_limited transition. Built from data the run already has, shown to
   * the owner (rpc event → TUI dialog) and the agent (one-line transcript
   * notice), and persisted under evidence/ with a ledger event.
   */
  private async summarize(state: RunState, contract: Contract, continued = false) {
    try {
      const summary = buildPostGoalSummary({
        contract,
        state,
        ledgerEvents: this.store.recent(state.slug, 200) as unknown as Array<Record<string, unknown>>,
        cleo: await cleoFacts(this.root, defaultRunner),
        scopeAudit: completionAudit(contract, state),
        continued,
      })
      const file = this.store.evidence(state.slug, state.runId, `summary-turn-${state.turn}-${Date.now()}`, summary)
      this.store.ledger(state.slug, { type: "summary", turn: state.turn, status: state.status, headline: summary.headline, file })
      void this.rpc?.events.emit("summary", { sessionID: state.sessionID, slug: state.slug, status: state.status, headline: summary.headline, title: summary.title, digest: summary.digest, text: summary.text }).catch(() => {})
      this.noticeM(state.sessionID, M.goalSummary(summary.headline, summary.caveats.length + summary.scopeAudit.length, state.status))
      await this.transcript(state.sessionID, `◎ goal.summary (${state.status}) — ${summary.headline}. ${summary.followUps[0] ?? ""}`)
      this.persist(state)
      return summary
    } catch {
      // the summary is a reporting layer; a failure here never changes the run
      return undefined
    }
  }

  private notice(sessionID: string | undefined, text: string, level: "info" | "success" | "warning" | "error" = "info", attention?: "done" | "question" | "error") {
    void this.rpc?.events.emit("notice", { ...(sessionID ? { sessionID } : {}), level, text, ...(attention ? { attention } : {}) }).catch(() => {})
  }

  /** T054: every engine notice is an actionable message — cause plus concrete
   *  choices, rendered inline for toasts and attached as structured choices
   *  for the T050 decision dialogs (wired to rpc.act). */
  private noticeM(sessionID: string | undefined, message: EngineMessage) {
    void this.rpc?.events
      .emit("notice", {
        ...(sessionID ? { sessionID } : {}),
        level: message.level,
        text: renderMessage(message),
        choices: message.choices,
        ...(message.attention ? { attention: message.attention } : {}),
      })
      .catch(() => {})
  }

  /**
   * T050: every owner decision point emits a DECISION payload — rpc event,
   * actionable notice with desktop attention — that the TUI renders as a
   * selectable dialog wired to rpc.act. Slash commands remain the power-user
   * path; nobody has to type an approval by hand.
   */
  /** T066: every decision emission leaves a ledger trace — the payload, and
   *  later its resolution (the next owner act on that session). */
  private decisionTarget(slug: string): DecisionTarget {
    const state = [...this.runs.values()].find((s) => s.slug === slug) ?? this.store.readRun(slug)
    const draft = this.store.readContract(slug)
    return { slug, lock: state?.lock ?? draft?.lock ?? "", status: state?.status ?? "draft", ...(state ? { runId: state.runId, sessionID: state.sessionID } : {}) }
  }

  private decide(sessionID: string | undefined, slug: string, kind: DecisionKind, message: EngineMessage, extra: Record<string, unknown> = {}) {
    if (!sessionID) { this.noticeM(sessionID, message); return }
    const now = Date.now()
    const target = this.decisionTarget(slug)
    const request = this.decisions.create({ sessionID, slug, kind, lock: target.lock, target,
      candidates: Object.fromEntries(message.choices.filter((c) => c.act === "start" && c.arg).map((c) => [c.arg!, this.decisionTarget(c.arg!)])),
      title: message.id, message, extra, createdAt: now, expiresAt: 0, expiryPolicy: "target", issuerPID: process.pid,
      question: `${message.id}\n${renderMessage(message)}\nGoal: ${slug}; run: ${target.runId ?? "draft"}; lock: ${target.lock || "picker"}.\nOnly an offered option executes its described operation; commentary is not consent.`,
    })
    const decisionId = request.id
    this.publishDecision(request)
    // T070: guidance-only rows (no act) are MARKED as guidance in the payload
    // itself — every surface that renders the decision (TUI dialog, native
    // form) shows them as advice, not buttons. Keys are only present when
    // set: an explicit `act: undefined` fails the event schema.
    this.store.ledger(slug, {
      type: "decision",
      decisionId,
      turn: this.runs.get(sessionID ?? "")?.turn ?? 0,
      kind,
      message: renderMessage(message),
      choices: message.choices.map((c) => (c.act ? { label: c.label, act: c.act, ...(c.arg ? { arg: c.arg } : {}) } : { label: c.label, guidance: true })),
    })
    this.noticeM(sessionID, message)
    // The sole decision surface is the session's native Composer form.
    // Notifications are not answers and elapsed time is not revocation;
    // exact target/generation, offered values and one-use reservation remain.
    void this.askDecisionForm(sessionID, slug, kind, decisionId, message)
  }

  private publishDecision(request: DecisionRequest) {
    this.pendingDecisions.set(request.sessionID, { id: request.id, kind: request.kind, slug: request.slug, at: request.createdAt, message: request.message })
    const choices = request.message.choices.map((c) => ({ label: c.label, run: c.run, ...(c.act ? { act: c.act } : { guidance: true }), ...(c.arg ? { arg: c.arg } : {}) }))
    void this.rpc?.events.emit("decision", { sessionID: request.sessionID, slug: request.slug, kind: request.kind, decisionId: request.id, title: request.title, message: renderMessage(request.message), question: request.question,
      ...(request.expiryPolicy === "target" ? { expiryPolicy: "target" } : { expiresAt: request.expiresAt, expiryPolicy: "time" }), choices, ...request.extra }).catch(() => {})
  }

  /**
   * T075: re-ask the native form for a still-unanswered decision whose first
   * ask was skipped because the session was mid-turn (e.g. the decision
   * landed while the owner was answering the previous form).
   */
  /**
   * After a reload the in-memory pending map is empty. Recover the latest
   * genuinely pending decision for this session so the owner's next turn
   * re-presents it once (the explicit "reload restores it" path).
   */
  private restorePendingDecision(sessionID: string) {
    if (this.pendingDecisions.has(sessionID)) return
    const latest = this.decisions.all(sessionID)
      .filter((p) => p.status === "pending" && !reviewExpired(p))
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!latest) return
    this.pendingDecisions.set(sessionID, { id: latest.id, kind: latest.kind, slug: latest.slug, at: latest.createdAt, message: latest.message })
  }

  private reaskDecisionForm(sessionID: string) {
    this.restorePendingDecision(sessionID)
    const pending = this.pendingDecisions.get(sessionID)
    if (!pending || this.pendingFormDecisions.has(sessionID)) return
    if (this.factsOf(sessionID).forms.size > 0) return
    const request = this.decisions.get(pending.id)
    if (!request) return
    const stale = staleDecision(request, request.target, this.decisionTarget(request.slug))
    if (stale.stale) {
      this.silenceDecision(request, stale)
      if (this.pendingDecisions.get(sessionID)?.id === request.id) this.pendingDecisions.delete(sessionID)
      return
    }
    // A dismissal/comment is an unresolved review, not permission to trap
    // the owner in an immediately re-opening form. Reload or goal_review
    // explicitly restores it; ordinary execution events do not. An
    // unanswered ask is not stale either, but it is asked ONCE per process:
    // only goal_review (which calls askDecisionForm directly) or a reload
    // (new process, empty set) presents it again.
    const policy = shouldReaskDecision({
      alreadyAsked: askedDecisionIds.has(request.id),
      status: request.status,
      stale: false,
      formOpen: this.pendingFormDecisions.has(sessionID) || this.factsOf(sessionID).forms.size > 0,
    })
    if (!policy.ask) return
    void this.askDecisionForm(sessionID, pending.slug, pending.kind, pending.id, pending.message)
  }

  /**
   * T075: dispatch the question-tool prompt for a decision. The model asks
   * the owner in the composer; form.replied maps the picked label back to
   * the choice's act and dispatches it (see onEvent). Skipped when the
   * session is busy or already holding a form — the TUI dialog remains the
   * other surface either way.
   */
  private async askDecisionForm(sessionID: string | undefined, slug: string, kind: string, decisionId: string, message: EngineMessage) {
    if (!sessionID) return
    const f = this.factsOf(sessionID)
    if (f.busy || f.forms.size > 0 || this.pendingFormDecisions.has(sessionID)) return
    const actable = message.choices.filter((c) => c.act)
    if (!actable.length) return // guidance-only: nothing to wire a form to
    const request = this.decisions.get(decisionId)
    if (!request || request.status !== "pending" || request.formID || reviewExpired(request)) return
    this.pendingFormDecisions.set(sessionID, { decisionId, kind, slug, choices: message.choices.map((c) => ({ label: c.label, act: c.act, arg: c.arg })), askedAt: Date.now() })
    askedDecisionIds.add(decisionId)
    const payload = { questions: [{ header: "Goal", question: request.question, options: decisionChoices(request).map((c) => ({ label: c.label, description: c.description })) }] }
    const presentation = newRunId()
    const text = [
      `◎ goal-decision (kind=${kind}, slug=${slug}) — the goal engine needs the OWNER's decision now.`,
      `Decision: ${renderMessage(message)}`,
      "Ask the owner NOW with the question tool using the EXACT JSON below. Keep the question's nonce, target, labels and descriptions unchanged.",
      `GOAL_DECISION_JSON:${JSON.stringify(payload)}`,
      `GOAL_DECISION_ASK:${presentation}`,
      `Answer with the question tool call only — no other work this turn. The owner's pick dispatches the engine act directly.`,
    ].join("\n")
    this.store.ledger(slug, { type: "decision-form-asked", decision: decisionId, kind, presentation })
    await this.ctx.session
      .prompt({ sessionID, text, resume: true } as any)
      .catch((error) => this.store.ledger(slug, { type: "decision-form-failed", decision: decisionId, error: String(error).slice(0, 300) }))
  }

  private async transcript(sessionID: string, text: string) {
    await this.ctx.session.synthetic({ sessionID, text, resume: false } as any).catch(() => {})
  }

  private publishLaunch(request: LaunchRequest) {
    void this.rpc?.events.emit("updated", { sessionID: request.sessionID, launch: launchView(request) }).catch(() => {})
  }

  private async launchDisposition(request: LaunchRequest, status: LaunchRequest["status"], result: string, type: string) {
    const settled = this.launches.update(request.id, { status, result })
    this.store.ledger(request.slug, { type, decisionId: request.id, sessionID: request.sessionID, lock: request.lock, fresh: request.fresh, status, result })
    this.publishLaunch(settled)
    this.noticeM(request.sessionID, M.launchOutcome(request.slug, status, result))
    await this.transcript(request.sessionID, `◎ Launch ${request.slug} (${status}; decision ${request.id}): ${result}`)
  }

  private launchActivity(decisionId: string | undefined, activity: LaunchActivity) {
    if (!decisionId || !this.launches.get(decisionId)) return
    const request = this.launches.activity(decisionId, activity)
    this.store.ledger(request.slug, { type: "launch-activity", decisionId, sessionID: request.sessionID, lock: request.lock, fresh: request.fresh, ...activity })
    this.publishLaunch(request)
    this.noticeM(request.sessionID, M.launchActivity(request.slug, activity.detail))
  }

  /** Preparation is not execution or consent. The complete target/hash/mode
   * is persisted before asking so a lost model/tool result cannot lose the
   * owner's choice, and the model never needs to call start afterwards. */
  private async prepareLaunch(sessionID: string, slug: string, fresh: boolean) {
    const loaded = this.load(slug, true)
    if ("error" in loaded) throw new Error(loaded.error)
    const here = this.runs.get(sessionID)
    if (!fresh && here && !isTerminal(here.status)) throw new Error(`This session owns ${here.slug}; choose a fresh session rather than replacing a live goal.`)
    if ([...this.runs.values()].some((s) => s.slug === slug && !isTerminal(s.status))) throw new Error(`Goal ${slug} is already live; manage it instead of launching again.`)
    if (this.launches.all().some((p) => p.status === "executing" && (p.slug === slug || p.sessionID === sessionID))) throw new Error("A launch admission is already starting; inspect its receipt before preparing another review.")
    const { contract, lock } = loaded
    const question = [
      `Review and launch: ${contract.title}`,
      `Goal: ${slug}. Contract SHA256: ${lock}.`,
      `Outcome: ${contract.outcome}`,
      `Mode: ${fresh ? "new root session; the original session and history are NOT cleared" : "this session"}.`,
      "Criteria:", ...contract.criteria.map((c) => `- ${c.id}: ${c.statement}`),
      `Non-goals: ${contract.non_goals.join("; ")}`,
      "Revise or save instead if anything should change. Only choosing the offered launch option starts this exact contract.",
    ].join("\n")
    const now = Date.now()
    const request = this.launches.create({ sessionID, slug, lock, fresh, title: contract.title, question, createdAt: now, expiresAt: now + this.options.launchApprovalMs, issuerPID: process.pid })
    this.store.ledger(slug, { type: "launch-proposed", decisionId: request.id, sessionID, lock, fresh, expiresAt: request.expiresAt })
    this.publishLaunch(request)
    let transport: "native-form" | "question-tool"
    try { transport = await this.presentLaunch(request) }
    catch (error) {
      await this.launchDisposition(request, "failed", `Launch review could not be presented; nothing started. ${String(error)}`, "launch-presentation-failed")
      throw error
    }
    return { decisionId: request.id, slug, lock, fresh, status: "pending", transport, message: "Launch review offered natively. The host, not a later model call, executes the owner's choice." }
  }

  private async presentLaunch(request: LaunchRequest): Promise<"native-form" | "question-tool"> {
    const sessionID = request.sessionID, slug = request.slug
    const nativeForm = (this.ctx.session as any).form
    if (typeof nativeForm?.create === "function") {
      const form = await nativeForm.create({
        sessionID, title: `Launch ${slug}?`, metadata: { goalDecisionID: request.id },
        fields: [{ key: "action", title: request.question, type: "string", custom: true, options: launchChoices }],
      })
      this.launches.bind(form)
      return "native-form"
    } else {
      const payload = { questions: [{ header: "Goal", question: request.question, options: launchChoices.map((c) => ({ label: c.label, description: c.description })) }] }
      await this.ctx.session.prompt({
        sessionID,
        text: `Ask the owner with the question tool using the exact JSON below. The host executes the choice; do not call goal_start afterwards.\nGOAL_FORM_JSON:${JSON.stringify(payload)}`,
        metadata: { goal: { kind: "launch-review", decisionId: request.id } },
        resume: true,
      } as any)
      return "question-tool"
    }
  }

  private async recoverLaunchReviews() {
    const api = (this.ctx.session as any).form
    for (const p of this.launches.all()) {
      if (p.status === "executing" && (p.issuerPID === process.pid || !processAlive(p.issuerPID))) {
        const state = this.store.readRun(p.slug)
        const start = this.store.recent(p.slug, 1000).find((e) => e.type === "start" && e.decisionId === p.id && e.lock === p.lock && e.runId === state?.runId)
        const clean = p.fresh ? this.store.recent(p.slug, 1000).find((e) => e.type === "clean-start" && e.decisionId === p.id && e.from === p.sessionID && e.to === state?.sessionID) : undefined
        const succeeded = !!state && !!start && (p.fresh ? !!clean || state.handoff?.fromSessionID === p.sessionID && state.handoff?.toSessionID === state.sessionID : state.sessionID === p.sessionID)
        await this.launchDisposition(p, succeeded ? "succeeded" : "failed", succeeded ? `Recovered already-started run ${state!.runId}; approval was not replayed.` : "Launch was interrupted with no matching run receipt. Inspect state, then prepare a new review; approval was not replayed.", "launch-recovery-disposition")
        this.store.ledger(p.slug, { type: "launch-recovery", decisionId: p.id, ok: succeeded, ...(succeeded ? { runId: state!.runId } : {}) })
        continue
      }
      if (!["pending", "interrupted"].includes(p.status) || p.issuerPID !== process.pid && processAlive(p.issuerPID)) continue
      if (p.expiresAt < Date.now()) {
        await this.launchDisposition(p, "expired", "Launch review expired. Prepare a fresh review; nothing started.", "launch-expired")
        continue
      }
      const loaded = this.load(p.slug, true)
      if ("error" in loaded || loaded.lock !== p.lock) {
        await this.launchDisposition(p, "failed", "The draft changed or is invalid after reload; nothing launched. Prepare a new review of the current contract.", "launch-changed")
        continue
      }
      if (p.formID && typeof api?.get === "function") {
        try {
          const form = await api.get({ sessionID: p.sessionID, formID: p.formID })
          if (form.state?.status === "answered") { await this.resolveLaunch(p, form.state.answer); continue }
          if (form.state?.status === "pending") { this.factsOf(p.sessionID).forms.add(p.formID); continue }
          if (form.state?.status === "cancelled") this.launches.interruptForm(p.id)
        } catch {
          // Core form IDs may disappear on location reload. The consent
          // request's nonce/hash/mode persist; re-present the actual form.
        }
      }
      const next = this.launches.reopenForm(p.id)
      if (next) {
        this.store.ledger(p.slug, { type: "launch-review-restored", decisionId: p.id, previousFormID: p.formID, lock: p.lock, fresh: p.fresh })
        try { await this.presentLaunch(next) }
        catch (error) { await this.launchDisposition(next, "failed", `Launch review could not be restored; nothing started. ${String(error)}`, "launch-presentation-failed") }
      }
    }
  }

  private async recoverOwnerReviews() {
    await this.recoverLaunchReviews()
    await this.recoverAmendmentReviews()
    await this.recoverDecisions()
  }

  private async reviewLaunch(sessionID: string, request: LaunchRequest) {
    if (request.sessionID !== sessionID) throw new Error("That launch review belongs to another authoring session; nothing was reused.")
    if (request.issuerPID !== process.pid && processAlive(request.issuerPID)) throw new Error("Another live server owns this launch review; inspect it there.")
    if (!["pending", "interrupted", "expired"].includes(request.status)) throw new Error(`Launch review is ${request.status}; inspect its disposition, then prepare a new review rather than replaying approval.`)
    const loaded = this.load(request.slug, true)
    if ("error" in loaded) throw new Error(loaded.error)
    if (loaded.lock !== request.lock) throw new Error("The reviewed draft changed; old choices cannot be reused. Prepare a new launch review of the current contract.")
    if (request.status === "expired" || request.expiresAt < Date.now()) {
      if (request.status !== "expired") await this.launchDisposition(request, "expired", "Launch review expired. Prepare a fresh review; nothing started.", "launch-expired")
      const next = await this.prepareLaunch(sessionID, request.slug, request.fresh)
      this.store.ledger(request.slug, { type: "launch-review-replaced", decisionId: request.id, replacementDecisionId: next.decisionId, sessionID, lock: request.lock, fresh: request.fresh })
      return `Expired launch review replaced by new native review ${next.decisionId}. A NEW real owner selection is required; the old approval was not replayed and nothing started.`
    }
    const api = (this.ctx.session as any).form
    // Server plugins do not always expose Core's form.get capability. The
    // exact bound form's authenticated creation/cancel/reply events are
    // still tracked locally; do not enqueue a duplicate native question.
    if (request.formID && this.factsOf(sessionID).forms.has(request.formID))
      return "The exact launch review is already present in the native composer. Nothing started."
    if (request.formID && typeof api?.get === "function") {
      try {
        const form = await api.get({ sessionID, formID: request.formID })
        if (form.state?.status === "pending") return "The exact launch review is already present in the native composer. Nothing started."
      } catch { /* Core form can disappear; re-present, never consume an answer here. */ }
    }
    const next = this.launches.reopenForm(request.id)
    if (!next) throw new Error("Launch review changed while restoring it; refresh the receipt.")
    this.store.ledger(request.slug, { type: "launch-review-restored", decisionId: request.id, previousFormID: request.formID, lock: request.lock, fresh: request.fresh })
    try { await this.presentLaunch(next) }
    catch (error) {
      await this.launchDisposition(next, "failed", `Launch review could not be restored; nothing started. ${String(error)}`, "launch-presentation-failed")
      throw error
    }
    this.publishLaunch(next)
    return "The same exact launch review has been re-presented natively. No approval was inferred and nothing started."
  }

  private async launchFromOwnerChat(sessionID: string, slug: string, fresh: boolean): Promise<string | undefined> {
    const admission = await this.serial(async () => {
      const loaded = this.load(slug, true)
      if ("error" in loaded) throw new Error(loaded.error)
      const actor = await this.ctx.session.get({ sessionID })
      if (canonical(actor.location.directory) !== this.rootReal) throw new Error("The launch author is not in this project; nothing started.")
      if (actor.parentID) throw new Error("Goal launch requires a root authoring session; no child goal was created.")
      const reviews = this.launches.all(sessionID)
      const displayed = reviews.flatMap((p) => {
        const bound = this.store.recent(p.slug, 1000).findLast((event) => event.type === "launch-form-bound" && event.decisionId === p.id && event.lock === p.lock)
        return bound ? [{ id: p.id, slug: p.slug, lock: p.lock, fresh: p.fresh, at: Number(bound.t) }] : []
      })
      const source = ownerLaunchMessage(await this.ctx.session.context({ sessionID }), displayed, { slug, lock: loaded.lock, fresh })
      if (!source) return undefined
      const reviewed = this.launches.get(source.reviewId)!
      if (!["pending", "interrupted", "expired"].includes(reviewed.status)) throw new Error(`The displayed launch review is ${reviewed.status}; no old instruction was replayed.`)
      if (reviewed.issuerPID !== process.pid && processAlive(reviewed.issuerPID)) throw new Error("Another live server owns the displayed launch review; nothing started.")
      if ([...this.launches.all(), ...this.decisions.all(), ...this.amendmentReviews.all()].some((p) => p.ownerMessageID === source.id))
        throw new Error("That actual owner message was already consumed; no launch replayed.")
      if ([...this.runs.values()].some((state) => state.slug === slug && !isTerminal(state.status))) throw new Error("That goal is already live; no new run or approval was created.")
      const here = this.runs.get(sessionID)
      if (here && !isTerminal(here.status)) throw new Error("This session owns a live goal; manage it or choose an exact native fresh-session review. No chat launch or replacement was inferred.")
      if (this.factsOf(sessionID).forms.size) throw new Error("An owner form is still pending; its dismissal is not launch consent.")
      const now = Date.now()
      // A distinct fresh owner message creates a new authorization receipt.
      // The expired timed review and its unconsumed form answer stay spent.
      const request = this.launches.create({ sessionID, slug, lock: loaded.lock, fresh, title: loaded.contract.title,
        question: reviewed.question, createdAt: now, expiresAt: now + this.options.launchApprovalMs, issuerPID: process.pid })
      const bound = this.launches.bindOwnerMessage(request.id, source.id)
      if (!bound) {
        this.launches.update(request.id, { status: "failed", result: "Owner launch instruction could not be reserved; nothing started." })
        throw new Error("Owner launch instruction could not be reserved; nothing started.")
      }
      this.store.ledger(slug, { type: "owner-message-consumed", ownerMessageID: source.id, decisionId: bound.id,
        reviewedDecisionId: reviewed.id, actorSessionID: sessionID, lock: bound.lock, fresh, action: "launch" })
      return bound
    })
    if (!admission) return undefined
    await this.resolveLaunch(admission, {}, true)
    return this.launches.get(admission.id)?.result ?? "Inspect the launch receipt; no success was inferred."
  }

  private async resolveLaunch(request: LaunchRequest, answer: Record<string, unknown>, ownerChat = false) {
    request = this.launches.get(request.id) ?? request
    if (request.status !== "pending") return // replay, including during execution
    if (request.issuerPID !== process.pid && processAlive(request.issuerPID)) return // another live session server owns it
    const value = request.fieldKey ? answer[request.fieldKey] : undefined
    const selected = ownerChat && request.ownerMessageID ? launchChoices[0] : selectedReviewChoice(request, launchChoices, answer)
    if (request.expiresAt < Date.now()) {
      await this.launchDisposition(request, "expired", "Launch review expired. Prepare a fresh review; nothing started.", "launch-expired")
      return
    }
    if (!selected || selected.value === "revise") {
      const comment = typeof value === "string" ? value : "Owner requested revision."
      this.launches.update(request.id, { status: "commented", comment })
      await this.launchDisposition(request, "commented", `Draft revision requested; nothing launched. Commentary: ${comment}`, "launch-revision-requested")
      await this.ctx.session.prompt({ sessionID: request.sessionID, text: `Revise the draft goal ${request.slug} with the write-goal interview. Owner commentary: ${JSON.stringify(comment)}. Nothing launched; show the revised contract before another launch review.`, skills: [{ id: "write-goal" }] } as any)
      return
    }
    if (selected.value === "save") {
      await this.launchDisposition(request, "rejected", "Draft saved; nothing launched.", "launch-declined")
      return
    }
    const loaded = this.load(request.slug, true)
    if ("error" in loaded || loaded.lock !== request.lock) {
      await this.launchDisposition(request, "failed", "The draft changed since review; nothing launched. Prepare a new review of the current contract.", "launch-changed")
      return
    }
    try {
      const reserved = this.launches.reserve(request.id)
      if (!reserved) {
        const current = this.launches.get(request.id)!
        if (current.status === "expired") {
          await this.launchDisposition(current, "expired", "Launch review expired at reservation. Prepare a fresh review; nothing started.", "launch-expired")
        } else if (current.status === "pending") {
          await this.launchDisposition(current, "failed", "Launch reservation refused: another admission owns this draft/session. No second launch started; inspect the active launch receipt.", "launch-reservation-refused")
        } else {
          const result = `Launch reservation refused: review is ${current.status}. Approval was not replayed.`
          this.store.ledger(request.slug, { type: "launch-reservation-refused", decisionId: request.id, status: current.status, result })
          this.noticeM(request.sessionID, M.launchOutcome(request.slug, current.status, result))
          await this.transcript(request.sessionID, `◎ ${result}`)
        }
        return
      }
      this.store.ledger(request.slug, { type: "launch-reserved", decisionId: request.id, sessionID: request.sessionID, lock: request.lock, fresh: request.fresh })
      this.launchActivity(request.id, { phase: "starting", since: Date.now(), detail: "Owner-approved admission starting; no new run exists yet.", completed: 0, total: 0 })
      await this.transcript(request.sessionID, `◎ Launch ${request.slug}: owner-approved admission starting (decision ${request.id}). Rehearsing checks before creating a new run; this is not running yet.`)
      const binding = { expectedLock: request.lock, decisionId: request.id }
      const result = request.fresh ? await this.startClean(request.sessionID, request.slug, binding) : await this.startGoal(request.sessionID, request.slug, "tool", binding)
      const ok = result.startsWith('Goal "') || result.startsWith("Started clean")
      await this.launchDisposition(request, ok ? "succeeded" : "failed", result, ok ? "launch-succeeded" : "launch-failed")
      this.store.ledger(request.slug, { type: "launch-resolved", decisionId: request.id, sessionID: request.sessionID, lock: request.lock, fresh: request.fresh, ok, result })
    } catch (error) {
      const result = String(error)
      await this.launchDisposition(request, "failed", result, "launch-failed")
      this.store.ledger(request.slug, { type: "launch-resolved", decisionId: request.id, ok: false, result })
    }
  }

  private ownedLaunchQuestion(sessionID: string, input: any): boolean {
    const q = input?.questions
    if (!Array.isArray(q) || q.length !== 1 || !Array.isArray(q[0]?.options)) return false
    return this.launches.all(sessionID).some((p) => p.status === "pending" && p.expiresAt >= Date.now() && p.question === q[0].question && q[0].options.length === launchChoices.length && launchChoices.every((c) => q[0].options.some((o: any) => o.label === c.label)))
  }

  private ownedAmendmentQuestion(sessionID: string, input: any): boolean {
    const q = input?.questions
    if (!Array.isArray(q) || q.length !== 1 || !Array.isArray(q[0]?.options)) return false
    return this.amendmentReviews.all(sessionID).some((p) => { const choices = this.amendmentReviews.choicesFor(p); return p.status === "pending" && !reviewExpired(p) && p.question === q[0].question && q[0].options.length === choices.length && choices.every((c) => q[0].options.some((o: any) => o.label === c.label)) })
  }

  private ownedDecisionQuestion(sessionID: string, input: any): boolean {
    const q = input?.questions
    if (!Array.isArray(q) || q.length !== 1 || !Array.isArray(q[0]?.options)) return false
    return this.decisions.all(sessionID).some((p) => p.status === "pending" && !reviewExpired(p) && p.question === q[0].question && q[0].options.length === p.message.choices.length && p.message.choices.every((c) => q[0].options.some((o: any) => o.label === c.label)))
  }

  private async resolveDecisionForm(request: DecisionRequest, answer: Record<string, unknown>) {
    if (!["pending", "expired"].includes(request.status) || request.issuerPID !== process.pid && processAlive(request.issuerPID)) return
    if (request.status === "expired" || reviewExpired(request)) {
      const message = "Decision review expired; nothing executed. Request the exact review again."
      this.decisions.update(request.id, { status: "expired", result: message })
      this.store.ledger(request.slug, { type: "decision-form-operation-failed", decision: request.id, ok: false, message })
      this.noticeM(request.sessionID, M.ownerOperationFailed(message))
      void this.rpc?.events.emit("decision.failed", { sessionID: request.sessionID, decisionId: request.id, message }).catch(() => {})
      return
    }
    const selected = selectedReviewChoice(request, decisionChoices(request), answer)
    const chosen = selected ? request.message.choices[Number(selected.value)] : undefined
    this.store.ledger(request.slug, { type: "decision-form-answered", decision: request.id, kind: request.kind, picked: chosen?.label ?? "(commentary)", ...(chosen?.act ? { act: chosen.act } : {}) })
    if (chosen?.act) {
      void this.ownerAct(request.sessionID, chosen.act as any, chosen.arg, "form", request.id).then((result) => {
        if (!result.ok) {
          this.store.ledger(request.slug, { type: "decision-form-operation-failed", decision: request.id, action: chosen.act, ok: false, message: result.message })
          this.noticeM(request.sessionID, M.ownerOperationFailed(result.message))
          void this.rpc?.events.emit("decision.failed", { sessionID: request.sessionID, decisionId: request.id, message: result.message }).catch(() => {})
        }
      }).catch((error) => this.noticeM(request.sessionID, M.ownerOperationFailed(String(error))))
    } else {
      const value = request.fieldKey ? answer[request.fieldKey] : undefined
      if (request.kind === "owner-operation" && chosen?.label === "Cancel operation") {
        this.decisions.update(request.id, { status: "rejected", result: "Owner cancelled; no operation executed." })
        if (this.pendingDecisions.get(request.sessionID)?.id === request.id) this.pendingDecisions.delete(request.sessionID)
        if (this.pendingFormDecisions.get(request.sessionID)?.decisionId === request.id) this.pendingFormDecisions.delete(request.sessionID)
        this.store.ledger(request.slug, { type: "decision-declined", decision: request.id, actionExecuted: false })
        void this.rpc?.events.emit("decision.resolved", { sessionID: request.sessionID, kind: request.kind, decisionId: request.id, via: "form-guidance" }).catch(() => {})
        return
      }
      this.decisions.interruptForm(request.id)
      this.decisions.update(request.id, { comment: typeof value === "string" ? value : "Invalid answer; no operation authorized.", result: "Guidance/commentary only; the owner decision is still open." })
      this.pendingFormDecisions.delete(request.sessionID)
      // Do not claim resolution or close the other surface. The same
      // unresolved decision remains recoverable and will be re-presented.
    }
  }

  /**
   * v0.8.0 C3: a stale decision is silenced, never re-presented. "Stale" is
   * answered/expired/superseded or bound to a generation that moved; a merely
   * dismissed review (interrupted) is still unanswered and is restored.
   */
  private silenceDecision(request: DecisionRequest, stale: { code: string; reason: string }) {
    if (stale.code === "answered") return
    const status = stale.code === "expired" ? "expired" : stale.code === "superseded" ? "cancelled" : "failed"
    this.decisions.update(request.id, { status: status as any, result: stale.reason })
    this.store.ledger(request.slug, { type: "decision-silenced", decision: request.id, kind: request.kind, code: stale.code, reason: stale.reason, actionExecuted: false })
  }

  private async recoverDecisions() {
    const api = (this.ctx.session as any).form
    for (const p of this.decisions.all()) {
      if (p.issuerPID !== process.pid && processAlive(p.issuerPID)) continue
      if (p.status === "executing") {
        // Lifecycle actions are not blindly replayable after a crash.
        this.decisions.update(p.id, { status: "failed", result: "Operation interrupted with an uncertain outcome. Inspect target state before a new owner operation." })
        this.store.ledger(p.slug, { type: "decision-operation-interrupted", decision: p.id, ok: false })
        continue
      }
      if (!["pending", "interrupted"].includes(p.status)) continue
      const current = this.decisionTarget(p.slug)
      const stale = staleDecision(p, p.target, current)
      if (stale.stale) { this.silenceDecision(p, stale); continue }
      this.publishDecision(p)
      if (p.formID && typeof api?.get === "function") {
        try {
          const form = await api.get({ sessionID: p.sessionID, formID: p.formID })
          if (form.state?.status === "answered") { await this.resolveDecisionForm(p, form.state.answer); continue }
          if (form.state?.status === "pending") { this.factsOf(p.sessionID).forms.add(p.formID); continue }
        } catch { /* Core question forms can disappear on reload. */ }
      }
      const next = this.decisions.reopenForm(p.id)
      if (next) await this.askDecisionForm(next.sessionID, next.slug, next.kind, next.id, next.message)
    }
  }

  private async reviewDecision(sessionID: string, decisionId?: string) {
    const amendment = decisionId ? this.amendmentReviews.get(decisionId) : this.amendmentReviews.all(sessionID).filter((p) => ["pending", "interrupted", "expired"].includes(p.status)).sort((a, b) => b.createdAt - a.createdAt)[0]
    const launch = decisionId ? this.launches.get(decisionId) : this.launches.all(sessionID).filter((p) => ["pending", "interrupted", "expired"].includes(p.status)).sort((a, b) => b.createdAt - a.createdAt)[0]
    const decision = decisionId ? this.decisions.get(decisionId) : this.decisions.all(sessionID).filter((p) => ["pending", "interrupted", "expired"].includes(p.status)).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (amendment && (decisionId || amendment.createdAt >= Math.max(launch?.createdAt ?? 0, decision?.createdAt ?? 0))) return this.reviewAmendment(sessionID, amendment)
    if (launch && (decisionId || !decision || launch.createdAt >= decision.createdAt)) return this.reviewLaunch(sessionID, launch)
    const request = decisionId ? this.decisions.get(decisionId) : this.decisions.all(sessionID).filter((p) => ["pending", "interrupted", "expired"].includes(p.status)).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!request || request.sessionID !== sessionID) throw new Error("No pending engine decision in this session; inspect the selected goal's status.")
    // A settled operation can legitimately change target status; report its
    // receipt before comparing the still-unanswered review's mutable target.
    if (!["pending", "interrupted", "expired"].includes(request.status))
      throw new Error(`Decision review is ${request.status}; old choices cannot be replayed. ${request.result ?? "Inspect the recorded outcome; no operation executed."}`)
    const current = this.decisionTarget(request.slug)
    // v0.8.0 C3: expired / superseded / already-answered decisions are never
    // re-presented. The caller can request a fresh review only through the
    // operation that creates a new decision, never by replaying this one.
    const stale = staleDecision(request, request.target, current)
    if (stale.stale) {
      this.silenceDecision(request, stale)
      throw new Error(`${stale.reason}. No decision was re-presented; inspect the current goal status or request a fresh review.`)
    }
    if (current.lock !== request.target.lock || current.runId !== request.target.runId || current.sessionID !== request.target.sessionID || current.status !== request.target.status) throw new Error("The reviewed target changed; old choices cannot be reused. Inspect current goal status.")
    // Legacy rejected-criterion forms offered approval without its ID. A
    // failed choice is not consent for a newly inferred argument: replace
    // only the exact stopped target with a fresh criterion-bound question.
    if (request.kind === "needs_review" && request.message.choices.some((c) => c.act === "approve" && !c.arg)) {
      if (!["pending", "interrupted", "expired"].includes(request.status)) throw new Error("The old review has an uncertain outcome; inspect status rather than replay it.")
      const state = [...this.runs.values()].find((s) => s.slug === request.slug)
      const contract = state && this.contractOf(state)
      const ids = request.extra.criteria
      if (!state || state.status !== "needs_review" || !contract || !Array.isArray(ids) || !ids.length
        || ids.some((id) => typeof id !== "string" || !contract.criteria.some((c) => c.id === id)))
        throw new Error("The legacy review lacks validated criterion identities; no approval or new review was inferred.")
      if (request.formID) await (this.ctx.session as any).form?.cancel?.({ sessionID, formID: request.formID }).catch(() => {})
      this.pendingFormDecisions.delete(sessionID)
      this.decide(sessionID, request.slug, "needs_review", M.needsReview(state.reason ?? "criterion review", [...new Set(ids)]), request.extra)
      this.store.ledger(request.slug, { type: "decision-review-replaced", previousDecision: request.id, reason: "legacy approval missing criterion; new explicit owner choice required" })
      return "Legacy unbound approval replaced with a new criterion-specific native review. The old answer was not replayed; nothing was approved or executed."
    }
    if (request.status === "pending" && request.formID) return "The exact review is already present in the native composer. No operation was authorized or executed."
    this.decisions.reopenForm(request.id)
    this.pendingFormDecisions.delete(sessionID)
    this.publishDecision(request)
    await this.askDecisionForm(sessionID, request.slug, request.kind, request.id, request.message)
    return "The same pending decision has been re-presented natively. No choice, approval, rejection or operation was inferred."
  }

  private async proposeAmendment(sessionID: string, input: { slug: string; expectedLock: string; yaml: string; rationale: string }) {
    const outcome = await this.serial(() => {
      const state = [...this.runs.values()].find((s) => s.slug === input.slug)
      if (!state) throw new Error("No live run for the selected goal")
      const unavailable = ownerCan(state, "amend")
      if (unavailable) throw new Error(unavailable)
      if (this.amendmentReviews.all().some((p) => p.slug === state.slug && p.status === "executing")) throw new Error("An owner-accepted amendment is committing; recover it before another proposal")
      if (state.lock !== input.expectedLock) throw new Error("Amendment targets a stale lock; re-read the selected goal")
      if (state.status === "verifying") throw new Error("The selected goal is verifying; wait for its verdict before proposing a generation")
      // An unanswered review holds a paused author's turn too; offering a
      // fresh diff there is not execution or transfer of the old consent.
      if (state.sessionID !== sessionID && this.factsOf(state.sessionID).busy && state.status !== "paused") throw new Error("The selected goal is executing elsewhere; pause it before proposing an amendment")
      const disk = this.store.readContract(state.slug)
      if (!disk?.contract || disk.lock !== state.lock) throw new Error("Disk contract differs from the locked goal; resolve the existing edit before staging")
      const next = parseContract(input.yaml, { slug: state.slug })
      if (!next.contract) throw new Error(`Invalid amendment; current contract unchanged:\n${formatIssues(next.issues)}`)
      if (next.lock === state.lock) throw new Error("Nothing changed; no amendment staged")
      const diff = amendmentDiff(disk.contract, next.contract)
      // Owner-set autonomy: inside the launched policy the agent applies the
      // change itself (journalled, owner-revertible). Anything outside it,
      // including the policy itself, is routed to the owner below.
      const policy = disk.contract.autonomy.amend
      const change = classifyChange(disk.contract, next.contract)
      const allowed = policyAllows(policy, change)
      if (allowed.ok) return { applied: this.applyByPolicy(sessionID, state, disk.contract, next.contract, next.lock, input.yaml, input.rationale, change.classes, false) }
      const outsidePolicy = policy.length ? allowed.reasons : []
      // A proposal is not permission to mutate the oracle. Stop the target
      // under its OLD contract while the exact diff is being reviewed.
      const now = Date.now()
      const p = this.amendmentReviews.create({
        sessionID, targetSessionID: state.sessionID, slug: state.slug, runId: state.runId,
        lock: state.lock, nextLock: next.lock, nextText: input.yaml, rationale: input.rationale,
        diff, title: next.contract.title, createdAt: now, expiresAt: 0, expiryPolicy: "target", issuerPID: process.pid,
        question: [
          `Amend ${state.slug} (run ${state.runId})?`,
          `From SHA256 ${state.lock} to ${next.lock}.`, `Rationale: ${input.rationale}`,
          diff.summary, diff.details,
          "Only acceptance re-locks this exact diff. Reject/comment leaves the current contract unchanged; no choice resumes the run.",
        ].join("\n\n"),
      })
      // Only stop/mutate the run AFTER the proposal receipt is durable. A
      // failed store reservation must not leave memory paused and disk running.
      clearTimeout(this.timers.get(state.sessionID))
      setStatus(state, "paused", "amendment staged; awaiting owner review")
      state.amendments.push({ change: diff.summary, rationale: `staged proposal ${p.id}`, at: now, status: "proposed" })
      this.persist(state)
      this.invalidateOldDecision(state, "superseded by a staged amendment review; old contract remains locked")
      this.store.ledger(state.slug, { type: "amendment-staged", decisionId: p.id, sessionID, runId: p.runId, lock: p.lock, nextLock: p.nextLock, summary: diff.summary, ...(outsidePolicy.length ? { outsidePolicy } : {}) })
      return { staged: p, outsidePolicy }
    })
    if (!outcome) throw new Error("Amendment staging produced no outcome; nothing changed")
    if (outcome.applied) return outcome.applied
    const proposal = outcome.staged!
    await this.presentAmendment(proposal)
    return { decisionId: proposal.id, slug: proposal.slug, runId: proposal.runId, lock: proposal.lock, nextLock: proposal.nextLock, diff: proposal.diff, status: "pending",
      ...(outcome.outsidePolicy?.length ? { outsidePolicy: outcome.outsidePolicy } : {}),
      message: `${outcome.outsidePolicy?.length ? `This change is outside the owner-set autonomy policy (${outcome.outsidePolicy.join("; ")}), so it was routed to the owner. ` : ""}Validated amendment staged without changing goal.yaml. Show the exact diff in the Composer; resolve the owner's actual chat with goal_resolve_amendment or the native review. No sidebar Accept or manual command is required; acceptance alone does not resume.` }
  }

  /** Apply an in-policy change for the agent: the same write-ahead journal
   * and commit as an owner acceptance, recorded as appliedBy agent-policy.
   * Runs inside serial(). The owner can undo it with /goal revert. */
  private applyByPolicy(sessionID: string, state: RunState, prior: Contract, next: Contract, nextLock: string, nextText: string, rationale: string, classes: string[], recovery: boolean) {
    const now = Date.now(), oldLock = state.lock
    const diff = amendmentDiff(prior, next)
    const kind = recovery ? "divergence recovery" : "amendment"
    const p = this.amendmentReviews.create({
      sessionID, targetSessionID: state.sessionID, slug: state.slug, runId: state.runId, lock: oldLock, nextLock, nextText, rationale,
      diff, title: next.title, createdAt: now, expiresAt: 0, expiryPolicy: "target", issuerPID: process.pid,
      question: `Agent-applied ${kind} of ${state.slug} under the owner-set autonomy policy (${classes.join(", ")}).`,
      appliedBy: "agent-policy", policyClasses: classes,
    }, { keepOthers: true })
    if (!this.amendmentReviews.reserve(p.id)) throw new Error("Could not reserve the policy amendment; nothing applied")
    const result = amendedState(state, prior, next, nextLock, `agent policy (${classes.join(", ")}): ${recovery ? "adopted out-of-band disk contract" : rationale} [${p.id}]`, now)
    const approved = this.amendmentReviews.writeAhead(p.id, { state: result, acceptedAt: now })
    try {
      const applied = this.store.commitAmendment(approved)
      Object.assign(state, applied)
      delete state.claim
      delete state.verdict
      if (!next.priority) delete state.priority
      this.loaded.set(state.slug, { contract: next, lock: nextLock, text: nextText })
      this.persist(state)
    } catch (error) {
      this.store.ledger(state.slug, { type: "amendment-commit-interrupted", decisionId: p.id, error: String(error) })
      throw new Error(`Policy amendment commit interrupted; its journal is kept for recovery on reload: ${String(error)}`)
    }
    this.amendmentReviews.update(p.id, { status: "succeeded", result: `Applied by the agent under the owner-set policy (${classes.join(", ")}); the owner may undo it with /goal revert ${state.slug}.` })
    this.retireAmendmentReviews(approved)
    this.invalidateOldDecision(state)
    if (recovery) this.store.ledger(state.slug, { type: "divergence-adopted", by: "agent-policy", decisionId: p.id, oldLock, newLock: nextLock, policyClasses: classes })
    this.noticeM(state.sessionID, M.policyApplied(kind, classes.join(", "), diff.summary, state.slug))
    this.emitUpdate(state)
    return { ok: true, applied: true, appliedBy: "agent-policy", decisionId: p.id, slug: state.slug, runId: state.runId, lock: oldLock, nextLock, policyClasses: classes, diff,
      message: `Applied under the owner-set autonomy policy (${classes.join(", ")}); journalled as ${p.id} and revertible by the owner. Re-read the contract before continuing.` }
  }

  private async divergenceProvenance(state: RunState, diskLock: string): Promise<string[]> {
    const lines: string[] = []
    try { lines.push(`goal.yaml last modified ${new Date(statSync(this.store.contractPath(state.slug)).mtimeMs).toISOString()}`) } catch { lines.push("goal.yaml modification time unknown") }
    const journalled = this.store.recent(state.slug, 5000).some((e) => e.type === "amended" && e.newLock === diskLock)
    lines.push(journalled ? "a journalled amendment previously produced these bytes" : "no journalled acceptance produced these bytes; the writer is unknown (edited outside the engine)")
    const matching = this.amendmentReviews.all().filter((p) => p.slug === state.slug && p.nextLock === diskLock && !p.recovery)
    for (const p of matching) {
      let author = "unavailable"
      try { const info: any = await this.ctx.session.get({ sessionID: p.sessionID } as any); if ((info?.data ?? info)?.id) author = "live" } catch { /* removed or unknown */ }
      lines.push(`proposal ${p.id} (status ${p.status}; ${p.commit ? "commit recorded" : "no commit: it was never accepted"}) from session ${p.sessionID} (author session ${author}) proposed exactly these bytes`)
    }
    if (!matching.length) lines.push("no staged proposal matches these bytes")
    return lines
  }

  /** Disk goal.yaml differs from the locked generation (an unjournalled edit).
   * Any live session of the project may ask; the owner reviews the exact
   * difference and adopts, restores or leaves it. Within an owner-set policy
   * that includes `recover`, an in-policy difference is adopted directly. */
  private async recoverDivergence(sessionID: string, input: { slug: string; expectedLock: string }) {
    const outcome = await this.serial(async () => {
      const state = [...this.runs.values()].find((s) => s.slug === input.slug && !isTerminal(s.status))
      if (!state) throw new Error("No live run for the selected goal")
      if (state.lock !== input.expectedLock) throw new Error("Recovery targets a stale lock; re-read the selected goal")
      if (state.status === "verifying") throw new Error("The selected goal is verifying; wait for its verdict before recovering")
      if (this.amendmentReviews.all().some((p) => p.slug === state.slug && p.status === "executing")) throw new Error("An accepted amendment is committing; reload to recover it first")
      const disk = this.store.readContract(state.slug)
      if (!disk) throw new Error("No goal.yaml on disk for the selected goal")
      if (disk.lock === state.lock) throw new Error("The disk contract does not differ from the locked generation; nothing to recover.")
      if (!disk.contract) throw new Error(`The disk contract is invalid, so it cannot be adopted:\n${formatIssues(disk.issues)}`)
      const locked = this.contractOf(state)
      if (!locked) throw new Error("The locked contract snapshot is unavailable; nothing changed")
      const change = classifyChange(locked, disk.contract)
      const allowed = policyAllows(locked.autonomy.amend, change, true)
      if (allowed.ok) return { applied: this.applyByPolicy(sessionID, state, locked, disk.contract, disk.lock, disk.text, "out-of-band disk edit", change.classes, true) }
      const provenance = await this.divergenceProvenance(state, disk.lock)
      const diff = amendmentDiff(locked, disk.contract)
      const now = Date.now()
      const p = this.amendmentReviews.create({
        sessionID, targetSessionID: state.sessionID, slug: state.slug, runId: state.runId, lock: state.lock, nextLock: disk.lock, nextText: disk.text,
        rationale: "recover an out-of-band disk contract", diff, title: disk.contract.title, createdAt: now, expiresAt: 0, expiryPolicy: "target", issuerPID: process.pid,
        recovery: { provenance },
        question: [
          `Recover the divergent contract of ${state.slug} (run ${state.runId})?`,
          `Locked SHA256 ${state.lock}; disk SHA256 ${disk.lock}. The disk file differs from the locked generation.`,
          `Provenance:\n${provenance.map((l) => `- ${l}`).join("\n")}`,
          diff.summary, diff.details,
          "Adopt makes the disk bytes a new journalled generation; Restore writes the locked bytes back and keeps the disk bytes as evidence; Leave changes nothing. No earlier proposal or approval counts as acceptance; the goal stays stopped.",
        ].join("\n\n"),
      })
      if (isActive(state.status)) {
        clearTimeout(this.timers.get(state.sessionID))
        setStatus(state, "paused", "divergent disk contract under owner review")
      }
      this.persist(state)
      this.invalidateOldDecision(state, "superseded by a divergence recovery review")
      this.store.ledger(state.slug, { type: "divergence-staged", decisionId: p.id, sessionID, runId: state.runId, lock: state.lock, diskLock: disk.lock, provenance, ...(locked.autonomy.amend.length ? { outsidePolicy: allowed.reasons } : {}) })
      return { staged: p, outsidePolicy: locked.autonomy.amend.length ? allowed.reasons : [] }
    })
    if (outcome.applied) return outcome.applied
    const p = outcome.staged!
    await this.presentAmendment(p)
    const live = [...this.runs.values()].find((s) => s.slug === p.slug && s.runId === p.runId)
    return { decisionId: p.id, slug: p.slug, runId: p.runId, lock: p.lock, diskLock: p.nextLock, ...(live ? { target: this.targetOf(live) } : {}), diff: p.diff, provenance: p.recovery!.provenance, status: "pending",
      ...(outcome.outsidePolicy?.length ? { outsidePolicy: outcome.outsidePolicy } : {}),
      message: "Divergence recovery review offered natively (Adopt disk version / Restore locked version / Leave unchanged). Show it to the owner; no earlier proposal or approval is counted, and the goal stays stopped." }
  }

  private async resolveRecovery(request: AmendmentRequest, answer: Record<string, unknown>) {
    const choice = selectedReviewChoice(request, recoveryChoices, answer)
    if (!choice || choice.value === "leave") {
      this.amendmentReviews.update(request.id, { status: "rejected", result: "Owner left the divergence unchanged; nothing applied." })
      this.store.ledger(request.slug, { type: "divergence-left", by: "owner", decisionId: request.id, lock: request.lock, diskLock: request.nextLock })
      return
    }
    await this.serial(() => {
      const state = this.runs.get(request.targetSessionID), disk = this.store.readContract(request.slug)
      if (!state || isTerminal(state.status) || state.runId !== request.runId || state.lock !== request.lock || !disk || disk.lock !== request.nextLock) {
        this.amendmentReviews.update(request.id, { status: "failed", result: "Run or disk contract changed since review; nothing applied." })
        this.store.ledger(request.slug, { type: "divergence-recovery-failed", decisionId: request.id, reason: "review binding changed" })
        this.noticeM(request.sessionID, M.divergenceChanged())
        return
      }
      if (!this.amendmentReviews.reserve(request.id)) return
      const locked = this.contractOf(state)!
      if (choice.value === "adopt") {
        const next = parseContract(request.nextText, { slug: request.slug })
        const acceptedAt = Date.now()
        const stopped = structuredClone(state)
        setStatus(stopped, "paused", "owner adopted the disk contract; resume when ready")
        const result = amendedState(stopped, locked, next.contract!, request.nextLock, `owner adopted out-of-band disk contract (recovery ${request.id})`, acceptedAt)
        const approved = this.amendmentReviews.writeAhead(request.id, { state: result, acceptedAt })
        try {
          const applied = this.store.commitAmendment(approved)
          Object.assign(state, applied)
          delete state.claim
          delete state.verdict
          if (!next.contract!.priority) delete state.priority
          this.loaded.set(state.slug, { contract: next.contract!, lock: next.lock, text: request.nextText })
          this.persist(state)
          this.amendmentReviews.update(request.id, { status: "succeeded", result: `Adopted the disk contract as ${state.lock}; the goal stays paused.` })
          this.retireAmendmentReviews(approved)
          this.invalidateOldDecision(state)
          this.store.ledger(request.slug, { type: "divergence-adopted", by: "owner", decisionId: request.id, oldLock: request.lock, newLock: request.nextLock })
          this.noticeM(request.sessionID, M.divergenceAdopted(request.slug))
          this.emitUpdate(state)
        } catch (error) {
          this.store.ledger(request.slug, { type: "amendment-commit-interrupted", decisionId: request.id, error: String(error) })
          this.noticeM(request.sessionID, M.amendmentInterrupted())
        }
        return
      }
      try {
        const kept = this.store.restoreLocked(request.slug, request.runId, request.lock, { text: disk.text, lock: disk.lock })
        this.amendmentReviews.update(request.id, { status: "succeeded", result: `Restored the locked contract ${request.lock}; the disk bytes are kept at ${kept}.` })
        for (const other of this.amendmentReviews.all())
          if (other.id !== request.id && other.slug === request.slug && other.runId === request.runId && other.lock === request.lock
            && other.nextLock === request.nextLock && ["pending", "interrupted"].includes(other.status)) {
            this.amendmentReviews.update(other.id, { status: "cancelled", result: `Owner restored the locked generation (recovery ${request.id}); this proposal was not accepted.` })
            this.store.ledger(request.slug, { type: "amendment-review-superseded", decisionId: other.id, restoredBy: request.id, actionExecuted: false })
          }
        this.store.ledger(request.slug, { type: "divergence-restored", by: "owner", decisionId: request.id, lock: request.lock, discardedLock: disk.lock, kept })
        this.noticeM(request.sessionID, M.divergenceRestored(request.slug))
        this.emitUpdate(state)
      } catch (error) {
        this.amendmentReviews.update(request.id, { status: "failed", result: `Restore failed; nothing written: ${String(error)}` })
        this.store.ledger(request.slug, { type: "divergence-recovery-failed", decisionId: request.id, reason: String(error) })
      }
    })
  }

  /** Owner undo of the latest agent-policy generation: the prior locked bytes
   * become a new journalled generation. Never available to the agent. */
  private revertPolicyChange(state: RunState): { ok: boolean; message: string } {
    const last = this.amendmentReviews.all().filter((p) => p.slug === state.slug && p.runId === state.runId && p.appliedBy === "agent-policy"
      && p.status === "succeeded" && p.commit && p.nextLock === state.lock).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!last) return { ok: false, message: "No agent-applied change is the current generation of this goal; nothing to revert." }
    const disk = this.store.readContract(state.slug), current = this.contractOf(state)
    if (!disk || disk.lock !== state.lock || !current) return { ok: false, message: disk && disk.lock !== state.lock ? this.divergenceRefusal(state, { diskLock: disk.lock }) : "The disk contract is unavailable; nothing reverted." }
    const priorText = this.store.lockedText(state.slug, state.runId, last.lock)
    const prior = parseContract(priorText, { slug: state.slug })
    if (!prior.contract || prior.lock !== last.lock) return { ok: false, message: "The prior generation snapshot is unavailable; nothing reverted." }
    const now = Date.now()
    const p = this.amendmentReviews.create({
      sessionID: state.sessionID, targetSessionID: state.sessionID, slug: state.slug, runId: state.runId, lock: state.lock, nextLock: prior.lock, nextText: priorText,
      rationale: `owner reverted agent-policy change ${last.id}`, diff: amendmentDiff(current, prior.contract), title: prior.contract.title, createdAt: now, expiresAt: 0,
      expiryPolicy: "target", issuerPID: process.pid, question: `Owner revert of agent-policy change ${last.id}.`, appliedBy: "owner-revert",
    }, { keepOthers: true })
    this.amendmentReviews.reserve(p.id)
    const result = amendedState(state, current, prior.contract, prior.lock, `owner reverted agent-policy change ${last.id}`, now)
    const approved = this.amendmentReviews.writeAhead(p.id, { state: result, acceptedAt: now })
    const applied = this.store.commitAmendment(approved)
    const from = state.lock
    Object.assign(state, applied)
    this.loaded.set(state.slug, { contract: prior.contract, lock: prior.lock, text: priorText })
    this.persist(state)
    this.amendmentReviews.update(p.id, { status: "succeeded", result: `Reverted to ${prior.lock}.` })
    this.store.ledger(state.slug, { type: "reverted", by: "owner", decisionId: p.id, revertedDecisionId: last.id, from, to: prior.lock })
    this.emitUpdate(state)
    return { ok: true, message: `Reverted ${state.slug} to ${prior.lock.slice(0, 12)} (undoing agent change ${last.id}); journalled as ${p.id}.` }
  }

  private async presentAmendment(request: AmendmentRequest) {
    const nativeForm = (this.ctx.session as any).form
    try {
      if (typeof nativeForm?.create === "function") {
        const form = await nativeForm.create({ sessionID: request.sessionID, title: `${request.recovery ? "Recover" : "Amend"} ${request.slug}?`, metadata: { goalDecisionID: request.id }, fields: [{ key: "action", title: request.question, type: "string", custom: true, options: [...this.amendmentReviews.choicesFor(request)] }] })
        this.amendmentReviews.bind(form)
        this.store.ledger(request.slug, { type: "amendment-review-presented", decisionId: request.id, formID: (form as any)?.id ?? null, sessionID: request.sessionID })
      } else {
        const payload = { questions: [{ header: "Goal", question: request.question, options: this.amendmentReviews.choicesFor(request).map((c) => ({ label: c.label, description: c.description })) }] }
        await this.ctx.session.prompt({ sessionID: request.sessionID, text: `Ask the owner with the question tool using this exact JSON. The host alone applies the selected amendment; do not edit goal.yaml or call an owner action afterwards.\nGOAL_FORM_JSON:${JSON.stringify(payload)}`, resume: true, metadata: { goal: { kind: "amendment-review", decisionId: request.id } } } as any)
        this.store.ledger(request.slug, { type: "amendment-review-dispatched", decisionId: request.id, sessionID: request.sessionID })
      }
    } catch (error) {
      this.store.ledger(request.slug, { type: "amendment-review-present-failed", decisionId: request.id, sessionID: request.sessionID, error: String(error).slice(0, 400) })
      throw error
    }
  }

  private async reviewAmendment(sessionID: string, request: AmendmentRequest) {
    if (request.sessionID !== sessionID) throw new Error("That amendment review belongs to another authoring session; nothing was reused.")
    if (request.issuerPID !== process.pid && processAlive(request.issuerPID)) throw new Error("Another live server owns this amendment review; inspect it there.")
    if (!["pending", "interrupted", "expired"].includes(request.status)) throw new Error(`Amendment review is ${request.status}; old approval cannot be replayed.`)
    const state = this.runs.get(request.targetSessionID), disk = this.store.readContract(request.slug)
    // T106/C2: when the disk differs from the lock the acceptance review
    // cannot apply, so re-presenting it only burns rounds. This cause is named
    // BEFORE the generic target-changed refusal, and only for this exact
    // run/lock generation.
    const divergent = state && state.runId === request.runId && state.lock === request.lock ? this.divergenceOf(state) : undefined
    if (state && divergent) {
      this.store.ledger(request.slug, { type: "amendment-review-divergent", decisionId: request.id, lock: request.lock, diskLock: divergent.diskLock, actionExecuted: false })
      throw new Error(this.divergenceRefusal(state, divergent))
    }
    if (!state || isTerminal(state.status) || state.runId !== request.runId || state.lock !== request.lock || !disk?.contract || disk.lock !== (request.recovery ? request.nextLock : request.lock))
      throw new Error("The reviewed amendment target changed; old choices cannot be reused.")
    if (request.status === "expired" || reviewExpired(request)) {
      if (request.status !== "expired") {
        this.amendmentReviews.update(request.id, { status: "expired", result: "Legacy timed review expired; nothing applied." })
        this.store.ledger(request.slug, { type: "amendment-review-expired", decisionId: request.id, actionExecuted: false })
      }
      const replacement = await this.proposeAmendment(sessionID, { slug: request.slug, expectedLock: request.lock, yaml: request.nextText, rationale: request.rationale })
      this.store.ledger(request.slug, { type: "amendment-review-replaced", decisionId: request.id, replacementDecisionId: replacement.decisionId, actionExecuted: false })
      return "Expired amendment review replaced by a validated native Composer review. A NEW real owner selection is required; no old approval was replayed."
    }
    if (request.formID && this.factsOf(sessionID).forms.has(request.formID)) return "The exact amendment review is already present in the native Composer; nothing applied."
    const next = this.amendmentReviews.reopenForm(request.id)
    if (!next) throw new Error("Amendment review changed while restoring it; inspect its receipt.")
    this.store.ledger(request.slug, { type: "amendment-review-restored", decisionId: request.id, previousFormID: request.formID, actionExecuted: false })
    await this.presentAmendment(next)
    return "The same exact amendment review is restored in the Composer. No approval, application or resume was inferred."
  }

  private async resolveAmendmentChat(sessionID: string, input: { decisionId: string; action: "accept" | "reject" | "comment"; continueGoal?: boolean }) {
    const resolved = await this.serial(async () => {
      const request = this.amendmentReviews.get(input.decisionId)
      if (!request || request.sessionID !== sessionID)
        throw new Error("No current amendment review owned by this Composer session; nothing authorized.")
      if (request.recovery) throw new Error("A divergence recovery is answered in its native review (Adopt disk version / Restore locked version / Leave unchanged); chat text is not mapped to it. Nothing authorized.")
      if (request.status === "executing") throw new Error("Amendment review is executing; inspect its outcome before acting. No approval was replayed.")
      if (!["pending", "interrupted"].includes(request.status)) return {
        alreadyResolved: true as const, request,
      }
      if (reviewExpired(request)) throw new Error("Amendment review has expired; request a fresh review. No old owner reply was consumed or replayed.")
      const state = this.runs.get(request.targetSessionID)
      if (!state || state.runId !== request.runId || state.lock !== request.lock || isTerminal(state.status))
        throw new Error("Reviewed target changed; no old owner reply can approve it.")
      const alternatives = [...this.amendmentReviews.all(sessionID), ...this.launches.all(sessionID), ...this.decisions.all(sessionID)]
        .filter((p) => p.id !== request.id && ["pending", "interrupted"].includes(p.status) && !reviewExpired(p))
      const divergent = this.divergenceOf(state)
      if (divergent) throw new Error(this.divergenceRefusal(state, divergent))
      const messages: any = await this.ctx.session.context({ sessionID } as any)
      const source = ownerAmendmentMessage(messages?.data ?? messages, request, input.action)
      if (!source || input.continueGoal && (input.action !== "accept" || !source.continueGoal))
        throw new Error("The latest actual owner chat does not authorize this action/continuation. Ask a genuine Composer clarification; no command or sidebar acceptance is required.")
      if (alternatives.length && (!source.explicitAmendment || alternatives.some((p) => this.amendmentReviews.get(p.id))))
        throw new Error("More than one review is pending; clarify the exact review in the Composer, not a sidebar.")
      const continueGoal = input.action === "accept" && source.continueGoal
      if ([...this.decisions.all(sessionID), ...this.launches.all(sessionID)].some((p) => p.ownerMessageID === source.id))
        throw new Error("That owner message was already consumed; no action replayed.")
      const bound = this.amendmentReviews.bindOwnerMessage(request.id, source.id)
      if (!bound) throw new Error("Owner message/review was already consumed or changed; no action executed.")
      this.store.ledger(request.slug, { type: "owner-message-consumed", ownerMessageID: source.id, decisionId: request.id,
        actorSessionID: sessionID, targetRunId: request.runId, lock: request.lock, nextLock: request.nextLock, action: input.action, continueGoal })
      return { request: bound, source, continueGoal }
    })
    if ("alreadyResolved" in resolved) return { ok: false, actionExecuted: false, alreadyResolved: true,
      decisionId: resolved.request.id, status: resolved.request.status,
      message: `Amendment review is ${resolved.request.status}; old approval cannot be replayed.`, ...(resolved.request.result ? { result: resolved.request.result } : {}) }
    await this.resolveAmendment(resolved.request, {}, { action: input.action, text: resolved.source.text, messageID: resolved.source.id })
    const after = this.amendmentReviews.get(resolved.request.id)!
    let continuation: { ok: boolean; message: string } | undefined
    if (resolved.continueGoal && after.status === "succeeded") {
      const live = this.runs.get(after.targetSessionID)
      const resumed = !!live && live.runId === after.runId && !isTerminal(live.status) && live.lock === after.nextLock
      continuation = { ok: resumed, message: resumed ? "Resumed the accepted generation." : "Accepted; the run was not resumable." }
      this.store.ledger(after.slug, { type: "amendment-chat-continuation", decisionId: after.id, ownerMessageID: resolved.source.id, lock: after.nextLock, ok: resumed, message: continuation.message })
    }
    if (resolved.request.formID) await (this.ctx.session as any).form?.cancel?.({ sessionID, formID: resolved.request.formID }).catch(() => {})
    return { ok: input.action === "accept" ? after.status === "succeeded" && (!continuation || continuation.ok) : ["rejected", "commented"].includes(after.status),
      decisionId: after.id, status: after.status, ownerMessageID: resolved.source.id, message: after.result, ...(continuation ? { continuation } : {}) }
  }

  private async resolveAmendment(request: AmendmentRequest, answer: Record<string, unknown>, ownerChat?: { action: "accept" | "reject" | "comment"; text: string; messageID: string }) {
    request = this.amendmentReviews.get(request.id) ?? request
    if (request.status !== "pending" || request.issuerPID !== process.pid && processAlive(request.issuerPID)) return
    if (request.recovery) {
      if (ownerChat) return
      return this.resolveRecovery(request, answer)
    }
    const value = ownerChat?.text ?? (request.fieldKey ? answer[request.fieldKey] : undefined)
    const choices = this.amendmentReviews.choicesFor(request)
    const selected = ownerChat ? choices.find((c) => c.value === ownerChat.action) : selectedReviewChoice(request, choices, answer)
    if (reviewExpired(request)) {
      this.amendmentReviews.update(request.id, { status: "expired", result: "Review expired; the locked contract is unchanged." })
      this.store.ledger(request.slug, { type: "amendment-review-expired", decisionId: request.id, sessionID: request.sessionID, actionExecuted: false })
      this.noticeM(request.sessionID, M.amendmentExpired())
      await this.transcript(request.sessionID, `◎ Amendment review ${request.id} expired; nothing applied. Request a fresh Composer review of this exact diff; the old approval cannot be replayed.`)
      return
    }
    if (selected?.value !== "accept") {
      const rejected = selected?.value === "reject"
      const comment = typeof value === "string" ? value : "Invalid response; revise and review again."
      this.amendmentReviews.update(request.id, { status: rejected ? "rejected" : "commented", comment, result: "No contract change authorized." })
      await this.serial(() => {
        const state = this.runs.get(request.targetSessionID)
        if (state?.runId === request.runId && state.lock === request.lock) {
          const entry = state.amendments.find((a) => a.rationale === `staged proposal ${request.id}` && a.status === "proposed")
          if (entry) { entry.status = "rejected"; entry.rationale = comment }
          this.persist(state)
        }
        this.store.ledger(request.slug, { type: "amendment-feedback", decisionId: request.id, status: rejected ? "rejected" : "commented", comment })
      })
      if (!rejected) await this.ctx.session.prompt({ sessionID: request.sessionID, text: `Owner commentary for amendment ${request.id} of ${request.slug}: ${JSON.stringify(comment)}. Nothing was accepted or resumed. Use goal_propose_amendment with a revised validated contract and the current lock; never edit goal.yaml directly.`, resume: true } as any)
      return
    }
    await this.serial(async () => {
      const state = this.runs.get(request.targetSessionID)
      const disk = this.store.readContract(request.slug)
      const next = parseContract(request.nextText, { slug: request.slug })
      if (!state || state.runId !== request.runId || state.lock !== request.lock || isTerminal(state.status) || !disk?.contract || disk.lock !== request.lock || !next.contract || next.lock !== request.nextLock) {
        this.amendmentReviews.update(request.id, { status: "failed", result: "Target/run/contract changed since review; no amendment applied." })
        this.store.ledger(request.slug, { type: "amendment-resolution-failed", decisionId: request.id, reason: "review binding changed" })
        this.noticeM(request.sessionID, M.amendmentChanged())
        return
      }
      const reserved = this.amendmentReviews.reserve(request.id)
      if (!reserved) return
      const acceptedAt = Date.now()
      const stopped = structuredClone(state)
      setStatus(stopped, "paused", "owner accepted amendment; resume when ready")
      const result = amendedState(stopped, disk.contract, next.contract, request.nextLock, `owner accepted decision ${request.id}`, acceptedAt)
      const approved = this.amendmentReviews.writeAhead(request.id, { state: result, acceptedAt })
      try {
        const applied = this.store.commitAmendment(approved)
        Object.assign(state, applied)
        delete state.claim
        delete state.verdict
        if (!next.contract.priority) delete state.priority
        this.loaded.set(state.slug, { contract: next.contract, lock: next.lock, text: request.nextText })
        this.persist(state)
        this.amendmentReviews.update(request.id, { status: "succeeded", result: `Amended ${state.slug} to ${state.lock}; the goal resumes.` })
        this.retireAmendmentReviews(approved)
        if (ownerChat) this.store.ledger(request.slug, { type: "amendment-chat-resolved", decisionId: request.id, ownerMessageID: ownerChat.messageID, lock: state.lock, ok: true })
        this.invalidateOldDecision(state)
        // v0.8.0 C2: an accepted amendment resumes in the same act. No second
        // owner decision is created; the acceptance was the decision.
        await this.resumeAccepted(state, request.id)
        this.noticeM(request.sessionID, M.amended(state.amendments.filter((a) => a.status === "accepted").length, request.diff.summary))
      } catch (error) {
        // Keep executing+write-ahead receipt for recovery. Never report a
        // half-written generation as failed/finished or allow a new proposal.
        this.store.ledger(request.slug, { type: "amendment-commit-interrupted", decisionId: request.id, error: String(error) })
        this.noticeM(request.sessionID, M.amendmentInterrupted())
      }
    })
  }

  private recoverAmendmentCommits() {
    for (const p of this.amendmentReviews.all()) {
      if (p.status === "succeeded" && p.commit) { this.retireAmendmentReviews(p); continue }
      if (p.status !== "executing" || p.issuerPID !== process.pid && processAlive(p.issuerPID)) continue
      if (!p.commit) { this.amendmentReviews.update(p.id, { status: "failed", result: "Host interrupted before acceptance was journalled; review again." }); continue }
      // Conflicting third-generation bytes fail setup rather than admitting
      // a worker with an inconsistent approved contract/state pair.
      this.store.commitAmendment(p)
      this.amendmentReviews.update(p.id, { status: "succeeded", result: "Recovered owner-accepted amendment; the goal resumes." })
      this.recoveredAmendmentRuns.add(p.runId)
      this.retireAmendmentReviews(p)
    }
  }

  /** Only an applied, journalled generation retires conflicting unanswered
   * proposals. Staging in a live session alone spends no other author's review. */
  private retireAmendmentReviews(accepted: AmendmentRequest) {
    const state = this.store.readRun(accepted.slug)
    if (!accepted.commit || this.amendmentReviews.get(accepted.id)?.status !== "succeeded"
      || state?.runId !== accepted.runId || state.lock !== accepted.nextLock) return
    for (const other of this.amendmentReviews.all()) {
      if (other.id === accepted.id || other.slug !== accepted.slug || other.runId !== accepted.runId || other.lock !== accepted.lock
        || !["pending", "interrupted"].includes(other.status)) continue
      this.amendmentReviews.update(other.id, { status: "cancelled", result: `Generation accepted by ${accepted.id}; this unanswered proposal was superseded, not replayed.` })
      this.store.ledger(accepted.slug, { type: "amendment-review-superseded", decisionId: other.id, acceptedDecisionId: accepted.id,
        lock: accepted.lock, nextLock: accepted.nextLock, actionExecuted: false })
      const forms = this.factsOf(other.sessionID).forms
      // Plugin contexts can lack Core's form.cancel capability. Release
      // only a sole nonce-bound obsolete review, never an unrelated form.
      if (other.formID && forms.size === 1 && forms.has(other.formID))
        void this.ctx.session.interrupt({ sessionID: other.sessionID, resume: true }).catch((error) => {
          this.store.ledger(accepted.slug, { type: "amendment-review-release-failed", decisionId: other.id, error: String(error) })
        })
    }
  }

  private invalidateOldDecision(state: RunState, reason = "contract generation amended") {
    const pending = this.pendingDecisions.get(state.sessionID)
    this.pendingDecisions.delete(state.sessionID)
    this.pendingFormDecisions.delete(state.sessionID)
    if (pending) {
      const request = this.decisions.get(pending.id)
      if (request && ["pending", "interrupted"].includes(request.status)) this.decisions.update(request.id, { status: "cancelled", result: `Review invalidated: ${reason}.` })
      this.store.ledger(state.slug, { type: "decision-invalidated", decision: pending.id, reason })
      void this.rpc?.events.emit("decision.resolved", { sessionID: state.sessionID, kind: pending.kind, decisionId: pending.id, via: "amendment-invalidated" }).catch(() => {})
    }
  }

  private async recoverAmendmentReviews() {
    const api = (this.ctx.session as any).form
    for (const p of this.amendmentReviews.all()) {
      if (!["pending", "interrupted"].includes(p.status) || p.issuerPID !== process.pid && processAlive(p.issuerPID)) continue
      if (reviewExpired(p)) {
        this.amendmentReviews.update(p.id, { status: "expired", result: "Legacy timed review expired; the locked contract is unchanged." })
        this.store.ledger(p.slug, { type: "amendment-review-expired", decisionId: p.id, actionExecuted: false })
        await this.transcript(p.sessionID, `◎ Amendment review ${p.id} expired after reload; nothing applied. Request a fresh Composer review; no old approval will be replayed.`)
        continue
      }
      if (p.formID && typeof api?.get === "function") {
        try {
          const form = await api.get({ sessionID: p.sessionID, formID: p.formID })
          if (form.state?.status === "answered") { await this.resolveAmendment(p, form.state.answer); continue }
          if (form.state?.status === "pending") { this.factsOf(p.sessionID).forms.add(p.formID); continue }
          if (form.state?.status === "cancelled") this.amendmentReviews.interruptForm(p.id)
        } catch { /* Core forms can disappear on reload; retain exact review. */ }
      }
      const next = this.amendmentReviews.reopenForm(p.id)
      if (next) await this.presentAmendment(next)
    }
  }

  // ───────────────────────────── starting and admitting turns

  /**
   * T059: start clean. The engine creates a NEW session owned by the goal,
   * pins the run to that session (T049: the run map keys the new session) and
   * the kickoff admission prompts there — a fresh context with none of the
   * writing session's accumulated history. The invoking session is never
   * cleared (OpenCode exposes no clear-in-place API; that is a TUI command)
   * and stays untouched apart from one notice naming where to look.
   */
  private async startClean(fromSessionID: string, slug: string, options: StartOptions = {}): Promise<string> {
    // Not wrapped in serial(): startGoal below takes the queue, and the queue
    // is not reentrant — nesting would deadlock. session.create is safe
    // outside the queue; everything stateful flows through startGoal.
    let agent: string | undefined, model: Handoff["model"], fallback: string | undefined
    try {
      const info: any = await this.ctx.session.get({ sessionID: fromSessionID } as any)
      const source = info?.data ?? info
      if (typeof source.agent === "string") agent = source.agent
      if (typeof source.model?.providerID === "string" && typeof source.model?.id === "string") model = { providerID: source.model.providerID, id: source.model.id, ...(typeof source.model.variant === "string" ? { variant: source.model.variant } : {}) }
      if (!agent || !model) fallback = "Source model/agent unavailable in session metadata; the missing selection uses host defaults."
    } catch { fallback = "Source session metadata unavailable; the fresh session uses host defaults." }
    const created: any = await this.ctx.session.create({ title: `goal kickoff · ${slug}`, ...(agent ? { agent } : {}), ...(model ? { model } : {}) } as any)
    const targetID: string | undefined = created?.id ?? created?.data?.id
    if (!targetID) return `Could not open a new session for "${slug}" — nothing started. Run /goal start ${slug} in this session instead.`
    const handoff: Handoff = { fromSessionID, toSessionID: targetID, ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(fallback ? { fallback } : {}) }
    this.store.ledger(slug, { type: "clean-start-attempt", from: fromSessionID, to: targetID, ...(options.decisionId ? { decisionId: options.decisionId } : {}) })
    const message = await this.startGoal(targetID, slug, "command", { ...options, handoff })
    if (!message.startsWith("Goal \"")) return message
    const state = this.runs.get(targetID)!
    this.store.ledger(slug, { type: "clean-start", from: fromSessionID, to: targetID, runId: state.runId, ...(options.decisionId ? { decisionId: options.decisionId } : {}) })
    await this.transcript(fromSessionID, `◎ Goal ${slug} launched in a NEW root session ${targetID}. Original history remains here. Use the Goals manager or open that session to follow the run.${fallback ? ` Handoff fallback: ${fallback}` : ""}`)
    void this.rpc?.events.emit("handoff", { fromSessionID, toSessionID: targetID, slug, runId: state.runId, ...(fallback ? { fallback } : {}) }).catch(() => {})
    this.noticeM(fromSessionID, M.cleanStarted(targetID, slug))
    return `Started clean — ${message} The kickoff prompt landed in the new session "${targetID}"; this session stays untouched.`
  }

  async startGoal(sessionID: string, slug: string, source: "command" | "tool", options: StartOptions = {}): Promise<string> {
    return this.serial(() => this.startGoalLocked(sessionID, slug, source, options))
  }

  /** The start path without the queue lock — callable from inside ownerAct,
   *  which already holds it (the queue is not reentrant). */
  private async startGoalLocked(sessionID: string, slug: string, source: "command" | "tool", options: StartOptions = {}): Promise<string> {
    {
      const current = this.runs.get(sessionID)
      if (current && !isTerminal(current.status)) return current.slug === slug
        ? `Launch refused: the existing run ${current.runId} for "${current.slug}" is ${current.status}; no new run was started and the existing run is unchanged. Continue or manage that goal in the Composer; do not abort it just to retry launch.`
        : `Launch refused: this session owns "${current.slug}" (${current.status}); that run is unchanged. Manage it or request a fresh-session launch for "${slug}" rather than aborting a working goal.`
      for (const other of this.runs.values())
        if (other.slug === slug && !isTerminal(other.status) && other.sessionID !== sessionID) return `Goal "${slug}" is already ${other.status} in another session (${other.sessionID}).`
      const loaded = this.load(slug, true)
      if ("error" in loaded) return loaded.error
      const { contract, lock, text } = loaded
      if (options.expectedLock && lock !== options.expectedLock) return "Refused: contract changed after launch review; review the new locked bytes before starting."
      // T031: the supersession admission rule — a supersedes pointer must
      // resolve, match the predecessor's lock, and the predecessor must be
      // terminal (or the owner explicitly acknowledges superseding mid-flight).
      if (contract.supersedes) {
        const [oldSlug, lockPrefix] = contract.supersedes.split("@") as [string, string]
        const predecessorRun = this.store.readRun(oldSlug)
        const predecessorArchived = !predecessorRun && this.store.archivedSlugs().includes(oldSlug)
        if (!predecessorRun && !predecessorArchived) return `Refused: supersedes points at "${oldSlug}", but no such goal exists here (live or archived).`
        const predecessorLock = predecessorRun?.lock ?? ""
        if (predecessorRun && !predecessorLock.startsWith(lockPrefix!)) return `Refused: supersedes references ${oldSlug}@${lockPrefix}, but its run lock is ${predecessorLock.slice(0, 12)}… — the predecessor changed since the pointer was written; update the pointer.`
        if (predecessorRun && !isTerminal(predecessorRun.status) && !options.acknowledgeSupersede) {
          // T050: superseding a live predecessor is an explicit owner decision
          this.decide(sessionID, slug, "supersede-ack", M.supersedeAck(slug, oldSlug, predecessorRun.status), { predecessor: oldSlug })
          return `Refused: "${oldSlug}" is still ${predecessorRun.status}. Superseding a live predecessor forks the audit trail — abort it first, or start with /goal start ${slug} acknowledge-supersede to record your explicit acknowledgment.`
        }
        // flip the predecessor terminal, archive it (demote never delete), ledger both sides
        if (predecessorRun) {
          const liveState = [...this.runs.values()].find((s) => s.slug === oldSlug)
          if (liveState) {
            clearTimeout(this.timers.get(liveState.sessionID))
            setStatus(liveState, "superseded", `superseded by ${slug}`)
            this.runs.delete(liveState.sessionID)
          } else setStatus(predecessorRun, "superseded", `superseded by ${slug}`)
          const finalState = liveState ?? predecessorRun
          this.store.writeRun(finalState)
          this.store.ledger(oldSlug, { type: "superseded-by", by: slug, atLock: lock, acknowledged: !!options.acknowledgeSupersede })
          this.registry.update(this.rootReal, oldSlug, { title: finalState.title, status: "superseded", ...(finalState.runId ? { runId: finalState.runId } : {}), archived: true, updatedAt: Date.now() })
          this.store.archive(oldSlug)
        } else {
          this.store.ledger(oldSlug, { type: "superseded-by", by: slug, atLock: lock, acknowledged: !!options.acknowledgeSupersede, note: "predecessor was already archived" })
        }
        this.store.ledger(slug, { type: "supersession", of: oldSlug, atLock: lockPrefix, acknowledged: !!options.acknowledgeSupersede })
      }
      // T036: start-time rehearsal — run every command check once BEFORE
      // locking. A check whose text cannot run at all refuses the start; a
      // legitimate red check is recorded as the baseline (a bug-fix goal
      // SHOULD start red). The unrunnable signature is the shell's own
      // failure (exit 126/127 or a zsh:/bash: diagnostic) — never a tool's
      // stderr, so `grep missing-file` stays a valid red baseline.
      const commandChecks = [...contract.criteria, ...contract.invariants].filter((c) => c.check.kind === "command")
      // T100: resolve the exact-run execution workspace. Checks, the protect base
      // and the fingerprint all depend on git, so a workspace that is not itself a
      // git work-tree root inside the project refuses the start.
      const exec = this.executionRoot(contract)
      if (exec !== this.root && canonical(topLevel(exec) ?? "") !== canonical(exec))
        return `Refused to start "${slug}": workspace "${contract.workspace}" is not a git work-tree root inside the project. Use a linked worktree (e.g. .worktrees/<slug>) or omit workspace. Fix the contract and /goal start again.`
      const rehearsal: Array<{ id: string; pass: boolean; unrunnable: boolean; ms: number; detail: string }> = []
      this.launchActivity(options.decisionId, { phase: "rehearsal", since: Date.now(), detail: `Rehearsing ${commandChecks.length} command checks before run creation.`, completed: 0, total: commandChecks.length })
      for (const c of commandChecks) {
        const started = Date.now()
        this.launchActivity(options.decisionId, { phase: "check", since: started, detail: `Rehearsing ${c.id} (${rehearsal.length + 1}/${commandChecks.length}); no run yet.`, checkId: c.id, completed: rehearsal.length, total: commandChecks.length })
        const result = await runHostCheck(c.check, exec, headCommit(exec))
        if (this.disposed) return "Launch admission interrupted by host reload; no run created. Inspect the receipt and prepare a new review."
        const last = Array.isArray(result.raw) ? (result.raw as unknown[]).at(-1) as { exit?: number; stderr?: string } | undefined : undefined
        const unrunnable = Number(last?.exit) === 126 || Number(last?.exit) === 127 || /\b(zsh|bash|sh|dash):(\d+:)?\s.*(permission denied|command not found|no such file or directory)/i.test(String(last?.stderr ?? ""))
        rehearsal.push({ id: c.id, pass: result.pass, unrunnable, ms: Date.now() - started, detail: result.detail.slice(0, 400) })
        this.launchActivity(options.decisionId, { phase: "rehearsal", since: Date.now(), detail: `Rehearsed ${c.id}: ${unrunnable ? "unrunnable" : result.pass ? "pass" : "red baseline"} (${rehearsal.length}/${commandChecks.length}).`, completed: rehearsal.length, total: commandChecks.length })
        if (unrunnable) {
          this.store.ledger(slug, { type: "rehearsal-refused", id: c.id, exit: last?.exit, detail: result.detail.split("\n").slice(0, 3).join(" | ").slice(0, 300) })
          const diagnostic = String(last?.stderr ?? "").split("\n").find((l) => /permission denied|command not found|no such file/i.test(l)) ?? `exit ${last?.exit}`
          return `Refused to start "${slug}": the check command for ${c.id} cannot run — ${diagnostic.trim()}. Command checks must be runnable from the project root; keep each on ONE line (YAML folded scalars keep newlines before indented lines) and rehearse the stored command. Fix goal.yaml and /goal start again.`
        }
      }
      if (this.disposed) return "Launch admission interrupted by host reload; no run created."
      if (options.expectedLock) {
        const current = this.load(slug, true)
        if ("error" in current || current.lock !== options.expectedLock) return "Refused: contract changed during launch rehearsal; no run created. Prepare a new review."
      }
      const state = initialRun(contract, { sessionID, runId: newRunId(), lock, commit: headCommit(exec) })
      if (options.handoff) state.handoff = options.handoff
      state.fingerprint = fingerprint(exec)
      if (rehearsal.length) {
        this.store.evidence(slug, state.runId, "rehearsal", { at: Date.now(), results: rehearsal })
        this.store.ledger(slug, { type: "rehearsal", turn: 0, baseline: rehearsal.map((r) => ({ id: r.id, pass: r.pass })) })
      }
      // v0.8.0 D1: a fresh launch carries a handoff built from what the host
      // already knows, so the new session does not have to rediscover it.
      if (options.handoff) this.writeHandoff(state, contract, options.handoff, exec, rehearsal)
      this.store.evidence(slug, state.runId, "contract", { lock, text })
      await Bun.write(join(this.store.dir(slug), "evidence", state.runId, "contract.yaml"), text)
      this.runs.set(sessionID, state)
      this.store.ledger(slug, { type: "start", runId: state.runId, sessionID, source, lock, commit: state.base.commit, ...(options.decisionId ? { decisionId: options.decisionId } : {}) })
      // T027 / v0.5.0: record the CLEO linkage and health (CLI-only). A project
      // with no CLEO CLI records nothing and behaves EXACTLY as before; a project
      // with the CLI gets an honest state, and nothing is ever installed here.
      const health = await cleoHealth(this.root, defaultRunner)
      if (health.state !== "cli-absent") {
        const link = cleoLinkEvent(await cleoFacts(this.root, defaultRunner))
        if (link) this.store.ledger(slug, link)
        this.store.ledger(slug, { type: "cleo-health", state: health.state, ...(health.cli.version ? { version: health.cli.version } : {}), ...(health.projectId ? { projectId: health.projectId } : {}) })
      }
      this.persist(state)
      this.noticeM(sessionID, M.goalStarted(contract.title))
      if (!this.factsOf(sessionID).busy) await this.admit(state, "kickoff")
      return `Goal "${contract.title}" started (run ${state.runId}). The host drives the loop from here: work toward the outcome, record progress with goal_progress, and call goal_claim when every criterion holds.`
    }
  }

  /**
   * T038: owner-approved amendment. The owner edits goal.yaml out-of-band, then
   * `/goal amend` proposes (diff summary) and `/goal amend confirm` re-locks:
   * atomic generation-bound records, ledger trail, and the explicit branch
     * decision — prior evidence is retained for unchanged oracle semantics;
     * changed statements, checks or roles reset to unknown and re-verify.
   */
  private async amendGoal(state: RunState, confirmed: boolean): Promise<string> {
    const read = this.store.readContract(state.slug)
    if (!read) return `no contract on disk for ${state.slug}`
    if (!read.contract) return `goal.yaml for "${state.slug}" is invalid:\n${formatIssues(read.issues)}\nThe run keeps its current lock; fix goal.yaml and amend again.`
    const next = read.contract
    const nextLock = read.lock
    if (nextLock === state.lock) return "Nothing to amend: goal.yaml is byte-identical to the locked contract."

    const prior = this.contractOf(state)!
    const { unchanged, changed, added, removed, summary } = amendmentDiff(prior, next)

    if (!confirmed) {
      state.amendments.push({ change: summary, rationale: "proposed; awaiting /goal amend confirm", at: Date.now(), status: "proposed" })
      this.store.ledger(state.slug, { type: "amend-proposed", turn: state.turn, summary })
      this.persist(state)
      this.decide(state.sessionID, state.slug, "amend-proposed", M.amendProposed(summary))
      return `Proposed amendment: ${summary}\nReview the diff, then run /goal amend confirm to re-lock (generation ${state.amendments.filter((a) => a.status === "accepted").length + 1}).`
    }

    const generation = state.amendments.filter((a) => a.status === "accepted").length + 1
    const at = Date.now()
    const oldLock = state.lock
    // atomic, generation-bound record + evidence snapshot
    Object.assign(state, amendedState(state, prior, next, nextLock, "owner-confirmed via /goal amend confirm", at))
    delete state.claim
    delete state.verdict
    if (!next.priority) delete state.priority
    this.store.evidence(state.slug, state.runId, `amendment-${generation}-${at}`, { generation, oldLock, newLock: nextLock, at, by: "owner", summary, changed, added, removed, unchanged, contract: read.text })
    this.store.writeContractSnapshot(state.slug, state.runId, nextLock, read.text)
    // the in-memory contract cache must serve the amended contract from the next request on
    this.loaded.set(state.slug, { contract: next, lock: nextLock, text: read.text })
    this.store.ledger(state.slug, { type: "amended", turn: state.turn, generation, oldLock, newLock: nextLock, summary })
    this.persist(state)
    this.emitUpdate(state)
    this.invalidateOldDecision(state)
    this.noticeM(state.sessionID, M.amended(generation, summary))
    await this.transcript(state.sessionID, `◎ owner amended the contract (generation ${generation}): ${summary}. Changed criteria reset to unknown and re-verify on the next claim; re-read the contract before acting.`)
    return `Amended ${state.slug} (generation ${generation}): ${summary}. Changed criteria reset to unknown and re-verify on the next claim.`
  }

  /**
   * v0.8.0 C2: the accepted generation continues immediately. The run was
   * paused while its review was staged; this clears that pause, records the
   * resume, and admits the ordinary continuation — all in the acceptance act.
   * A verifying run is left alone (its verdict decides), and a terminal run is
   * never revived.
   */
  private async resumeAccepted(state: RunState, decisionId: string) {
    const live = this.runs.get(state.sessionID)
    if (!live || live.runId !== state.runId || isTerminal(live.status) || live.status === "verifying") return false
    if (!this.contractOf(live)) return false
    live.wait = undefined
    setStatus(live, "running", "owner accepted an amendment")
    this.store.ledger(live.slug, { type: "resumed", by: "owner amendment", decisionId, lock: live.lock, turn: live.turn })
    this.store.ledger(live.slug, { type: "amendment-resumed", decisionId, lock: live.lock, turn: live.turn })
    this.persist(live)
    await this.admit(live, "resume")
    return true
  }

  // ───────────────────────────── continuation (v0.8.0 C4/C5)

  private peerChannel(): PeerChannel | undefined {
    const identity = process.env.OCGOAL_PEER_IDENTITY
    if (!identity) return undefined
    this.peerChannelInstance ??= createPeerChannel({
      bin: process.env.OCGOAL_PEER_BIN ?? "agentmbx",
      identity,
      cli: "opencode",
      ...(Number(process.env.OCGOAL_PEER_TIMEOUT_MS) > 0 ? { timeoutMs: Number(process.env.OCGOAL_PEER_TIMEOUT_MS) } : {}),
    })
    return this.peerChannelInstance
  }

  private peerCooldownMs(): number {
    const value = Number(process.env.OCGOAL_PEER_COOLDOWN_MS)
    return Number.isFinite(value) && value >= 0 ? value : 15 * 60_000
  }

  private peerPollMs(): number {
    const value = Number(process.env.OCGOAL_PEER_POLL_MS)
    return Number.isFinite(value) && value > 0 ? value : 30_000
  }

  /**
   * v0.8.0 C4/C5: after a goal completes the loop looks for the next work
   * before it stops. Sources, in order: a ready CLEO item in this project, then
   * peer replies to an availability announcement. The decision is the pure
   * `nextWork`; this method only gathers the facts and applies the action.
   *
   * Returns true only when a NEW goal was actually started — that is the case
   * where the completion must not create an owner question.
   */
  private async continueWork(state: RunState, contract: Contract): Promise<boolean> {
    const candidates: WorkCandidate[] = []

    // 1. A ready CLEO item. Only probe when this project is CLEO-linked; an
    //    unlinked project spawns nothing and keeps today's behaviour.
    try {
      if (await cleoFacts(this.root, defaultRunner)) {
        const ready = await readyCleoTask((command, args, timeoutMs) => defaultRunner(process.env.OCGOAL_CLEO_BIN ?? command, args, timeoutMs))
        if (ready.skipped.length) this.store.ledger(state.slug, { type: "continue-parent-skipped", tasks: ready.skipped, reason: "a parent's acceptance is a rollup, not work; leaves are preferred" })
        if (ready.task) candidates.push({ source: "cleo", project: this.root, taskId: ready.task.id, title: ready.task.title, acceptance: ready.task.acceptance })
      }
    } catch (error) {
      this.store.ledger(state.slug, { type: "continue-cleo-error", error: String(error).slice(0, 300) })
    }

    // 2. Peer replies since the last poll. A reply is candidate work, never consent.
    const channel = this.peerChannel()
    if (channel) {
      const replies = await channel.replies({ since: state.peer?.lastReplyAt ?? 0, sessionID: state.sessionID }).catch(() => [])
      if (replies.length) {
        const now = Date.now()
        state.peer = { ...(state.peer ?? {}), outstanding: undefined, lastReplyAt: now,
          candidates: [...(state.peer?.candidates ?? []), ...replies.map((r) => candidateFromReply(r, this.root))] }
        this.persist(state)
        this.store.ledger(state.slug, { type: "peer-reply", count: replies.length, from: replies.map((r) => r.from), candidates: replies.map((r) => r.text.slice(0, 200)) })
        for (const reply of replies) {
          for (const candidate of [candidateFromReply(reply, this.root)])
            this.noticeM(state.sessionID, M.peerReplied(candidate.from ?? reply.from, candidate.taskId))
        }
      }
      for (const candidate of state.peer?.candidates ?? [])
        if (!candidates.some((c) => c.messageId === candidate.messageId)) candidates.push(candidate as WorkCandidate)
    }

    const decision = nextWork({
      candidates,
      currentProject: this.root,
      visitedProjects: [this.root],
      budgetExhausted: budgetUse(state, contract).ratio >= 1,
      allowBudgetExhaustion: contract.autonomy.continue_past_budget === true,
      allowNewProjects: contract.autonomy.visit_new_projects === true,
      ...(state.peer ? { announce: { ...(state.peer.lastAt !== undefined ? { lastAt: state.peer.lastAt } : {}), ...(state.peer.outstanding ? { outstanding: state.peer.outstanding } : {}) } } : { announce: {} }),
      now: Date.now(),
      cooldownMs: this.peerCooldownMs(),
    })

    switch (decision.kind) {
      case "start":
        return this.startContinuation(state, contract, decision.candidate)
      case "announce":
        await this.announceAvailability(state, contract, channel)
        return false
      case "stop":
        this.store.ledger(state.slug, { type: "continue-stopped", code: decision.code, reason: decision.reason })
        this.noticeM(state.sessionID, M.continueStopped(decision.reason))
        return false
      default:
        return false
    }
  }

  /** Write the continuation contract and open it in a fresh session. */
  private startContinuation(state: RunState, contract: Contract, candidate: WorkCandidate): boolean {
    if (candidate.source !== "cleo" || !candidate.taskId) {
      this.store.ledger(state.slug, { type: "continue-candidate", source: candidate.source, title: candidate.title, from: candidate.from ?? null, taskId: candidate.taskId ?? null })
      return false
    }
    const taken = new Set([...this.store.slugs(), ...this.store.archivedSlugs()])
    const slug = continuationSlug(candidate.taskId, taken)
    const text = continuationContractYaml({
      slug,
      task: { id: candidate.taskId, title: candidate.title, description: "", acceptance: candidate.acceptance ?? [] },
      sourceSlug: state.slug,
      autonomy: contract.autonomy,
    })
    const parsed = parseContract(text, { slug })
    if (!parsed.contract) {
      this.store.ledger(state.slug, { type: "continue-refused", taskId: candidate.taskId, slug, issues: parsed.issues })
      this.noticeM(state.sessionID, M.continueStopped(`the contract generated from ${candidate.taskId} did not validate`))
      return false
    }
    const dir = join(this.root, ".opencode", "goals", slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "goal.yaml"), text)
    this.store.ledger(state.slug, { type: "continue-work", taskId: candidate.taskId, slug, title: candidate.title, lock: parsed.lock })
    this.noticeM(state.sessionID, M.continueWork(state.title, slug, candidate.taskId))
    void this.transcript(state.sessionID, `◎ Goal complete — "${state.title}". Started the next ready CLEO item ${candidate.taskId} as "${slug}" in a new session; no owner decision was created. The new contract is .opencode/goals/${slug}/goal.yaml.`)
    // startClean creates the session outside the serial queue and queues the
    // start behind this completion turn; called synchronously it would re-enter
    // the queue and deadlock.
    setTimeout(() => {
      if (this.disposed) return
      void this.startClean(state.sessionID, slug, {}).catch((error) =>
        this.store.ledger(state.slug, { type: "continue-start-failed", taskId: candidate.taskId, slug, error: String(error).slice(0, 300) }))
    }, 0)
    return true
  }

  /** One availability announcement, rate-limited by the pure policy. */
  private async announceAvailability(state: RunState, contract: Contract, channel: PeerChannel | undefined) {
    if (!channel) {
      this.store.ledger(state.slug, { type: "peer-announce-skipped", reason: "no peer identity configured (set OCGOAL_PEER_IDENTITY)" })
      return
    }
    const now = Date.now()
    const taskId = contract.cleo?.tasks[0]?.id
    const sent = await channel.announce({
      text: announcementText({ project: this.root, ...(taskId ? { taskId } : {}), slug: state.slug }),
      sessionID: state.sessionID,
    }).catch(() => undefined)
    if (!sent) {
      this.store.ledger(state.slug, { type: "peer-announce-failed" })
      return
    }
    state.peer = { ...(state.peer ?? {}), lastAt: now, outstanding: { id: sent.id, at: now }, polls: 0 }
    this.persist(state)
    this.store.ledger(state.slug, { type: "peer-announce", id: sent.id, taskId: taskId ?? null })
    this.noticeM(state.sessionID, M.peerAnnounced(taskId))
    this.schedulePeerPoll(state)
  }

  /** Best-effort: turn replies to the outstanding announcement into candidates. */
  private schedulePeerPoll(state: RunState) {
    const channel = this.peerChannel()
    if (!channel) return
    const key = `peer:${state.sessionID}`
    clearTimeout(this.timers.get(key))
    const timer = setTimeout(() => {
      void this.serial(async () => {
        const replies = await channel.replies({ since: state.peer?.lastReplyAt ?? 0, sessionID: state.sessionID }).catch(() => [])
        if (!replies.length) {
          // Keep watching while the announcement is outstanding, but never
          // forever: 40 polls at the configured interval is a bounded wait.
          const polls = (state.peer?.polls ?? 0) + 1
          state.peer = { ...(state.peer ?? {}), polls }
          if (state.peer.outstanding && polls < 40) this.schedulePeerPoll(state)
          else if (state.peer.outstanding) this.store.ledger(state.slug, { type: "peer-poll-expired", id: state.peer.outstanding.id, polls })
          return
        }
        const now = Date.now()
        const candidates = replies.map((r) => candidateFromReply(r, this.root))
        state.peer = { ...(state.peer ?? {}), outstanding: undefined, lastReplyAt: now, candidates: [...(state.peer?.candidates ?? []), ...candidates] }
        this.persist(state)
        this.store.ledger(state.slug, { type: "peer-reply", count: replies.length, candidates: candidates.map((c) => ({ from: c.from, taskId: c.taskId ?? null, title: c.title })) })
        for (const candidate of candidates) this.noticeM(state.sessionID, M.peerReplied(candidate.from ?? "a peer", candidate.taskId))
      })
    }, this.peerPollMs())
    timer.unref?.()
    this.timers.set(key, timer)
  }

  /**
   * v0.8.0 D1: write the launch handoff beside the contract. Facts only, with
   * their sources; a failed probe is omitted, never invented.
   */
  private writeHandoff(state: RunState, contract: Contract, handoff: Handoff, exec: string, rehearsal: Array<{ id: string; pass: boolean }>) {
    try {
      const prior = this.store.slugs()
        .filter((s) => s !== state.slug)
        .map((s) => ({ slug: s, run: this.store.readRun(s) }))
        .filter((x): x is { slug: string; run: RunState } => !!x.run && isTerminal(x.run.status) && x.run.sessionID === handoff.fromSessionID)
        .sort((a, b) => (b.run.updatedAt ?? 0) - (a.run.updatedAt ?? 0))[0]
      const branch = Bun.spawnSync(["git", "branch", "--show-current"], { cwd: exec, stdout: "pipe", stderr: "ignore" })
      const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: exec, stdout: "pipe", stderr: "ignore" })
      const dirty = status.exitCode === 0
        ? status.stdout.toString().split("\n").map((l) => l.trim()).filter(Boolean).filter((l) => !l.includes(".opencode/goals"))
        : []
      const doc = buildHandoff({
        slug: state.slug,
        title: contract.title,
        fromSessionID: handoff.fromSessionID,
        toSessionID: handoff.toSessionID,
        ...(prior ? { prior: {
          slug: prior.slug, runId: prior.run.runId, lock: prior.run.lock, status: prior.run.status, turn: prior.run.turn,
          evidence: `.opencode/goals/${prior.slug}/evidence/${prior.run.runId}/`,
        } } : {}),
        repo: { ...(state.base.commit ? { head: state.base.commit } : {}), ...(branch.exitCode === 0 && branch.stdout.toString().trim() ? { branch: branch.stdout.toString().trim() } : {}), dirty },
        baseline: rehearsal.map((r) => ({ id: r.id, pass: r.pass })),
        ...(contract.plan[0] ? { nextAction: { step: contract.plan[0].id, title: contract.plan[0].title } } : {}),
        authority: {
          trust: ["goal.yaml (the locked contract)", ...(existsSync(join(this.root, "docs", "HANDOFF-v0.8.0.md")) ? ["docs/HANDOFF-v0.8.0.md"] : [])],
          stale: ["docs/HANDOFF.md (its historical body; read the current-state banner before trusting it)"],
        },
        evidence: [`.opencode/goals/${state.slug}/evidence/${state.runId}/`],
      })
      writeFileSync(join(this.store.dir(state.slug), "handoff.md"), `${doc.markdown}\n`)
      writeFileSync(join(this.store.dir(state.slug), "handoff.json"), `${JSON.stringify({ schema: doc.schema, generatedAt: doc.generatedAt, ...doc.data }, null, 2)}\n`)
      state.handoff = { ...handoff, file: "handoff.md" }
      this.store.ledger(state.slug, { type: "handoff-written", file: "handoff.md", prior: prior?.slug ?? null })
    } catch (error) {
      this.store.ledger(state.slug, { type: "handoff-failed", error: String(error).slice(0, 300) })
    }
  }

  private async admit(state: RunState, kind: PendingKind) {
    if (this.disposed || !isActive(state.status)) return
    const contract = this.contractOf(state)
    if (!contract) {
      setStatus(state, "paused", "contract unavailable")
      this.persist(state)
      return
    }
    if (!state.pending || state.pending.kind !== kind) {
      state.turn += 1
      state.pending = { messageID: ascendingId("msg"), turn: state.turn, at: Date.now(), kind }
    }
    if (state.status !== "running") setStatus(state, "running")
    state.activity = { kind: "turn", since: Date.now(), detail: kind }
    let note = renderTailNote(state, contract, kind as TailKind)
    // v0.8.0 D1: the kickoff carries the handoff digest. It is volatile tail
    // content for turn 1 only, so the system block stays byte-stable.
    if (kind === "kickoff" && state.handoff?.file) {
      try {
        const digest = handoffDigest(readFileSync(join(this.store.dir(state.slug), state.handoff.file), "utf8"))
        note = `<goal_handoff>\n${digest}\n</goal_handoff>\n\n${note}`
      } catch { /* the handoff is optional context; never block the kickoff */ }
    }
    this.notes.set(state.sessionID, note)
    state.compacted = false
    this.store.ledger(state.slug, { type: "admit", kind, turn: state.turn, messageID: state.pending.messageID })
    this.persist(state)
    try {
      // S2 + T041: a fixed id makes a retried admission idempotent, and the
      // continuation lands as ONE synthetic notice row in the transcript
      // (research §0.6) instead of a user message; resume drives the turn.
      // Falls back to a plain prompt on hosts without synthetic resume.
      const payload = {
        sessionID: state.sessionID,
        id: state.pending.messageID,
        text: triggerText(state, contract, kind as TailKind),
        description: `goal ${kind} · ${state.slug} · turn ${state.turn}`,
        metadata: { goal: { slug: state.slug, run: state.runId, turn: state.turn, kind } },
        resume: true,
      }
      try {
        await this.ctx.session.synthetic(payload as any)
      } catch {
        await this.ctx.session.prompt(payload as any)
      }
      // An accepted prompt is not a successful model execution. Reducing
      // the failure streak here cancelled every execution failure and made
      // provider errors retry forever (observed turns 10–36 in dogfood).
    } catch (error) {
      state.counters.failures += 1
      this.store.ledger(state.slug, { type: "admit-failed", turn: state.turn, error: String(error) })
      if (state.counters.failures >= this.options.maxPromptFailures) {
        setStatus(state, "paused", `could not send a continuation: ${String(error).slice(0, 200)}`)
        this.noticeM(state.sessionID, M.pausedAdmissionError(state.reason ?? "admission failed"))
      } else this.schedule(state, 2000 * 2 ** state.counters.failures, kind)
      this.persist(state)
    }
  }

  private schedule(state: RunState, delayMs: number, kind: PendingKind) {
    const key = state.sessionID
    const waiting = state.wait !== undefined
    clearTimeout(this.timers.get(key))
    // T053: the tracer counts down the cooldown before the next turn
    if (isActive(state.status) && state.status !== "waiting") {
      state.activity = { kind: "cooldown", since: Date.now(), until: Date.now() + delayMs, detail: kind }
      this.persist(state)
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key)
        void this.serial(async () => {
          const live = this.runs.get(key)
          if (this.disposed || !live || live.runId !== state.runId || !isActive(live.status) || live.status === "verifying" || (waiting && !live.wait)) return
          // Keep one quiet timer while execution/forms hold the session;
          // an expired deadline must not disappear without a future wake.
          const facts = this.factsOf(key)
          if (facts.busy || facts.forms.size > 0) return this.schedule(live, 1000, kind)
          // A pending claim wins over a wake/retry once execution releases
          // ownership; never admit another worker to satisfy that claim.
          if (live.claim) {
            const contract = this.contractOf(live)
            if (contract) {
              live.pending = undefined
              this.notes.delete(key)
              await this.verify(live, contract, "claim")
            }
            return
          }
          if (live.status === "waiting" && live.wait && live.wait.until > Date.now())
            return this.schedule(live, live.wait.until - Date.now(), kind)
          if (live.status === "waiting") {
            live.wait = undefined
            setStatus(live, "running")
          }
          await this.admit(live, kind)
        })
      }, delayMs),
    )
  }

  // ───────────────────────────── events (S1: filter to this location)

  private async eventLoop() {
    while (!this.disposed) {
      try {
        for await (const event of this.ctx.event.subscribe({ signal: this.controller.signal } as any) as AsyncIterable<any>) {
          if (this.disposed) return
          const dir = event?.location?.directory
          if (dir && dir !== this.root && canonical(dir) !== this.rootReal) continue
          // Never await slow work (verification) here: state changes are already
          // serialized by `serial`, and the stream must keep flowing.
          void this.onEvent(event).catch((error) => this.store.ledger("_errors", { type: "event-error", event: event?.type, error: String(error) }))
        }
      } catch (error) {
        if (this.disposed) return
        await Bun.sleep(1000)
      }
    }
  }

  private async onEvent(event: any) {
    const type: string = event.type
    const data = event.data ?? {}
    switch (type) {
      case "form.created": {
        const sid = data.form?.sessionID
        if (!sid) return
        this.factsOf(sid).forms.add(data.form.id)
        const launch = this.launches.bind(data.form)
        if (launch) {
          this.store.ledger(launch.slug, { type: "launch-form-bound", decisionId: launch.id, formID: launch.formID, sessionID: sid, lock: launch.lock, fresh: launch.fresh })
          await this.unholdLaunchChat(launch)
          return
        }
        const amendment = this.amendmentReviews.bind(data.form)
        if (amendment) {
          this.store.ledger(amendment.slug, { type: "amendment-form-bound", decisionId: amendment.id, formID: amendment.formID })
          await this.unholdAmendmentChat(amendment)
          return
        }
        const decision = this.decisions.bind(data.form)
        if (decision) {
          const pending = this.pendingFormDecisions.get(sid)
          if (pending?.decisionId === decision.id) pending.formID = data.form.id
          this.store.ledger(decision.slug, { type: "decision-form-bound", decision: decision.id, formID: data.form.id })
          return
        }
        this.bindLegacyLaunchForm(data.form)
        // T075: this form answers the session's pending decision (the
        // question-tool prompt askDecisionForm sent) — remember the id so
        // only ITS reply dispatches the act
        const state = this.runs.get(sid)
        if (state && isActive(state.status)) {
          this.noticeM(sid, M.awaitingAnswer(String(data.form?.question ?? "a question from the worker")))
          this.emitUpdate(state)
        }
        return
      }
      case "form.replied": {
        const f = this.factsOf(data.sessionID)
        f.forms.delete(data.id)
        const answers = Object.values(data.answer ?? {}).flatMap((v) => (Array.isArray(v) ? v : [v])).map(String)
        f.lastFormAnswer = { labels: answers, at: Date.now() }
        const launch = this.launches.byForm(data.sessionID, data.id)
        if (launch) {
          await this.resolveLaunch(launch, data.answer ?? {})
          this.flushDeferred(data.sessionID)
          return // never mint a second legacy approval from this answer
        }
        const amendment = this.amendmentReviews.byForm(data.sessionID, data.id)
        if (amendment) {
          await this.resolveAmendment(amendment, data.answer ?? {})
          this.flushDeferred(data.sessionID)
          return
        }
        // T075: a reply to a DECISION form dispatches the same rpc act the
        // TUI dialog carries — answering either surface resolves both.
        const decision = this.decisions.byForm(data.sessionID, data.id)
        if (decision) {
          await this.resolveDecisionForm(decision, data.answer ?? {})
          this.flushDeferred(data.sessionID)
          return
        }
        // T069: commands that deferred behind the form run now — unless the
        // reply itself started a new turn (busy flips before the flush)
        this.flushDeferred(data.sessionID)
        // The recommended suffix remains supported, but commentary or a
        // label in a different field/form cannot mint approval. Seal the
        // legacy candidate at form creation, never at the later start call.
        const legacy = this.legacyLaunchForms.get(data.id)
        this.legacyLaunchForms.delete(data.id)
        if (legacy && legacy.sessionID === data.sessionID && data.answer?.[legacy.fieldKey] === legacy.value) {
          f.launchApprovedAt = Date.now()
          this.writeLaunchApproval(data.sessionID, { at: f.launchApprovedAt, label: legacy.label, slug: legacy.slug, lock: legacy.lock, fresh: false, formID: data.id })
        }
        const state = this.runs.get(data.sessionID)
        if (state) this.emitUpdate(state)
        return
      }
      case "form.cancelled": {
        const f = this.factsOf(data.sessionID)
        f.forms.delete(data.id)
        this.legacyLaunchForms.delete(data.id)
        f.cancelledAt = Date.now()
        const launch = this.launches.byForm(data.sessionID, data.id)
        if (launch?.status === "pending") {
          // Core also emits this on host reload, with no owner-rejection
          // signal. Preserve an explicit interrupted review, never consent
          // or a fabricated owner refusal. Recovery asks the same review.
          this.launches.interruptForm(launch.id)
          this.store.ledger(launch.slug, { type: "launch-interrupted", decisionId: launch.id, previousFormID: data.id })
        }
        const amendment = this.amendmentReviews.byForm(data.sessionID, data.id)
        if (amendment?.status === "pending" && !amendment.ownerMessageID) {
          this.amendmentReviews.interruptForm(amendment.id)
          this.store.ledger(amendment.slug, { type: "amendment-review-interrupted", decisionId: amendment.id, previousFormID: data.id })
        }
        const decision = this.decisions.byForm(data.sessionID, data.id)
        if (decision?.status === "pending") {
          this.decisions.interruptForm(decision.id)
          this.pendingFormDecisions.delete(data.sessionID)
          this.store.ledger(decision.slug, { type: "decision-form-interrupted", decision: decision.id, previousFormID: data.id })
        }
        this.flushDeferred(data.sessionID)
        return
      }
    }
    const sid: string | undefined = data.sessionID
    if (!sid) return
    if (type === "session.execution.started") this.factsOf(sid).busy = true
    if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") {
      this.factsOf(sid).busy = false
      // T069: deferred /goal commands run the moment the turn ends — the
      // ack promised exactly that. Before any goal handling so commands for
      // goal-less sessions flush too.
      this.flushDeferred(sid)
      // T075: a decision whose form-ask was skipped because the session was
      // mid-turn gets its native form now (the decision is still unanswered)
      this.reaskDecisionForm(sid)
    }
    const state = this.runs.get(sid)
    if (!state) return
    switch (type) {
      case "session.inbox.enqueued":
        return this.serial(() => this.onEnqueued(state, data))
      case "session.tool.called":
        state.turnFacts.tools += 1
        return
      case "session.usage.updated": {
        // T013: this event fires per message with cumulative session totals
        // (probed live on 2.0.22 — see docs/dogfood-1.md). The old handler
        // updated memory only, so run.json and the TUI froze at the values
        // captured at goal start (the sentinel 1) for the whole kickoff
        // execution of run 0ffe5ac6e001. Baseline = the cumulative total at
        // goal start; persist and re-render throttled so counters stay live.
        const total = (data.tokens?.input ?? 0) + (data.tokens?.output ?? 0) + (data.tokens?.reasoning ?? 0)
        if (state.usage.baseTokens === null) {
          state.usage.baseTokens = total
          state.usage.baseCost = data.cost ?? 0
        }
        state.usage.tokens = Math.max(0, total - (state.usage.baseTokens ?? 0))
        state.usage.cost = Math.max(0, (data.cost ?? 0) - (state.usage.baseCost ?? 0))
        const now = Date.now()
        if (state.lastUsageEmit === undefined || now - state.lastUsageEmit > 1000) {
          state.lastUsageEmit = now
          this.persist(state)
          this.emitUpdate(state)
        }
        return
      }
      case "session.compaction.ended":
        state.compacted = true
        this.store.ledger(state.slug, { type: "compacted", turn: state.turn })
        return
      case "session.execution.succeeded":
        return this.serial(() => this.onTurnEnd(state))
      case "session.execution.failed":
        return this.serial(() => this.onFailed(state, data.error))
      case "session.execution.interrupted":
        return this.serial(() => this.onInterrupted(state, data.reason))
      case "session.deleted":
        return this.serial(() => {
          if (isTerminal(state.status)) return
          setStatus(state, "aborted", "session deleted")
          this.store.ledger(state.slug, { type: "aborted", reason: "session deleted" })
          this.persist(state)
        })
    }
  }

  /** A prompt entered the session: ours (tagged) or the owner's (a steer). */
  private async onEnqueued(state: RunState, data: any) {
    const meta = data.item?.payload?.metadata?.goal
    if (meta) return
    if (data.item?.type !== "user") return
    const contract = this.contractOf(state)
    if (isActive(state.status)) {
      if (contract?.autonomy.on_user_message === "pause") {
        setStatus(state, "paused", "owner sent a message")
        this.store.ledger(state.slug, { type: "paused", reason: "owner message" })
        this.noticeM(state.sessionID, M.pausedUserMessage())
      } else {
        state.steers += 1
        this.store.ledger(state.slug, { type: "steer", text: String(data.item?.payload?.text ?? "").slice(0, 1000) })
      }
      this.persist(state)
    } else if (state.status === "paused" && state.reason?.startsWith("interrupted") && contract?.autonomy.on_interrupt === "resume-on-message") {
      setStatus(state, "running")
      this.store.ledger(state.slug, { type: "resumed", by: "owner message" })
      this.persist(state)
    }
  }

  private async onTurnEnd(state: RunState) {
    // Only the host's actual execution.succeeded signal clears the streak.
    // This also covers successful goal_wait turns, whose status is waiting.
    if (isActive(state.status)) state.counters.failures = 0
    if (state.status !== "running" && !(state.status === "waiting" && state.claim)) return
    const contract = this.contractOf(state)
    if (!contract) return
    const kind = state.pending?.kind
    state.pending = undefined
    this.notes.delete(state.sessionID)

    if (state.claim) return this.verify(state, contract, "claim")
    // Started from a tool call while the session was busy: kick off now.
    if (state.turn === 0) return this.admit(state, "kickoff")

    // Progress is authoritative state change, not activity (R3).
    const fp = fingerprint(this.executionRoot(contract))
    const changed = fp !== undefined && fp !== state.fingerprint
    state.fingerprint = fp
    // T108: recording progress with goal_progress is the supported way for an
    // agent to say what it did; it must count, or agents are pushed to editing
    // run.json to make their work visible. Host-visible activity is recorded
    // too, so a stalled-but-working run is never described as idle.
    const turnFacts = { ...state.turnFacts }
    let progress = changed || turnFacts.stepsChanged || turnFacts.progressRecorded
    if (changed && this.options.liveChecks) progress = (await this.liveChecks(state, contract)) || progress
    state.counters.noProgress = progress ? 0 : state.counters.noProgress + 1
    this.store.ledger(state.slug, { type: "turn", turn: state.turn, kind, tools: turnFacts.tools, activity: turnFacts.tools > 0, changed, progress, noProgress: state.counters.noProgress })
    state.turnFacts = { tools: 0, goalCalls: 0, stepsChanged: false, progressRecorded: false }

    // v0.6.0: the DECISION is the extracted pure function (src/engine/loop.ts).
    // This method only APPLIES its side effects, which are unchanged - the
    // OpenCode adapter and the `ocg tick` entry point share one decision.
    const use = budgetUse(state, contract)
    const backstop = !contract.budget.turns && state.turn >= this.options.backstopTurns
    const stallTurns = state.counters.noProgress
    const stalled = stallTurns >= this.options.stallTurns
    const active = stalled && this.store.recent(state.slug, 100).filter((e) => e.type === "turn").slice(-stallTurns).some((e) => e.activity === true || Number(e.tools) > 0)
    const stallReason = active
      ? `stalled: no visible change for ${stallTurns} turns while the agent kept working (host-visible activity)`
      : `stalled: no change the host could see for ${stallTurns} turns`
    const action = decide(
      state,
      {
        turn: "succeeded",
        pending: kind,
        changed,
        progressRecorded: turnFacts.progressRecorded,
        stepsChanged: turnFacts.stepsChanged,
        activeStalled: active,
        stallReason,
        onStall: contract.autonomy.on_stall,
        budgetRatio: use.ratio,
        backstop,
        cooldownMs: this.options.cooldownMs,
      },
      {
        blockerRepeats: this.options.blockerRepeats,
        stallTurns: this.options.stallTurns,
        recoveryAt: this.options.recoveryAt,
        backstopTurns: this.options.backstopTurns,
      },
    )

    switch (action.kind) {
      case "none":
        return
      case "admit":
        if (action.tail === "wrapup") {
          state.wrapup = true
          this.store.ledger(state.slug, { type: "wrapup", ratio: use.ratio, backstop })
          return this.admit(state, "wrapup")
        }
        return this.admit(state, action.tail)
      case "schedule": {
        if (action.waiting) {
          setStatus(state, "waiting", action.waiting.reason)
          state.activity = { kind: "waiting", since: Date.now(), until: state.wait!.until, detail: action.waiting.reason }
          this.persist(state)
          return this.schedule(state, action.delayMs, action.tail)
        }
        if (stalled) {
          this.store.ledger(state.slug, { type: "stall", turns: stallTurns, activity: active, reason: stallReason, policy: contract.autonomy.on_stall })
          state.counters.noProgress = 0
          this.store.ledger(state.slug, { type: "stall-report", turns: stallTurns, action: "continued", policy: contract.autonomy.on_stall })
          this.noticeM(state.sessionID, M.stallReported(stallTurns))
          this.persist(state)
          return this.schedule(state, action.delayMs, action.tail)
        }
        state.wait = undefined
        this.persist(state)
        return this.schedule(state, action.delayMs, action.tail)
      }
      case "stop": {
        switch (action.code) {
          case "blocked":
            setStatus(state, "blocked", action.reason)
            this.store.ledger(state.slug, { type: "blocked", blocker: state.blocker })
            this.decide(state.sessionID, state.slug, "blocked", M.blocked(String(state.blocker?.key), String(state.blocker?.reason), state.blocker?.needs), { blocker: state.blocker })
            await this.transcript(state.sessionID, `◎ blocked on ${state.blocker?.key}: ${state.blocker?.reason}${state.blocker?.needs ? ` (needs ${state.blocker.needs})` : ""}. Only the owner can resolve this; stop working around it and wait.`)
            return this.persist(state)
          case "wrapup":
            setStatus(state, "budget_limited", action.reason)
            this.store.ledger(state.slug, { type: "budget_limited" })
            this.decide(state.sessionID, state.slug, "budget_limited", M.budgetStopped(contract.title))
            await this.transcript(state.sessionID, `◎ budget used (${contract.title}). The owner decides: raise the budget in goal.yaml and amend, or abort. Do not start new work.`)
            await this.summarize(state, contract)
            return this.persist(state)
          case "budget":
            setStatus(state, "budget_limited", action.reason)
            this.decide(state.sessionID, state.slug, "budget_limited", M.budgetStopped(contract.title))
            await this.transcript(state.sessionID, `◎ budget used (${contract.title}). The owner decides: raise the budget in goal.yaml and amend, or abort. Do not start new work.`)
            await this.summarize(state, contract)
            return this.persist(state)
          case "stalled":
            this.store.ledger(state.slug, { type: "stall", turns: stallTurns, activity: active, reason: stallReason, policy: contract.autonomy.on_stall })
            setStatus(state, "paused", action.reason)
            this.store.ledger(state.slug, { type: "paused", reason: state.reason, activity: active })
            this.noticeM(state.sessionID, M.pausedStalled(state.reason ?? "stalled", contract.autonomy.on_stall))
            return this.persist(state)
        }
      }
    }
  }

  /** Re-run cheap `live: true` command checks after a turn that changed files. */
  private async liveChecks(state: RunState, contract: Contract): Promise<boolean> {
    let transitioned = false
    for (const c of [...contract.criteria, ...contract.invariants]) {
      if (c.check.kind !== "command" || !c.check.live) continue
      const r = await runHostCheck({ ...c.check, runs: 1 }, this.executionRoot(contract), state.base.commit)
      const prev = state.criteria[c.id]
      const status = r.pass ? "pass" : "fail"
      if (prev?.status !== status) transitioned = true
      state.criteria[c.id] = { status, by: "host", at: Date.now(), detail: r.detail.slice(0, 600), rejections: prev?.rejections ?? 0 }
    }
    return transitioned
  }

  private async onFailed(state: RunState, error: any) {
    if (!isActive(state.status)) return
    const message = String(error?.message ?? error?.type ?? error ?? "unknown error")
    state.pending = undefined
    this.notes.delete(state.sessionID)
    state.counters.failures += 1
    this.store.ledger(state.slug, { type: "turn-failed", error: message, failures: state.counters.failures })
    let reason: string | undefined
    if (/\bmodel\b[^\n]*(?:unavailable|not found|not available|does not exist|disabled)/i.test(message)) reason = `model unavailable: ${message}`
    else if (/quota|insufficient|billing|credit|usage limit/i.test(message)) reason = `provider usage limit: ${message}`
    else if (/context|too long|maximum.*tokens/i.test(message)) reason = `context overflow: ${message}`
    else if (/auth|unauthorized|forbidden|api key/i.test(message)) reason = `provider auth error: ${message}`
    else {
      if (state.counters.failures < this.options.maxPromptFailures) {
        this.persist(state)
        return this.schedule(state, 5000 * 2 ** state.counters.failures, "continue")
      }
      reason = `repeated errors: ${message}`
    }
    clearTimeout(this.timers.get(state.sessionID))
    this.timers.delete(state.sessionID)
    setStatus(state, "paused", reason.slice(0, 300))
    this.store.ledger(state.slug, { type: "paused", reason })
    this.noticeM(state.sessionID, M.pausedInterrupted(reason))
    this.persist(state)
  }

  /** S8: Esc → reason "user"; a dismissed question → form.cancelled then "shutdown". */
  private async onInterrupted(state: RunState, reason: string) {
    if (!isActive(state.status)) return
    if (reason === "superseded") return
    const f = this.factsOf(state.sessionID)
    const why =
      reason === "user"
        ? "interrupted by you (Esc)"
        : reason === "shutdown" && f.cancelledAt && Date.now() - f.cancelledAt < 10_000
          ? "interrupted: a question was dismissed"
          : reason === "inactivity"
            ? "interrupted: host evicted the idle project"
            : `interrupted: ${reason}`
    clearTimeout(this.timers.get(state.sessionID))
    setStatus(state, "paused", why)
    this.store.ledger(state.slug, { type: "paused", reason: why })
    this.noticeM(state.sessionID, M.pausedStalled(why))
    this.persist(state)
  }

  // ───────────────────────────── verification

  private async verify(state: RunState, contract: Contract, source: "claim" | "owner") {
    clearTimeout(this.timers.get(state.sessionID))
    this.timers.delete(state.sessionID)
    state.wait = undefined
    setStatus(state, "verifying", source === "claim" ? "checking your claim" : "owner requested verification")
    state.activity = { kind: "verifying", since: Date.now() }
    this.store.ledger(state.slug, { type: "verify-start", source, turn: state.turn })
    this.persist(state)
    this.noticeM(state.sessionID, M.verifying())
    const text = existsSync(this.store.contractPath(state.slug)) ? readFileSync(this.store.contractPath(state.slug), "utf8") : ""
    // The host records its own serving artifact before checks start. The
    // shell check is explicitly bound to this run and process, not the
    // globally discoverable OpenCode service (which may be another server).
    // T115: provenance() itself is read-only; the host owns this evidence write.
    const runtime = await this.provenance(state.sessionID)
    if (!isTerminal(state.status)) this.store.evidence(state.slug, state.runId, "engine-provenance", runtime)
    const checkContext = JSON.stringify({ slug: state.slug, runId: state.runId, sessionID: state.sessionID, lock: state.lock, serverPID: process.pid })
    const outcome = await verifyClaim(contract, state, {
      root: this.executionRoot(contract),
      contractText: text,
      shell: (command, cwd, timeout) => runShell(command, cwd, timeout, { OCGOAL_CHECK_CONTEXT: checkContext }),
      verifier: (input) => this.runVerifier(input),
      // T063: every host check refreshes the activity so the tracer shows
      // live progress (check C7 · 7/22) instead of a static "verifying" line
      onProgress: (activity) => {
        state.activity = activity
        this.persist(state)
      },
    })
    const now = Date.now()
    for (const r of outcome.results) {
      const prev = state.criteria[r.id] ?? { status: "unknown" as const, rejections: 0 }
      const claimed = source === "claim" && !r.pass && r.by !== "human"
      state.criteria[r.id] = { status: r.pass ? "pass" : r.by === "human" ? prev.status : "fail", by: r.by, at: now, detail: r.detail.slice(0, 600), rejections: r.pass ? 0 : prev.rejections + (claimed ? 1 : 0) }
    }
    this.store.evidence(state.slug, state.runId, `verify-turn-${state.turn}-${now}`, { source, claim: state.claim ?? null, outcome: { ...outcome, results: outcome.results.map((r) => ({ ...r, raw: undefined })) } })
    state.verdict = { at: now, turn: state.turn, passed: outcome.passed, lines: outcome.lines }
    state.claim = undefined
    this.store.ledger(state.slug, { type: "verdict", passed: outcome.passed, lines: outcome.lines.slice(0, 10) })

    if (outcome.passed) {
      setStatus(state, "complete", "all required criteria verified")
      this.store.ledger(state.slug, { type: "complete", turn: state.turn })
      // T072: the terminal write happens BEFORE the reporting layer. The
      // complete state used to reach disk only inside summarize()'s try —
      // a reporting failure stranded the run as a zombie "running" on disk,
      // and the next server reload recovered it into "paused" while the run
      // had actually finished: the stale paused/20-of-22 card. persist() also
      // pushes the final `updated` event, so a live TUI converges even if it
      // never sees another transition.
      this.persist(state)
      // v0.5.0: automatic at goal completion — a contract that names CLEO tasks
      // records genuine per-gate evidence and completes them through the cleo CLI
      // only. A refusal is journalled and shown verbatim; a closure is never faked.
      const linkedCleo = contract.cleo?.tasks ?? []
      if (linkedCleo.length) {
        const outcomes = await this.runCleoBridge(linkedCleo.map((t) => t.id), new Map(linkedCleo.map((t) => [t.id, this.cleoLinkFor(contract, t)] as const)))
        this.store.ledger(state.slug, { type: "cleo-bridge", results: outcomes.map((o) => ({ task: o.task, completed: o.completed, blocker: o.blocker ?? null, openAcs: o.openAcs })) })
        await this.transcript(state.sessionID, `◎ CLEO bridge — ${bridgeReport(outcomes)}`)
      }
      // v0.8.0 C4/C5: look for the next work BEFORE the completion is reported.
      // A started CLEO item means no owner question; otherwise the announcement
      // policy runs and the existing completion decision stands.
      const continued = await this.continueWork(state, contract)
      const summary = await this.summarize(state, contract, continued)
      this.noticeM(state.sessionID, M.complete(contract.title, summary ? summary.caveats.length + summary.scopeAudit.length : 0))
      // v0.8.0 C4: a started next goal is not an owner question. Without one,
      // the existing completion decision remains the surface.
      if (!continued) this.decide(state.sessionID, state.slug, "complete", M.completeDecision(contract.title, Boolean(await cleoFacts(this.root, defaultRunner)), summary?.scopeAudit.length ?? 0))
      await this.transcript(state.sessionID, `◎ Goal complete — "${contract.title}". Every required criterion was verified by the host${contract.verification.mode !== "host" ? " and the independent verifier" : ""}. The loop has stopped; follow-ups live in the summary dialog and .opencode/goals/${state.slug}/.`)
      return
    }
    const onlyHuman = outcome.integrity.length === 0 && outcome.results.every((r) => r.pass || r.by === "human" || !this.required(contract).has(r.id))
    if (onlyHuman && outcome.needsHuman.length) {
      setStatus(state, "needs_review", `owner sign-off needed: ${outcome.needsHuman.join(", ")}`)
      this.decide(state.sessionID, state.slug, "needs_review", M.needsSignOff(outcome.needsHuman), { criteria: outcome.needsHuman })
      await this.summarize(state, contract)
      return this.persist(state)
    }
    const stuck = Object.entries(state.criteria).filter(([, s]) => s.rejections >= contract.verification.max_rejections).map(([id]) => id)
    if (stuck.length) {
      setStatus(state, "needs_review", `${stuck.join(", ")} rejected ${contract.verification.max_rejections} times`)
      this.decide(state.sessionID, state.slug, "needs_review", M.needsReview(state.reason ?? "repeated rejections", stuck), { criteria: stuck })
      await this.summarize(state, contract)
      return this.persist(state)
    }
    if (source === "owner") {
      setStatus(state, "paused", "verification did not pass; resume to keep working")
      // T050: an owner-requested verify that fails is a decision point —
      // resume with the verdict in hand, amend the check, or abort.
      this.decide(state.sessionID, state.slug, "paused-after-verdict", M.pausedAfterVerdict(state.verdict?.lines[0] ?? "see the verdict lines"))
      return this.persist(state)
    }
    setStatus(state, "running")
    this.noticeM(state.sessionID, M.claimRejected(state.verdict?.lines?.find((l) => !l.startsWith("INTEGRITY"))?.split("\n")[0] ?? "see the HOST VERDICT lines"))
    // T052: the verdict lands as a transcript notice row the agent reads next
    // turn — persistent, not a toast.
    await this.transcript(state.sessionID, `◎ HOST VERDICT — did not pass: ${state.verdict?.lines.find((l) => !l.startsWith("INTEGRITY"))?.split("\n")[0] ?? "see the verdict lines"}.\n${state.verdict?.lines.slice(0, 5).join("\n")}\nFix the failed criteria, then goal_claim again.`)
    await this.admit(state, "verdict")
  }

  private required(contract: Contract) {
    return new Set([...contract.criteria.filter((c) => c.essential).map((c) => c.id), ...contract.invariants.map((c) => c.id)])
  }

  /** S7: a hidden read-only agent in a child session; its only extra tool is goal_verdict. */
  private async runVerifier(input: { contract: Contract; state: RunState; criteria: Contract["criteria"]; host: Array<{ id: string; pass: boolean; detail: string; by: string }> }) {
    const { contract, state, criteria, host } = input
    // T044: the child request carries an explicitly resolved model. On the
    // owner's main host the hidden agent's implicit resolution produced four
    // entirely empty exchanges (no text, no tool call) with GLM via zai;
    // an explicit model rides on every child create so the request can never
    // depend on the agent's own (possibly absent) resolution.
    // T107: the contract may name the verifier's model and effort. A name that
    // cannot be parsed falls back to the resolved default with the reason
    // journalled, so a typo never blocks verification.
    const named = contractVerifierModel(contract.verification)
    let model: { ref: { providerID: string; id: string; variant?: string }; label: string } | undefined = named.ref ? { ref: named.ref, label: named.label! } : undefined
    if (!model) {
      model = await this.resolveVerifierModel(state.sessionID)
      if (named.reason) this.store.ledger(state.slug, { type: "verifier-model-fallback", turn: state.turn, requested: named.requested ?? contract.verification.model ?? null, reason: named.reason, used: model?.label ?? null })
    }
    // T053: the tracer shows the child running while it works
    state.activity = { kind: "verifier-child", since: Date.now(), ...(model ? { detail: model.label } : {}) }
    this.persist(state)
    // Contract-listed extra READ-ONLY roots get their own agent: the same
    // deny-all rules plus external_directory allows for exactly those roots.
    const readRoots = contract.verification.read.map((p) => resolve(this.root, p))
    const agentName = readRoots.length ? await this.scopedVerifierAgent(readRoots) : this.options.verifierAgent
    const child: any = await this.ctx.session.create({ parentID: state.sessionID, agent: agentName, title: `goal verify · ${contract.id}`, ...(model ? { model: model.ref } : {}) } as any)
    const childID: string = child?.id ?? child?.data?.id
    this.verifierInbox.delete(childID)
    this.verifierScopes.set(childID, { allow: readRoots })
    this.store.ledger(state.slug, { type: "verifier-model", turn: state.turn, model: model?.label ?? null })
    // T109: the verifier has only read/glob/grep, so a criterion that asks about
    // commit history was unanswerable and burned the round budget. The host
    // supplies a digest in the prompt AND saves a quotable copy inside the
    // project, so the verifier needs no shell and no external path.
    const digest = gitDigest(this.root)
    let digestRel: string | undefined
    try {
      digestRel = relative(this.root, this.store.evidence(state.slug, state.runId, `git-history-turn-${state.turn}-${Date.now()}`, { schema: "opencode-goal/git-history/v1", digest }))
    } catch { digestRel = undefined }
    const lines: string[] = []
    lines.push("You are an independent completion verifier. You did not do this work and you gain nothing if it passes. Fail closed: a criterion is proven only if you can quote file text that proves it.")
    lines.push(`Goal outcome: ${contract.outcome}`)
    lines.push("Criteria to judge:")
    for (const c of criteria) lines.push(`- ${c.id}: ${c.statement}${c.check.kind === "verifier" ? `\n    question: ${c.check.ask}` : "\n    (the host check passed; confirm the work genuinely satisfies the statement, not just the check)"}`)
    lines.push("Host check results (trusted):")
    for (const r of host) lines.push(`- ${r.id} ${r.pass ? "PASS" : "FAIL"}: ${r.detail.split("\n")[0]}`)
    if (state.claim) {
      lines.push("The worker's claim (untrusted; check it, do not believe it):")
      lines.push(`  ${state.claim.summary}`)
      for (const [id, note] of Object.entries(state.claim.evidence)) lines.push(`  ${id}: ${note}`)
    }
    lines.push(`Repository history digest (host-provided and authoritative; you have no shell):\n${digest}`)
    if (digestRel) lines.push(`A quotable copy is saved inside the project at ${digestRel}; read it and quote a line from it when a criterion is about commit history.`)
    if (readRoots.length) lines.push(`Besides the project, the owner lets you READ (never write) these paths: ${readRoots.join(", ")}. Every other path outside the project is denied.`)
    lines.push("Use read, glob and grep to inspect the repository. Then call goal_verdict exactly once with one entry per criterion above: verdict proven, not_proven or contradicted; a one-line reason; and for proven, evidence items with the file path (relative to the project root) and a verbatim quote of at least one full line. Do not answer in prose instead of calling the tool. If the tool is unavailable or fails, reply with ONLY a fenced json block as your final message: ```json {\"verdicts\":[{\"id\":\"C1\",\"verdict\":\"proven\",\"reason\":\"...\",\"evidence\":[{\"path\":\"relative/path\",\"quote\":\"verbatim line\"}]}]} ```")
    try {
      // T044: empty exchanges are retried once and always recorded — a silent
      // empty round is never accepted as an answer. Housekeeping (v0.3.1):
      // verifierTimeoutMs is the PER-ROUND budget (240s default — the two
      // provider hangs of the last run each burned a 120s round and were
      // retried too late); each of the two rounds gets the full budget, and
      // plugin/project config overrides it (ctx.options merge in the ctor).
      const perRoundMs = Math.max(Math.max(1, this.options.verifierMinRoundMs), this.options.verifierTimeoutMs)
      let round = 0
      let verdicts: VerifierVerdict[] = []
      let by: "verifier" | "verifier-fallback" = "verifier"
      // T016: persist the child transcript so a silent or prose-answering
      // verifier is diagnosable from the evidence, never a mystery again.
      let messages: unknown[] = []
      let outcome: "done" | "timeout" = "done"
      let retried = false
      while (round < 2) {
        round++
        const text =
          round === 1
            ? lines.join("\n")
            : "Your previous reply was empty — no text and no tool call came back. Answer now. Call goal_verdict exactly once with one entry per criterion from the original request (verdict proven, not_proven or contradicted; a one-line reason; for proven, evidence items with the file path relative to the project root and a verbatim quote of at least one full line). If the tool is unavailable or fails, reply with ONLY a fenced json block in the sanctioned shape. Another empty reply is a failure."
        await this.ctx.session.prompt({ sessionID: childID, text, resume: true } as any)
        const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), perRoundMs))
        outcome = await Promise.race([this.ctx.session.wait({ sessionID: childID } as any).then(() => "done" as const), timeout])
        if (outcome === "timeout") {
          // A verifier that CALLS goal_verdict just after the budget must still
          // be heard: one real round finished and was thrown away as a timeout.
          const grace = new Promise<void>((resolve) => setTimeout(resolve, this.options.verifierGraceMs))
          await Promise.race([this.ctx.session.wait({ sessionID: childID } as any).then(() => undefined).catch(() => undefined), grace])
          try { messages = ((await this.ctx.session.context({ sessionID: childID } as any)) ?? []) as unknown[] } catch { /* recorded as unavailable below */ }
          verdicts = this.verifierInbox.get(childID) ?? []
          if (verdicts.length) { outcome = "done"; break }
          await this.ctx.session.interrupt({ sessionID: childID } as any).catch(() => {})
          break
        }
        verdicts = this.verifierInbox.get(childID) ?? []
        try {
          messages = ((await this.ctx.session.context({ sessionID: childID } as any)) ?? []) as unknown[]
        } catch {
          // transcript unavailable on this host; the fallback simply has less to work with
        }
        if (verdicts.length) break
        if (exchangeEmpty(messages)) {
          this.store.ledger(state.slug, { type: "verifier-empty", turn: state.turn, round })
          if (round === 1) {
            retried = true
            continue
          }
        }
        break
      }
      if (!verdicts.length) {
        // A child that DID call goal_verdict but landed after the round budget
        // is still an answer: read it back from the captured transcript.
        const fromTranscript = verdictsFromTranscript(messages, new Set(criteria.map((c) => c.id)))
        if (fromTranscript.length) {
          verdicts = fromTranscript
          by = "verifier-fallback"
          this.store.ledger(state.slug, { type: "verifier-fallback", turn: state.turn, count: fromTranscript.length, from: "transcript" })
        }
      }
      if (!verdicts.length) {
        const parsed = parseFallbackVerdicts(messages, new Set(criteria.map((c) => c.id)))
        if (parsed.length) {
          verdicts = parsed
          by = "verifier-fallback"
          this.store.ledger(state.slug, { type: "verifier-fallback", turn: state.turn, count: parsed.length })
        }
      }
      const cause = verifierCause(messages, [this.root, ...readRoots])
      const transcript = this.store.evidence(state.slug, state.runId, `verifier-transcript-turn-${state.turn}-${Date.now()}`, { childID, done: outcome, by, rounds: round, retried, model: model?.label ?? null, ...(cause ? { cause } : {}), messages: compactTranscript(messages) })
      this.store.ledger(state.slug, { type: "verifier-transcript", turn: state.turn, by, rounds: round, retried, model: model?.label ?? null, file: transcript, ...(cause ? { cause } : {}) })
      const error = verdicts.length
        ? undefined
        : outcome === "timeout"
          ? `verifier timed out${cause ? ` — ${cause}` : messages.length ? ` after ${messages.length} transcript message(s); see ${transcript}` : " with no transcript available"}`
          : exchangeEmpty(messages)
            ? `verifier exchange was empty after ${round} round(s); recorded under evidence/ — never silent`
            : "verifier did not call goal_verdict"
      return { verdicts, by, ...(verdicts.length ? {} : { error: error! }) }
    } finally {
      this.verifierInbox.delete(childID)
      this.verifierScopes.delete(childID)
      await this.ctx.session.remove({ sessionID: childID } as any).catch(() => {})
    }
  }

  /**
   * T044: resolve the model the verifier child runs on, explicitly. Prefers
   * the parent session's live model (it is answering the worker's turns, so
   * it works on this host), then the location default. Returns the ref for
   * session.create plus a human-readable label for the ledger.
   */
  private async resolveVerifierModel(sessionID: string): Promise<{ ref: { providerID: string; id: string; variant?: string }; label: string } | undefined> {
    const of = (m: unknown) => {
      const model = m as { providerID?: string; id?: string; variant?: string } | null | undefined
      if (!model?.providerID || !model?.id) return undefined
      const variant = model.variant ? { variant: String(model.variant) } : {}
      return { ref: { providerID: String(model.providerID), id: String(model.id), ...variant }, label: `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` }
    }
    try {
      const info: any = await this.ctx.session.get({ sessionID } as any)
      const resolved = of(info?.model ?? info?.data?.model)
      if (resolved) return resolved
    } catch {
      // parent session info unavailable; try the location default
    }
    try {
      const picked: any = await this.ctx.model.default()
      const resolved = of(picked?.data ?? picked)
      if (resolved) return resolved
    } catch {
      // no default resolvable either; create falls back to the host's implicit resolution
    }
    return undefined
  }

  // ───────────────────────────── owner actions (command, RPC)

  async ownerAct(sessionID: string, action: "pause" | "resume" | "abort" | "verify" | "approve" | "reject" | "amend" | "archive" | "attach" | "start" | "start-next" | "decompose" | "revert", arg?: string, via: "form" | "dialog" = "dialog", decisionId?: string): Promise<{ ok: boolean; message: string }> {
    return this.serial(async () => {
      const pending = this.pendingDecisions.get(sessionID)
      const request = this.decisions.get(decisionId ?? pending?.id ?? "")
      if (decisionId && (!request || request.sessionID !== sessionID)) return { ok: false, message: "Unknown decision or wrong owner session; nothing executed." }
      const offered = request?.message.choices.some((c) => c.act === action && (c.arg ?? "") === (arg ?? ""))
      if (decisionId && !offered) return { ok: false, message: "That operation was not offered by this decision; nothing executed." }
      let reserved: DecisionRequest | undefined
      if (request && offered) {
        if (!["pending", "interrupted"].includes(request.status)) return { ok: false, message: "Decision already resolved, expired or executing; nothing executed." }
        const target = action === "start" && arg ? request.candidates[arg] ?? request.target : request.target
        const current = this.decisionTarget(target.slug)
        if (current.lock !== target.lock || current.runId !== target.runId || current.sessionID !== target.sessionID || current.status !== target.status) {
          this.decisions.update(request.id, { status: "failed", result: "Decision target changed since review; inspect and request a new decision." })
          return { ok: false, message: "Decision target changed since review; nothing executed." }
        }
        if (request.status === "interrupted") this.decisions.reopenForm(request.id)
        reserved = this.decisions.reserve(request.id)
        if (!reserved) return { ok: false, message: "Decision expired or reserved by another server; nothing executed." }
      }
      let result: { ok: boolean; message: string }
      const targeted = typeof reserved?.extra.targetKey === "string" ? this.list().find((g) => g.key === reserved.extra.targetKey) : undefined
      if (reserved?.extra.targetKey && !targeted) {
        this.decisions.update(reserved.id, { status: "failed", result: "Selected goal generation no longer exists." })
        return { ok: false, message: "Selected goal generation no longer exists; nothing executed." }
      }
      try { result = await this.ownerActLocked(sessionID, action, arg, reserved && action === "start" && arg ? reserved.candidates[arg]?.lock : undefined, targeted) }
      catch (error) { result = { ok: false, message: `Owner operation failed: ${String(error)}` } }
      if (reserved) {
        this.decisions.update(reserved.id, { status: result.ok ? "succeeded" : "interrupted", result: result.message })
        this.store.ledger(reserved.slug, { type: result.ok ? "decision-resolved" : "decision-attempt", decision: reserved.id, kind: reserved.kind, action, ...(arg ? { arg } : {}), ok: result.ok, message: result.message }, { archived: result.ok && action === "archive" })
        if (result.ok) {
          if (this.pendingDecisions.get(sessionID)?.id === reserved.id) this.pendingDecisions.delete(sessionID)
          if (this.pendingFormDecisions.get(sessionID)?.decisionId === reserved.id) this.pendingFormDecisions.delete(sessionID)
          void this.rpc?.events.emit("decision.resolved", { sessionID, kind: reserved.kind, decisionId: reserved.id, via, message: result.message }).catch(() => {})
        } else {
          this.decisions.reopenForm(reserved.id)
          if (this.pendingFormDecisions.get(sessionID)?.decisionId === reserved.id) this.pendingFormDecisions.delete(sessionID)
        }
      } else if (pending && !result.ok) {
        this.store.ledger(pending.slug, { type: "decision-attempt", decision: pending.id, kind: pending.kind, action, ok: false, message: result.message })
      }
      return result
    })
  }

  private async ownerActLocked(sessionID: string, action: Parameters<GoalApp["ownerAct"]>[1], arg?: string, expectedLock?: string, selected?: GoalSummary): Promise<{ ok: boolean; message: string }> {
      // T067: the complete decision's "start the next goal" dispatches the
      // write-goal interview right here — the owner picks the next goal from
      // the dialog instead of typing /goal new.
      if (action === "start-next") {
        await this.ctx.session.prompt({ sessionID, text: `Start the next goal: interview the owner for what they want done next (the write-goal skill guides the frontier rounds; no draft exists yet).`, skills: [{ id: "write-goal" }] } as any).catch(() => {})
        return { ok: true, message: "Dispatched the write-goal interview — the next question lands in this session." }
      }
      // T070: "Decompose with CLEO" was a dead-end guidance row at the
      // complete decision — picking it only toasted. It is a real act now:
      // the decomposition prompt lands in THIS session, and the next turn
      // files the completed goal's follow-ups as CLEO tasks.
      if (action === "decompose") {
        const state0 = this.runs.get(sessionID)
        const slug = state0?.slug ?? (arg ?? "").trim()
        const cleo = await cleoFacts(this.root, defaultRunner)
        if (!cleo) return { ok: false, message: "No .cleo workspace in this project — install CLEO first, then Decompose works as an act." }
        if (!slug) return { ok: false, message: "Which goal? /goal decompose <slug> (or run it from the goal's session)." }
        this.store.ledger(slug, { type: "decompose-dispatched", by: "owner", from: sessionID })
        await this.ctx.session
          .prompt({
            sessionID,
            text: [
              `CLEO-DECOMPOSE the goal "${slug}": read .opencode/goals/${slug}/ (the latest summary under evidence/, the ledger, and goal.yaml) and decompose the follow-ups into CLEO tasks.`,
              "For each follow-up (the summary's Follow-ups section, any discussed-but-unproven plan steps, and the non-goals the owner may want next): run `cleo add --type task --title <summary> --acceptance <how to prove it>` (plus `--parent <epic>` when the board has one), then link related tasks with `cleo relates add` where order matters.",
              "The goal folder is owner-owned history — read it, never edit it. Report the filed task ids when done.",
            ].join("\n"),
          } as any)
          .catch(() => {})
        return { ok: true, message: `Dispatched the CLEO decomposition of "${slug}" — the next turn files the follow-ups as tasks.` }
      }
      // T060: the start picker's dialog dispatches act "start" with the slug
      // as arg — the standard start path, in THIS session. startGoalLocked,
      // not startGoal: ownerAct already holds the queue (not reentrant).
      if (action === "start") {
        const slug = selected?.slug ?? (arg ?? "").trim().split(/\s+/)[0]
        if (!slug) return { ok: false, message: "Which goal? /goal start with no argument opens the picker." }
        const message = await this.startGoalLocked(sessionID, slug, "command", { expectedLock })
        return { ok: message.startsWith('Goal "'), message }
      }
      // T049: attach pulls a live goal into THIS session so every surface
      // (palette, card, panel, /goal commands) works here. The run keeps its
      // ledger, evidence and progress; only the owning session moves.
      if (action === "attach") {
        const currentHere = this.runs.get(sessionID)
        if (currentHere && !isTerminal(currentHere.status)) return { ok: false, message: `This session already has goal "${currentHere.slug}" (${currentHere.status}). Abort it first with /goal abort.` }
        const slug = selected?.slug ?? (arg ?? "").trim().split(/\s+/)[0]
        if (!slug) {
          const attachable = this.list().filter((g) => g.attachable)
          return { ok: false, message: attachable.length ? `Which goal? ${attachable.map((g) => `${g.slug} (${g.status})`).join(", ")} — /goal attach <slug>` : "No attachable goal: none is live in .opencode/goals/." }
        }
        const target = [...this.runs.values()].find((r) => r.slug === slug && !isTerminal(r.status))
        if (!target) return { ok: false, message: `No live goal "${slug}" here. /goal list shows what exists.` }
        if (this.amendmentReviews.all().some((p) => p.slug === target.slug && ["pending", "interrupted", "executing"].includes(p.status))) return { ok: false, message: "Resolve the selected goal's staged amendment before moving its owning session." }
        if (isActive(target.status)) return { ok: false, message: `"${slug}" is ${target.status} mid-turn; wait for the turn to end (or pause it from the goal's session), then attach.` }
        const from = target.sessionID
        this.invalidateOldDecision(target, "goal ownership attached into a different session")
        this.runs.delete(from)
        const timer = this.timers.get(from)
        if (timer) {
          this.timers.delete(from)
          this.timers.set(sessionID, timer)
        }
        const note = this.notes.get(from)
        if (note) {
          this.notes.delete(from)
          this.notes.set(sessionID, note)
        }
        target.sessionID = sessionID
        this.runs.set(sessionID, target)
        this.store.ledger(target.slug, { type: "attached", from, to: sessionID, by: "owner" })
        this.noticeM(sessionID, M.attached(target.title, target.status))
        await this.transcript(sessionID, `◎ owner attached the goal "${target.title}" (${target.status}) to this session. It continues here from now on — re-read the contract and run.json before acting.`)
        this.persist(target)
        this.emitUpdate(target)
        return { ok: true, message: `Goal "${target.slug}" attached to this session (${target.status}).` }
      }
       let state = selected ? [...this.runs.values()].find((s) => s.slug === selected.slug && s.runId === selected.runId) ?? this.store.readRun(selected.slug) : this.runs.get(sessionID)
       if (selected && !state) return { ok: false, message: "The selected goal has no live run to manage." }
      if (!state) {
        // T049: goals escape their session. With no goal here, act on the
        // project's unique non-terminal goal, or the slug the owner names
        // (… <slug> for most actions, /goal approve <C#> <slug> for verdicts).
        const tokens = (arg ?? "").trim().split(/\s+/).filter(Boolean)
        const slugHint = action === "approve" || action === "reject" ? tokens[1] : tokens[0]
        const live = [...this.runs.values()].filter((r) => !isTerminal(r.status))
        const named = slugHint ? live.find((r) => r.slug === slugHint) : undefined
        if (named) state = named
        else if (slugHint)
          return { ok: false, message: `No live goal "${slugHint}". Live goal(s): ${live.map((r) => r.slug).join(", ") || "none"}.` }
        else if (live.length === 1) state = live[0]!
        else if (live.length > 1)
          return { ok: false, message: `Several live goals: ${live.map((r) => `${r.slug} (${r.status})`).join(", ")}. Name one — /goal ${action} <slug>${action === "approve" || action === "reject" ? " <C#>" : ""} — or /goal attach <slug> to work on it here.` }
        else return { ok: false, message: "No goal in this session. Start one with /goal start <slug> or write one with /goal new <what you want>." }
      }
      const why = ownerCan(state, action)
      if (why) return { ok: false, message: why }
      if (action === "amend" && arg?.startsWith("review:")) {
        const review = this.amendmentReviews.get(arg.slice("review:".length))
        if (!review || review.sessionID !== sessionID || review.slug !== state.slug || review.runId !== state.runId || review.lock !== state.lock)
          return { ok: false, message: "The prerequisite review changed or belongs to another author; nothing applied." }
        return { ok: true, message: await this.reviewAmendment(sessionID, review) }
      }
      if (this.amendmentReviews.all().some((p) => p.slug === state!.slug && p.status === "executing"))
        return { ok: false, message: "An accepted amendment is committing. Reload to recover its recorded acceptance before managing this goal." }
      if (["resume", "verify", "amend", "approve", "reject"].includes(action) && this.amendmentReviews.all().some((p) => p.slug === state!.slug && ["pending", "interrupted"].includes(p.status)))
        return { ok: false, message: "This goal has an unresolved staged amendment. Resolve that exact review in Composer chat with goal_resolve_amendment before resuming or verifying; there is no sidebar Accept." }
      const contract = this.contractOf(state)
      switch (action) {
        case "pause":
          clearTimeout(this.timers.get(state.sessionID))
          this.timers.delete(state.sessionID)
          // T092: a paused run keeps no pending wake. Leaving state.wait set let
          // a later resume's turn-end resurrect the stale wait and strand the run.
          state.wait = undefined
          setStatus(state, "paused", "paused by you")
          this.store.ledger(state.slug, { type: "paused", reason: "owner" })
          this.persist(state)
          await this.transcript(state.sessionID, `◎ owner paused the goal (${state.title}). Stand by; the owner resumes it with /goal resume.`)
          return { ok: true, message: `Goal paused: ${state.title} — /goal resume · /goal abort` }
        case "resume": {
          if (state.status === "budget_limited") return { ok: false, message: "The goal used its budget. Raise budget in goal.yaml and start a new run, or abort it." }
          // T091: a resume is idempotent — an already-running run journals no
          // second receipt and is not admitted twice.
          if (state.status === "running" && !state.wait) return { ok: true, message: `Goal already running: ${state.title} — /goal status · /goal pause` }
          // T091/T092: clear the obsolete wakeup and any leftover wait before
          // resuming. Otherwise the busy turn's end resurrects the stale wait
          // and the run never gets its exactly-one continuation.
          clearTimeout(this.timers.get(state.sessionID))
          this.timers.delete(state.sessionID)
          state.wait = undefined
          state.counters = { noProgress: 0, failures: 0 }
          state.blocker = undefined
          state.wrapup = false
          setStatus(state, "running")
          state.fingerprint = fingerprint(this.executionRoot(contract))
          this.store.ledger(state.slug, { type: "resumed", by: "owner" })
          this.persist(state)
          await this.transcript(state.sessionID, `◎ owner resumed the goal. Re-read the contract and the current repository state, then continue from the first unfinished step.`)
          // While a turn is still busy the end-of-turn continuation admits
          // exactly once; otherwise kick off now.
          if (!this.factsOf(state.sessionID).busy) await this.admit(state, "resume")
          return { ok: true, message: `Goal resumed: ${state.title} — /goal status · /goal pause` }
        }
        case "abort":
          clearTimeout(this.timers.get(state.sessionID))
          setStatus(state, "aborted", "aborted by you")
          this.store.ledger(state.slug, { type: "aborted", reason: "owner" })
          this.persist(state)
          await this.transcript(state.sessionID, `◎ owner aborted the goal (${state.title}). Stop working on it; the ledger and evidence stay on disk.`)
          return { ok: true, message: `Goal aborted: ${state.title} — /goal archive (history intact) · /goal new <next>` }
        case "amend": {
          if (!contract) return { ok: false, message: "contract unavailable" }
          if (arg === "interview") {
            await this.goalIntent(sessionID, `amend the check for goal ${state.slug}; interview me about the change, then stage a validated diff with goal_propose_amendment. Do not edit the live contract or infer acceptance.`)
            return { ok: true, message: "Composer amendment interview started for the selected goal; no contract change or acceptance authorized." }
          }
          const confirmed = (arg?.split(/\s+/) ?? []).includes("confirm")
          const message = await this.amendGoal(state, confirmed)
          return { ok: message.startsWith("Amended") || message.startsWith("Proposed"), message }
        }
        case "revert":
          return this.revertPolicyChange(state)
        case "archive": {
          // T032: demote, never delete — the folder moves to goals-archive/
          // with ledger and evidence intact; the registry keeps answering yes.
          clearTimeout(this.timers.get(state.sessionID))
          const finalStatus = state.status
          this.store.ledger(state.slug, { type: "archived", from: finalStatus })
          this.registry.update(this.rootReal, state.slug, { title: state.title, status: finalStatus, ...(state.runId ? { runId: state.runId } : {}), ...(state.lock ? { lock: state.lock } : {}), archived: true, updatedAt: Date.now() })
          this.store.archive(state.slug)
          this.loaded.delete(state.slug)
          if (this.runs.get(state.sessionID)?.runId === state.runId) this.runs.delete(state.sessionID)
          this.noticeM(sessionID, M.archived(state.title, state.slug))
          return { ok: true, message: `Goal archived: ${state.title} — /goal list all · /goal new <next>` }
        }
        case "verify":
          if (!contract) return { ok: false, message: "contract unavailable" }
          await this.verify(state, contract, "owner")
          return { ok: true, message: `Verification ${state.status === "complete" ? "passed" : "did not pass"}: ${state.verdict?.lines[0] ?? ""} — /goal approve <C#> · /goal status` }
        case "approve":
        case "reject": {
          const id = (arg ?? "").trim().split(/\s+/)[0]?.toUpperCase()
          const criterion = contract?.criteria.find((c) => c.id === id)
          if (!criterion) return { ok: false, message: `Unknown criterion "${id}".` }
          state.criteria[criterion.id] = { status: action === "approve" ? "pass" : "fail", by: "human", at: Date.now(), detail: action === "approve" ? "approved by the owner" : `rejected by the owner: ${(arg ?? "").slice(id.length).trim() || "no reason given"}`, rejections: 0 }
          this.store.ledger(state.slug, { type: action, criterion: criterion.id })
          if (state.status === "needs_review" && action === "approve" && contract) {
            this.persist(state)
            await this.transcript(state.sessionID, `◎ owner approved ${criterion.id} (final — never re-checked). ${criterion.statement}`)
            await this.verify(state, contract, "owner")
            return { ok: true, message: `${criterion.id} approved; goal is ${state.status} — /goal verify · /goal status` }
          }
          this.persist(state)
          await this.transcript(
            state.sessionID,
            action === "approve"
              ? `◎ owner approved ${criterion.id} (final — never re-checked). ${criterion.statement}`
              : `◎ owner rejected ${criterion.id}: ${(arg ?? "").slice(id.length).trim() || "no reason given"}. Address the reason or flag the criterion if it is impossible as written.`,
          )
          return { ok: true, message: `${criterion.id} ${action === "approve" ? "approved" : "rejected"} — /goal verify · /goal status` }
        }
      }
  }

  // ───────────────────────────── registrations

  /** Read from THIS plugin's server/location, never the shell's unrelated
   * shared service. Pin bytes captured at setup rather than trusting a
   * version label, or whichever cache folder has the newest timestamp. */
  private async provenance(sessionID?: string): Promise<RuntimeProvenance> {
    const listed: any = await this.ctx.plugin.list({ location: { directory: this.root } } as any)
    const entries = Array.isArray(listed) ? listed : listed?.data ?? []
    const entry = entries.find((p: any) => p.id === "opencode-goal")
    const source = entry?.source ?? { type: "unknown" }
    const state = sessionID ? this.runs.get(sessionID) : undefined
    const result: RuntimeProvenance = {
      schema: "opencode-goal/provenance/v1", serverPID: process.pid,
      openCodeVersion: this.ctx.app.version, location: this.root,
      packageRoot: this.packageRoot,
      packageVersion: this.packageVersion,
      capturedAt: this.capturedAt, observedAt: Date.now(),
      source: { type: source.type, ...(source.target ? { target: source.target } : {}), ...(source.version ? { version: source.version } : {}), ...(source.outdated !== undefined ? { outdated: source.outdated } : {}) },
      artifacts: this.artifacts,
      status: entry?.state?.status ?? "unknown",
      features: { server: entry?.features?.server === true, tui: entry?.features?.tui === true, rpc: entry?.features?.rpc === true },
      ...(state ? { sessionID: state.sessionID, runId: state.runId, lock: state.lock } : {}),
    }
    // T115: this is a READ-ONLY probe. It returns the runtime identity and
    // writes NOTHING under .opencode/goals, so no read can look like an agent
    // hand-edit. The host records the evidence itself during verification
    // (verify() → recordProvenance), where a write is expected and owned.
    return result
  }

  private async scopedVerifierAgent(roots: string[]): Promise<string> {
    const name = `${this.options.verifierAgent}-${createHash("sha256").update(roots.join("\n")).digest("hex").slice(0, 10)}`
    if (this.scopedVerifierAgents.has(name)) return name
    const variants = (root: string) => { const plain = root.replace(/^\/private(?=\/(?:var|tmp)\/)/, ""); return /^\/(?:var|tmp)\//.test(plain) ? [plain, `/private${plain}`] : [root] }
    this.registrations.push(await this.ctx.agent.transform((editor: any) => {
      editor.update(name, (agent: any) => {
        agent.name = "Goal verifier (scoped)"
        agent.description = "Independent read-only verifier with owner-listed extra read roots."
        agent.mode = "subagent"
        agent.hidden = true
        agent.permissions.push(
          { action: "*", resource: "*", effect: "deny" },
          { action: "read", resource: "*", effect: "allow" },
          { action: "glob", resource: "*", effect: "allow" },
          { action: "grep", resource: "*", effect: "allow" },
          { action: "goal_verdict", resource: "*", effect: "allow" },
          ...roots.flatMap((root) => variants(root).flatMap((path) => [
            { action: "external_directory", resource: path, effect: "allow" },
            { action: "external_directory", resource: `${path}/*`, effect: "allow" },
          ])),
        )
      })
    }))
    this.scopedVerifierAgents.add(name)
    return name
  }

  private async registerAgents() {
    const name = this.options.verifierAgent
    this.registrations.push(
      await this.ctx.agent.transform((editor: any) => {
        editor.update(name, (agent: any) => {
          agent.name = "Goal verifier"
          agent.description = "Independent read-only verifier for goal completion claims."
          agent.mode = "subagent"
          agent.hidden = true
          agent.permissions.push(
            { action: "*", resource: "*", effect: "deny" },
            { action: "read", resource: "*", effect: "allow" },
            { action: "glob", resource: "*", effect: "allow" },
            { action: "grep", resource: "*", effect: "allow" },
            { action: "goal_verdict", resource: "*", effect: "allow" },
          )
        })
        for (const agent of editor.list()) {
          if (String(agent.id) === name || String(agent.id).startsWith(`${name}-`)) continue
          editor.update(String(agent.id), (item: any) => item.permissions.push({ action: "goal_verdict", resource: "*", effect: "deny" }))
        }
      }),
    )
  }

  private async registerSkill() {
    const path = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "write-goal", "SKILL.md")
    if (!existsSync(path)) return
    const raw = readFileSync(path, "utf8")
    const front = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
    const meta = front ? ((Bun as any).YAML.parse(front[1]) ?? {}) : {}
    const content = front ? raw.slice(front[0].length) : raw
    this.registrations.push(
      await this.ctx.skill.transform((editor: any) => {
        if (editor.get("write-goal")) return
        editor.add({ id: "write-goal", name: String(meta.name ?? "write-goal"), description: String(meta.description ?? "Write a goal contract for goal mode."), path, content })
      }),
    )
  }

  /** Run git and return stdout; never throws (empty string on failure). */
  private async gitText(args: string[]): Promise<string> {
    try {
      const child = Bun.spawn(["git", ...args], { cwd: this.root, stdout: "pipe", stderr: "ignore" })
      const [out] = await Promise.all([new Response(child.stdout).text(), child.exited])
      return out
    } catch {
      return ""
    }
  }

  /** The cleo CLI as a subprocess — the engine NEVER opens .cleo or its database. */
  private cleoRun: CleoRun = async (argv) => {
    const { stdout, exit } = await defaultRunner("cleo", argv, 120_000)
    return { stdout, exit }
  }

  /** Run a task's changed test files and emit the vitest-shaped JSON `test-run:` parses. */
  private async scopedCleoReport(testFiles: string[]): Promise<BridgeReport | undefined> {
    if (!testFiles.length) return undefined
    const dir = join(this.root, ".opencode", "cleo-reports")
    try { mkdirSync(dir, { recursive: true }) } catch { return undefined }
    const stamp = String(Date.now())
    const xml = join(dir, `bun-${stamp}.xml`)
    const json = join(dir, `report-${stamp}.json`)
    const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`
    const command = `bun test ${testFiles.map(quote).join(" ")} --reporter=junit --reporter-outfile=${quote(xml)}`
    await runShell(command, this.root, 1800)
    let report
    try { report = junitToVitestJson(readFileSync(xml, "utf8"), Date.now()) } catch { return undefined }
    const bytes = JSON.stringify(report, null, 2)
    try { writeFileSync(json, bytes) } catch { return undefined }
    return { reportPath: relative(this.root, json), reportSha256: sha256Hex(bytes), passed: report.success, total: report.numTotalTests, failed: report.numFailedTests }
  }

  /**
   * The goal→CLEO evidence bridge. The orchestration lives in the shipped
   * `runBridge` so the engine, the `/goal cleo sync` command and the CLI all
   * share one code path. The engine supplies the runners; the bridge stays
   * CLI-only and never opens `.cleo`.
   */
  private async runCleoBridge(tasks: string[], links: Map<string, CleoTaskLink>, commitByTask: Record<string, string> = {}): Promise<TaskOutcome[]> {
    return runBridge({ tasks, links, runCleo: this.cleoRun, git: (args: string[]) => this.gitText(args), report: (testFiles: string[]) => this.scopedCleoReport(testFiles), commitByTask })
  }

  /**
   * The link for a task: prefer the PRECISE per-criterion `proves` binding over
   * the older per-gate `acs` map. Nothing is inferred from position.
   */
  private cleoLinkFor(contract: Contract | undefined, task: CleoTaskLink): CleoTaskLink {
    const fromProves = acsByGateFromProves([...(contract?.criteria ?? []), ...(contract?.invariants ?? [])], task.id)
    const acs = Object.keys(fromProves).length ? fromProves : task.acs
    return { id: task.id, ...(acs ? { acs } : {}) }
  }

  private async registerCommand() {
    this.registrations.push(
      await this.ctx.command.transform((editor: any) => {
        editor.add({
          name: "goal",
          description: "Goal mode: /goal new <what you want> · start <slug> · status · pause · resume · verify · abort · approve <C#> · list",
          execute: async ({ sessionID, prompt }: any) => {
            const text = String(prompt?.text ?? "").trim()
            await this.command(sessionID, text)
          },
        })
      }),
    )
  }

  async command(sessionID: string, text: string) {
    const known = [...this.store.slugs(), ...this.store.archivedSlugs()]
    if (!directGoalCommand(text, known)) return this.goalIntent(sessionID, text)
    const [head = "", ...rest] = text.split(/\s+/)
    const arg = rest.join(" ").trim()
    const sub = head.toLowerCase()
    // T069: acknowledge + defer while a turn or form holds the session
    if (this.deferIfHeld(sessionID, text, sub)) return
    // Results go to the TUI as notices, never into the transcript: a synthetic
    // message here would land inside the turn the command just started.
    const say = async (message: string, level: "info" | "success" | "warning" | "error" = "info") => this.notice(sessionID, message, level)
    switch (sub) {
      case "":
      case "status": {
        const state = this.runs.get(sessionID)
        if (!state) return say(this.listText() || "No goal in this session. /goal new <what you want> writes one; /goal start <slug> runs an existing one.")
        void this.rpc?.events.emit("notice", { sessionID, level: "info", text: this.statusText(state), panel: true }).catch(() => {})
        return
      }
      case "list": {
        const archived = this.registry.list().filter((g) => g.project === this.rootReal && g.archived)
        const live = this.listText() || "No live goals in .opencode/goals/."
        const all = arg.toLowerCase() === "all"
        const archivedText = all
          ? archived.map((g) => `${g.slug} — archived (${g.status})`).join("\n")
          : archived.length
            ? `${archived.length} archived goal(s): ${archived.map((g) => g.slug).join(", ")} (/goal list all)`
            : ""
        return say([live, archivedText].filter(Boolean).join("\n"))
      }
      case "new":
      case "write": {
        if (!arg) return this.goalIntent(sessionID, "")
        // T033: admission probe before the interview — exact existence and
        // ranked similarity over live + archived goals, prepended for the
        // write-goal interview to surface as owner options.
        const candidates = [
          ...this.store.slugs().map((slug) => {
            const runState = this.store.readRun(slug)
            const read = this.store.readContract(slug)
            return { slug, title: runState?.title ?? read?.contract?.title ?? slug, ...(runState ? { status: runState.status } : {}) }
          }),
          ...this.store.archivedSlugs().map((slug) => {
            const read = this.store.readContract(slug)
            return { slug, title: read?.contract?.title ?? slug, status: "archived", archived: true as const }
          }),
          ...this.registry.list().filter((g) => g.project === this.rootReal).map((g) => ({ slug: g.slug, title: g.title, ...(g.status ? { status: g.status } : {}), ...(g.archived ? { archived: true as const } : {}) })),
        ]
        const deduped = [...new Map(candidates.map((c) => [c.slug, c])).values()]
        const slugHint = arg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64)
        const note = admissionNote(arg, slugHint, deduped)
        const first = note ? `${arg}\n\n${note}` : arg
        await this.ctx.session.prompt({ sessionID, text: first, skills: [{ id: "write-goal" }] } as any)
        return
      }
      case "start": {
        if (!arg) {
          // T060: no-arg /goal start used to be a dead usage line; it now
          // opens the startable-goal picker — a keyboard-selectable dialog
          // (the T050 decision machinery) wired to the start path via
          // act "start". Startable = contract here, not archived, no live
          // run anywhere (starting a goal another session owns is refused).
          const startable = this.store.slugs()
            .filter((slug) => {
              const live = [...this.runs.values()].some((r) => r.slug === slug && !isTerminal(r.status))
              if (live) return false
              const saved = this.store.readRun(slug)
              return !saved || isTerminal(saved.status)
            })
            .map((slug) => {
              const read = this.store.readContract(slug)
              const valid = Boolean(read?.contract) && read!.issues.every((i) => i.level !== "error")
              // T061: drafts order by priority then the goal.yaml mtime.
              let updatedAt = 0
              try {
                updatedAt = statSync(join(this.root, ".opencode", "goals", slug, "goal.yaml")).mtimeMs
              } catch {}
              return { slug, title: read?.contract?.title ?? slug, valid: valid as boolean, priority: read?.contract?.priority as "low" | "medium" | "high" | undefined, updatedAt }
            })
            .sort((a, b) => byPriorityThenRecency(a, b))
          if (!startable.length) {
            this.decide(sessionID, "(none)", "start-picker", M.startPickerEmpty(this.store.slugs().length))
            return say(`No startable goal — /goal new <what you want done> writes one.`, "warning")
          }
          this.decide(sessionID, "(picker)", "start-picker", M.startPicker(startable))
          return say(startable.map((g) => `${g.slug}${g.priority ? ` [${g.priority}]` : ""} — ${g.title}${g.valid ? "" : " (validation problems)"}`).join("\n"), "info")
        }
        const tokens = arg.split(/\s+/)
        const slug0 = tokens[0]!
        const acknowledgeSupersede = tokens.includes("acknowledge-supersede")
        if (!this.store.slugs().includes(slug0) && this.store.archivedSlugs().includes(slug0))
          return say(`"${slug0}" exists, archived at .opencode/goals-archive/${slug0}/ (history intact; it WAS a goal here). Move it back or write a superseding goal.`, "warning")
        // T059: start clean — the engine opens a NEW session owned by the
        // goal, pins the run to it and prompts the kickoff there. Nothing
        // clears the current session (no such API exists); it stays untouched.
        if (tokens.includes("fresh") && this.store.slugs().includes(slug0)) {
          const message = await this.startClean(sessionID, slug0)
          return say(message, message.startsWith("Started") ? "success" : "error")
        }
        const message = await this.startGoal(sessionID, slug0, "command", { acknowledgeSupersede })
        return say(message, message.startsWith("Goal \"") ? "success" : "error")
      }
      case "validate": {
        const slug = arg.split(/\s+/)[0]
        if (!slug) return say("Usage: /goal validate <slug>", "warning")
        const read = this.store.readContract(slug)
        return say(read ? formatIssues(read.issues) : `no goal named ${slug}`, read?.contract ? "success" : "error")
      }
      case "pause":
      case "resume":
      case "abort":
      case "verify":
      case "approve":
      case "reject":
      case "amend":
      case "archive":
      case "attach":
      case "revert":
      case "decompose": {
        const result = await this.ownerAct(sessionID, sub as any, arg)
        return say(result.message, result.ok ? "success" : "error")
      }
      case "cleo": {
        const parts = arg.trim().split(/\s+/).filter(Boolean)
        const what = (parts[0] ?? "").toLowerCase()
        const health = await cleoHealth(this.root, defaultRunner)
        if (!what) return say(cleoHealthReport(health))
        if (what === "install" || what === "init") {
          if (health.state === "initialized") return say(`CLEO is already initialized in this project — there is nothing to ${what}. /goal cleo re-checks.`)
          if (what === "init" && health.state === "cli-absent") return say(`Cannot initialize: the cleo CLI is not on PATH. Run /goal cleo install first, or install it yourself: ${CLEO_INSTALL_COMMAND}`, "warning")
          const command = what === "install" ? CLEO_INSTALL_COMMAND : CLEO_INIT_COMMAND
          const result = await runShell(command, this.root, 600)
          const after = await cleoHealth(this.root, defaultRunner)
          const detail = (result.stderr || result.stdout).trim().split("\n").slice(-6).join("\n")
          return say([`Ran on your explicit choice: ${command}`, `exit ${result.exit}${result.timedOut ? " (timed out)" : ""}`, after.detail, detail].filter(Boolean).join("\n"), result.exit === 0 ? "success" : "error")
        }
        if (what === "sync") {
          const rest = parts.slice(1)
          // T### links a task; T###@<sha> supplies the implementing commit for a
          // legacy task no commit message names (the case that defeated the
          // manual pass).
          const refs = rest.filter((p) => /^[A-Z]{1,4}\d+(?:@[0-9a-f]{4,40})?$/.test(p))
          const taskIds = refs.map((r) => r.split("@")[0]!)
          const commitByTask: Record<string, string> = {}
          for (const r of refs) { const [id, sha] = r.split("@"); if (id && sha) commitByTask[id] = sha }
          const slugHint = rest.find((p) => !refs.includes(p))
          const state = slugHint ? [...this.runs.values()].find((r) => r.slug === slugHint && !isTerminal(r.status)) ?? this.store.readRun(slugHint) : this.runs.get(sessionID)
          const contract = state ? this.contractOf(state) : undefined
          const links = new Map((contract?.cleo?.tasks ?? []).map((t) => [t.id, this.cleoLinkFor(contract, t)] as const))
          const tasks = taskIds.length ? taskIds : [...links.keys()]
          if (!tasks.length) {
            const subjects = (await this.gitText(["log", "--format=%s", "-n", "200"])).split("\n").filter(Boolean)
            const suggestions = suggestLinkedTasks(subjects)
            return say([`Which CLEO tasks? /goal cleo sync <slug> T123[ @sha] … — or name them in the goal's cleo.tasks block.`, suggestions.length ? `This project's commits reference: ${suggestions.join(", ")}` : "No commit here references a CLEO task id."].join("\n"), "warning")
          }
          const outcomes = await this.runCleoBridge(tasks, links, commitByTask)
          return say(bridgeReport(outcomes), outcomes.every((o) => o.completed) ? "success" : "error")
        }
        return say("Usage: /goal cleo [install|init|sync [<slug>] [T### …]]", "warning")
      }
      case "help":
        return say(goalHelp({ version: (this.ctx.options as any)?.version ?? "v0.2.0" }), "info")
      default:
        // Anything else is a request to write a goal from these words.
        await this.ctx.session.prompt({ sessionID, text, skills: [{ id: "write-goal" }] } as any)
    }
  }

  private async goalIntent(sessionID: string, text: string) {
    const state = this.runs.get(sessionID)
    const inventory = this.list().map((g) => ({ slug: g.slug, title: g.title, status: g.status, sessionID: g.sessionID }))
    const prompt = [
      "Goal entry — interpret the owner's intent, not merely the first word.",
      text ? `Owner's original words: ${JSON.stringify(text)}` : "No idea was supplied. Ask with native selectable options whether to create a goal or manage an existing goal, then ask for the idea if creating.",
      `Current session goal: ${state ? `${state.slug} (${state.status})` : "none"}. Project inventory: ${JSON.stringify(inventory)}`,
      "For a new idea, use the write-goal interview, validate and review the exact contract, then prepare a host-bound launch decision. For an existing goal request, resolve the target explicitly and use guarded typed goal operations; ask only for a genuine decision or unresolved target. For amendments, read the selected goal's current contract and run lock, then call goal_propose_amendment with the replacement YAML and rationale. Resolve actual owner chat accept/reject/revision with goal_resolve_amendment for the exact pending decisionId; the host fetches and consumes genuine consent once. Never invent a sidebar Accept, ask for manual goal commands, hand-edit a live contract, or treat review restoration as acceptance.",
      "Preserve the original words in intent.verbatim. Never execute this text as a shell command. A fresh start means a new session; the original history is not cleared.",
    ].join("\n")
    await this.ctx.session.prompt({ sessionID, text: prompt, skills: [{ id: "write-goal" }], metadata: { goal: { kind: "owner-intent" } } } as any)
  }

  private statusText(state: RunState): string {
    const v = this.view(state)
    if (!v) return `${state.slug}: ${state.status}`
    const proven = v.criteria.filter((c) => c.status === "pass").length
    return [`◎ ${v.title} — ${v.status}${v.reason ? ` (${v.reason})` : ""}`, `criteria ${proven}/${v.criteria.length} · turn ${v.turn}`, ...v.criteria.map((c) => `${c.status === "pass" ? "✓" : c.status === "fail" ? "✗" : "·"} ${c.id} ${c.statement}`)].join("\n")
  }

  private listText(): string {
    return this.list()
      .map((g) => `${g.slug} — ${g.status}${g.priority ? ` [${g.priority}]` : ""}${g.total ? ` (${g.proven}/${g.total})` : ""}`)
      .join("\n")
  }

  list(): GoalSummary[] {
    return projectInventory(this.store, this.runs.values(), { launches: this.launches.all() })
  }

  private async inventory(): Promise<GoalSummary[]> {
    return this.withSessionMetadata(this.list())
  }

  private async withSessionMetadata(rows: GoalSummary[]): Promise<GoalSummary[]> {
    // Read metadata from THIS connected server. A configured agent in YAML
    // is not proof of the agent actually attached to the recorded session.
    const info = new Map<string, any>()
    for (const sessionID of new Set(rows.flatMap((g) => g.sessionID ? [g.sessionID] : []))) {
      try { info.set(sessionID, await this.ctx.session.get({ sessionID } as any)) }
      catch (error: any) { info.set(sessionID, { unavailable: true, missing: /not.found/i.test(String(error?.type ?? error?.message ?? error)) }) }
    }
    return rows.map((row): GoalSummary => {
      if (!row.sessionID) return row
      const got = info.get(row.sessionID), session = got?.data ?? got
      if (!session || session.unavailable) return { ...row, sessionState: session?.missing ? "missing" : "unknown" }
      const directory = session.location?.directory
      const sessionState = typeof directory === "string" ? canonical(directory) === this.rootReal ? "present" : "elsewhere" : "unknown"
      return { ...row, sessionState, ...(typeof session.agent === "string" ? { agent: session.agent } : {}), ...(typeof session.title === "string" ? { sessionTitle: session.title } : {}) }
    })
  }

  private async manageGoal(sessionID: string, action: ManageAction, target: GoalTarget, forceReview = false) {
    return this.serial(async () => {
      if (!/^[a-f0-9]{64}$/.test(target.lock)) return { ok: false, message: "Invalid target lock; nothing executed." }
      try {
        const actor: any = await this.ctx.session.get({ sessionID } as any)
        if (canonical((actor?.data ?? actor)?.location?.directory ?? "") !== this.rootReal) return { ok: false, message: "The managing session is not in this project; nothing executed." }
      } catch { return { ok: false, message: "The managing session is unavailable; nothing executed." } }
      const selected = this.list().find((g) => g.key === target.key)
      const missing = selected ? (["runId", "sessionID"] as const).filter((field) => selected[field] !== undefined && target[field] === undefined) : []
      if (missing.length) return { ok: false, actionExecuted: false,
        message: `Missing target identity: ${missing.join(", ")}. Supply the complete key/runId/lock/sessionID from fresh goal_inventory; nothing executed.` }
      if (!selected || selected.lock !== target.lock || selected.runId !== target.runId || selected.sessionID !== target.sessionID)
        return { ok: false, actionExecuted: false, ...(selected ? { target: { key: selected.key, runId: selected.runId, sessionID: selected.sessionID, lock: selected.lock } } : {}),
          message: `Selected goal identity changed; the goal is a NEW generation since the tuple you passed${selected?.runId === target.runId ? ` (lock ${target.lock.slice(0, 12)} → ${String(selected?.lock).slice(0, 12)})` : ""}. The goal KEY is live:<slug>:<runId>, not the bare slug. Retry goal_manage with the refreshed target above, or read it from goal_status.` }
      if (!selected.valid || selected.archived || !selected.runId) {
        // T106: a goal whose only fault is that the disk differs from its lock
        // is not "read-only"; the divergence has exactly one supported fix and
        // it must be named here instead of a generic refusal.
        const liveGoal = [...this.runs.values()].find((s) => s.slug === selected.slug && !isTerminal(s.status))
        const divergent = liveGoal && this.divergenceOf(liveGoal)
        if (liveGoal && divergent)
          return { ok: false, actionExecuted: false, target: this.targetOf(liveGoal), message: `${this.divergenceRefusal(liveGoal, divergent)} No ${action} was executed.` }
        return { ok: false, message: "This selected goal is read-only (draft, archived or invalid); review/launch a valid draft instead." }
      }
      const state = [...this.runs.values()].find((s) => s.slug === selected.slug && s.runId === selected.runId) ?? this.store.readRun(selected.slug)
      if (!state) return { ok: false, message: "The selected run is unavailable; no other goal was used as a fallback." }
      const unavailable = action === "attach" ? !selected.attachable ? "Only a stopped live goal can attach." : undefined : ownerCan(state, action)
      if (unavailable) return { ok: false, message: unavailable }
      if (action === "verify" && state.status === "verifying") return { ok: false, message: "The selected goal is already verifying." }
      if (action === "resume" || action === "verify") {
        // T106/C2: a divergence is its own cause with its own fix; offering
        // the impossible amendment review (or a resume choice) first wastes
        // the round. The staged review stays pending and revives after recovery.
        const divergent = this.divergenceOf(state)
        if (divergent) return { ok: false, actionExecuted: false, target: this.targetOf(state),
          message: `${this.divergenceRefusal(state, divergent)} No ${action} question or amendment review was offered.` }
        const amendment = this.amendmentReviews.all().find((p) => p.slug === state.slug && ["pending", "interrupted", "executing"].includes(p.status))
        if (amendment) {
          // An owned review never actually presented can offer restoration,
          // not the impossible resume. Foreign/held reviews get no question.
          if (forceReview && amendment.sessionID === sessionID && !amendment.formID && ["pending", "interrupted"].includes(amendment.status)
            && !this.decisions.all(sessionID).some((p) => ["pending", "interrupted"].includes(p.status) && p.extra.amendmentId === amendment.id))
            this.decide(sessionID, state.slug, "owner-operation", { id: "goal.amendment.prerequisite", level: "warning",
              text: "An amendment is awaiting review; resume is not available until its disposition. Restore the exact review without accepting or resuming it.",
              choices: [{ label: "Review pending amendment", act: "amend", arg: `review:${amendment.id}`, run: "show the exact staged diff; no approval or resume" },
                { label: "Keep stopped", run: "leave the run and staged contract unchanged" }] }, { targetKey: selected.key, amendmentId: amendment.id })
          return { ok: false, actionExecuted: false, requiredReview: { id: amendment.id, sessionID: amendment.sessionID, kind: "amendment" },
            message: amendment.status === "executing"
            ? "An accepted amendment is committing; inspect its recovery receipt. No impossible resume review was offered."
            : `Resolve amendment ${amendment.id} in its authoring session ${amendment.sessionID} before ${action}. If that session is unavailable, stage the validated diff in a live session for a NEW owner review; no old approval transfers. No ${action} question was offered.` }
        }
      }
      if (forceReview && action === "resume" && state.sessionID === sessionID) {
        const generationAt = Math.max(state.createdAt, ...state.amendments.filter((a) => a.status === "accepted").map((a) => a.at),
          ...this.store.recent(state.slug, 1000).filter((e) => e.type === "paused").map((e) => Number(e.t) || 0))
        const messages: any = await this.ctx.session.context({ sessionID } as any)
        const review = this.decisions.all(sessionID).filter((p) => ["pending", "interrupted"].includes(p.status) && !reviewExpired(p)
          && p.kind === "owner-operation" && p.extra.targetKey === selected.key && p.target.lock === state.lock
          && p.target.runId === state.runId && p.target.sessionID === sessionID && p.target.status === state.status
          && p.message.choices.some((c) => c.act === "resume")).sort((a, b) => b.createdAt - a.createdAt)[0]
        const consent = ownerResumeMessage(messages?.data ?? messages, generationAt, review)
        if (consent && !this.decisions.all(sessionID).some((p) => p.ownerMessageID === consent.id)) {
          const message = M.managerOperation("resume", selected.title), now = Date.now()
          const request = this.decisions.create({ sessionID, slug: state.slug, kind: "owner-operation", lock: state.lock,
            target: this.decisionTarget(state.slug), candidates: {}, title: message.id, message,
            extra: { targetKey: selected.key }, ownerMessageID: consent.id, question: consent.text,
            createdAt: now, expiresAt: 0, expiryPolicy: "target", issuerPID: process.pid })
          const reserved = this.decisions.reserve(request.id)
          if (!reserved) return { ok: false, message: "The owner request was already consumed; no operation executed." }
          // Consume BEFORE attempting: a failed operation cannot turn an old
          // sentence into reusable worker authority after a restart.
          this.store.ledger(state.slug, { type: "owner-message-consumed", ownerMessageID: consent.id, decisionId: request.id,
            actorSessionID: sessionID, targetRunId: state.runId, lock: state.lock, action: "resume" })
          let result: { ok: boolean; message: string }
          try { result = await this.ownerActLocked(sessionID, "resume", undefined, undefined, selected) }
          catch (error) { result = { ok: false, message: `Owner operation failed: ${String(error)}` } }
          this.decisions.update(request.id, { status: result.ok ? "succeeded" : "failed", result: result.message })
          this.store.ledger(state.slug, { type: result.ok ? "decision-resolved" : "decision-attempt", decision: request.id,
            kind: request.kind, action: "resume", via: "owner-message", ok: result.ok, message: result.message })
          return result
        }
      }
      if (forceReview || action === "abort" || action === "archive") {
        const existing = this.decisions.all(sessionID).find((p) => ["pending", "interrupted"].includes(p.status) && !reviewExpired(p)
          && p.kind === "owner-operation" && p.extra.targetKey === selected.key && p.target.lock === state.lock
          && p.target.runId === state.runId && p.target.sessionID === state.sessionID && p.target.status === state.status
          && p.message.choices.some((c) => c.act === action))
        if (existing) {
          this.publishDecision(existing)
          if (existing.status === "pending") void this.askDecisionForm(sessionID, selected.slug, existing.kind, existing.id, existing.message)
          return { ok: true, pending: true, decisionId: existing.id, message: "The exact native decision is already pending in the Composer; no second review or operation was created." }
        }
        this.decide(sessionID, selected.slug, "owner-operation", M.managerOperation(action, selected.title), { targetKey: selected.key })
        const decisionId = this.pendingDecisions.get(sessionID)?.id
        return { ok: true, pending: true, decisionId, message: `Native ${action} confirmation offered for ${selected.slug}; no operation executed yet.` }
      }
      const result = await this.ownerActLocked(sessionID, action, action === "attach" ? selected.slug : undefined, undefined, selected)
      this.store.ledger(selected.slug, { type: "manager-action", actorSessionID: sessionID, targetRunId: selected.runId, action, ok: result.ok, message: result.message })
      return result
    })
  }

  private async unholdAmendmentChat(request: AmendmentRequest) {
    const current = this.amendmentReviews.get(request.id), state = this.runs.get(request.targetSessionID)
    const forms = this.factsOf(request.sessionID).forms
    if (!current?.chatAdmissionMessageID || !current.formID || forms.size !== 1 || !forms.has(current.formID)
      || !state || isTerminal(state.status) || state.runId !== current.runId || state.lock !== current.lock) return
    const messageID = current.chatAdmissionMessageID
    if (!this.amendmentReviews.takeChatAdmission(current.id, messageID)) return
    // The owner's admitted message may already be queued behind this form.
    // Stopping dispatch as well would strand that same authentic reply.
    await this.ctx.session.interrupt({ sessionID: current.sessionID, resume: true } as any)
    this.store.ledger(current.slug, { type: "amendment-chat-unheld", decisionId: current.id, previousFormID: current.formID,
      sourceMessageID: messageID, actionExecuted: false, reason: "explicit owner chat admitted; typed persisted-message validation still required" })
  }

  private async unholdLaunchChat(request: LaunchRequest) {
    const current = this.launches.get(request.id), forms = this.factsOf(request.sessionID).forms
    if (!current?.chatAdmissionMessageID || !current.formID || forms.size !== 1 || !forms.has(current.formID)) return
    const loaded = this.load(current.slug, true)
    if ("error" in loaded || loaded.lock !== current.lock) return
    const messageID = current.chatAdmissionMessageID
    if (!this.launches.takeChatAdmission(current.id, messageID)) return
    await this.ctx.session.interrupt({ sessionID: current.sessionID, resume: true })
    this.store.ledger(current.slug, { type: "launch-chat-unheld", decisionId: current.id, sourceMessageID: messageID,
      previousFormID: current.formID, actionExecuted: false, reason: "explicit chat admitted; actual persisted owner validation still required" })
  }

  private async registerHooks() {
    // A pending question holds generation. Let a genuine explicit chat reply
    // reach the agent; interruption is not acceptance and spends no consent.
    this.registrations.push(await this.ctx.session.hook("prompt", async (event: any) => {
      if (event.metadata?.goal) return
      const launch = this.launches.all(event.sessionID).filter((p) => ["pending", "interrupted", "expired"].includes(p.status))
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      if (launch) {
        const loaded = this.load(launch.slug, true)
        const shown = this.store.recent(launch.slug, 1000).findLast((e) => e.type === "launch-form-bound" && e.decisionId === launch.id)
        const candidate = [{ id: event.messageID, type: "user", text: event.prompt.text, time: { created: Date.now() } }]
        const intent = shown && !("error" in loaded) && loaded.lock === launch.lock
          ? ownerLaunchMessage(candidate, [{ id: launch.id, slug: launch.slug, lock: launch.lock, fresh: launch.fresh, at: Number(shown.t) }], launch) : undefined
        const noted = this.launches.noteChatAdmission(launch.id, intent ? event.messageID : undefined)
        if (intent && noted) await this.unholdLaunchChat(noted)
      }
      const requests = this.amendmentReviews.all(event.sessionID).filter((p) => ["pending", "interrupted"].includes(p.status) && !reviewExpired(p) && !p.recovery)
      if (requests.length !== 1) return
      const request = requests[0]!, state = this.runs.get(request.targetSessionID)
      if (!state || isTerminal(state.status)
        || state.runId !== request.runId || state.lock !== request.lock || request.issuerPID !== process.pid && processAlive(request.issuerPID)) return
      const candidate = [{ id: event.messageID, type: "user", text: event.prompt.text, time: { created: Date.now() } }]
      const intent = ownerAmendmentMessage(candidate, request, "accept") ?? ownerAmendmentMessage(candidate, request, "reject")
        ?? (/^(?:please\s+)?(?:change|amend|revise|instead)\b/i.test(event.prompt.text.trim()) ? ownerAmendmentMessage(candidate, request, "comment") : undefined)
      const noted = this.amendmentReviews.noteChatAdmission(request.id, intent ? event.messageID : undefined)
      if (!intent || !noted) return
      this.store.ledger(request.slug, { type: "amendment-chat-admission", decisionId: request.id, sourceMessageID: event.messageID, actionExecuted: false })
      await this.unholdAmendmentChat(noted)
    }))
    // R5 + S3: render the contract into every request for sessions with a live goal.
    this.registrations.push(
      await this.ctx.session.hook("context", (event: any) => {
        const state = this.runs.get(event.sessionID)
        if (!state || isTerminal(state.status) || state.status === "aborted") return
        const contract = this.contractOf(state)
        if (!contract) return
        event.system.push({ type: "text", text: renderSystemBlock(contract, state.lock) })
        const note = this.notes.get(event.sessionID)
        if (!note || !isActive(state.status)) return
        // Just before the turn's own prompt, so the note keeps one position for
        // every step of the turn and the cached prefix before it stays warm.
        let at = event.messages.length
        for (let i = event.messages.length - 1; i >= 0; i--)
          if (event.messages[i]?.role === "user") {
            at = i
            break
          }
        event.messages.splice(at, 0, makeUserMessage(event.messages, note))
      }),
    )
    this.registrations.push(
      await this.ctx.session.hook("compaction", (event: any) => {
        const state = this.runs.get(event.sessionID)
        const contract = state && this.contractOf(state)
        if (!state || !contract || isTerminal(state.status)) return
        event.system.push({ type: "text", text: `${renderSystemBlock(contract, state.lock)}\n\nPreserve in the summary: the goal "${contract.title}" is ${state.status}; progress so far: ${state.progress?.note ?? "none recorded"}; next: ${state.progress?.next ?? "continue the plan"}.` })
      }),
    )
    this.registrations.push(
      await this.ctx.tool.hook("execute.before", (event: any) => {
        const state = this.runs.get(event.sessionID)
        const live = [...this.runs.values()].filter((s) => !isTerminal(s.status))
        const contract = state && this.contractOf(state)
        if (event.tool === "question" && state && contract && isActive(state.status) && contract.autonomy.questions === "defer" && !this.ownedDecisionQuestion(event.sessionID, event.input) && !this.ownedLaunchQuestion(event.sessionID, event.input) && !this.ownedAmendmentQuestion(event.sessionID, event.input))
          // T075 exception: the ENGINE-initiated decision form (askDecisionForm's
          // prompt) is the owner's ask — the worker's own questions stay deferred.
          throw new Error("Goal mode defers questions to the owner during a run. Make the most reasonable reversible choice and note it as an assumption in goal_progress, or call goal_block if this truly needs the owner.")
        const paths = targetPaths(event.tool, event.input)
        for (const p of paths) {
          const rel = relative(this.root, resolve(this.root, p))
          if (rel === ".." || rel.startsWith("../")) continue
          // T037: the goal folder stays untouchable for the whole life of the
          // run — including stopped states (paused/needs_review/budget_limited),
          // the unguarded amendment window the council flagged. Terminal runs
          // release the folder so the next contract can be written.
          const ownedRunPath = live.some((s) => rel === `.opencode/goals/${s.slug}` || rel.startsWith(`.opencode/goals/${s.slug}/`))
          const ownerReceipt = /^\.opencode\/goals\/\.(?:owner-|launch-approvals)/.test(rel)
          if (rel.startsWith(".opencode/goals-archive/") || ownerReceipt || ownedRunPath || state && !isTerminal(state.status) && rel.startsWith(".opencode/goals/"))
            throw new Error("The goal contract and run state are owned by the owner and the host. Do not edit a live goal folder, owner consent records or archived history. Run state changes go through goal_progress, goal_wait, goal_block, goal_flag, goal_claim, goal_manage or goal_recover_divergence; a contract change goes through goal_propose_amendment for native owner acceptance.")
          // A goal-less manager session may propose a diff, but it is not a
          // loophole for editing another session's protected oracle.
          if (live.some((s) => this.contractOf(s)?.protect.some((g) => globMatch(rel, g))))
            throw new Error(`${rel} is protected by the goal contract (an oracle the worker may not change). If it is wrong, call goal_flag.`)
        }
      }),
    )
  }

  private async registerRpc() {
    try {
      const registration: any = await (this.ctx.rpc as any).register(GoalRpc, {
        provenance: async (input: { sessionID?: string }) => this.provenance(input.sessionID),
        snapshot: async (input: { sessionID: string }) => {
          const state = this.runs.get(input.sessionID)
          const launches = this.launches.all(input.sessionID).map(launchView)
          return { view: state ? (this.view(state) ?? null) : null, launches }
        },
        list: async () => ({ goals: await this.inventory(), directory: this.root }),
        details: async (input: { key: string }) => ({ goal: (await this.withSessionMetadata(projectInventory(this.store, this.runs.values(), { detailsForKey: input.key, launches: this.launches.all() }).filter((g) => g.key === input.key)))[0] ?? null }),
        review: async (input: { sessionID: string; decisionId?: string }) => {
          try { return { ok: true, message: await this.reviewDecision(input.sessionID, input.decisionId) } }
          catch (error) { return { ok: false, message: String(error instanceof Error ? error.message : error), actionExecuted: false } }
        },
        manage: async (input: { sessionID: string; action: ManageAction; target: GoalTarget }) => this.manageGoal(input.sessionID, input.action, input.target),
        act: async (input: { sessionID: string; action: any; arg?: string; decisionId?: string }) => this.ownerAct(input.sessionID, input.action, input.arg, "dialog", input.decisionId),
      })
      this.rpc = registration
      this.registrations.push(registration)
    } catch {
      // RPC is optional: without it the server still runs goals; the TUI shows nothing.
    }
  }

  // ───────────────────────────── worker tools (S7: native names, codemode off)

  private async registerTools() {
    // T062: goal tools are registered codemode:false — they never exist in
    // Code Mode's catalog. A live run mis-routed goal_claim through `execute`
    // and got a misleading Unknown-tool error, so every description says so.
    const hint = " Called directly by name — never available inside Code Mode/execute."
    const tool = (name: string, description: string, input: Record<string, unknown>, execute: (args: any, context: any) => Promise<string | Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
      name,
      description: `${description}${hint}`,
      options: { namespace: "goal", codemode: false, ...extra },
      input: { type: "object", additionalProperties: false, ...input },
      execute: async (args: any, context: any) => {
        const out = await execute(args ?? {}, context)
        return typeof out === "string" ? { content: out } : { content: json(out), metadata: out }
      },
    })
    const forSession = (context: any) => this.runs.get(context.sessionID)
    const guard = (context: any, action: Parameters<typeof modelCan>[1]) => {
      const state = forSession(context)
      const why = modelCan(state, action)
      if (why) throw new Error(why)
      return state!
    }

    const tools = [
      tool("manage", "Request a supported lifecycle operation on the EXACT selected project goal. Use goal_inventory for target key/runId/lock/sessionID. A current, explicit owner resume/continue message can authorize one resume of that same session/run/lock; the host reads and consumes the original message, never worker-supplied consent. Otherwise a native owner decision is prepared. Cannot waive criteria, approve evidence or execute arbitrary owner operations.", { properties: { action: { type: "string", enum: ["pause", "resume", "verify", "attach", "abort", "archive"] }, target: GoalRpc.methods.manage.input.properties.target }, required: ["action", "target"] }, async (args, context) => {
        // After reload this instance may have missed execution.started. A
        // model tool call proves the turn is still busy; resume must not
        // enqueue a competing kickoff alongside this owner-approved work.
        this.factsOf(context.sessionID).busy = true
        return this.manageGoal(context.sessionID, args.action, args.target, true)
      }),
      tool("inventory", "Read every goal contract in THIS project: drafts, live/stopped/complete runs and archives, with real session/agent/progress/priority and existing contract metadata. Goal contracts are not CLEO tasks; never infer a goal parent from a task ID. Unknown/missing metadata is reported honestly; this performs no lifecycle operation.", { properties: {} }, async () => ({ goals: await this.inventory() })),
      tool("review", "Re-present this session's pending engine decision in a native owner form after dismissal/commentary. Optional decisionId selects the exact review; this never approves, resumes or executes an operation. Expired reviews need a new review; changed target generations are refused.", { properties: { decisionId: { type: "string", minLength: 1, maxLength: 256 } } }, async (args, context) => this.reviewDecision(context.sessionID, args.decisionId ? String(args.decisionId) : undefined)),
      tool("resolve_amendment", "Resolve an exact staged amendment from the actual owner's latest Composer chat. The host fetches that user message and binds it once; tool-supplied text, quoted/conditional/stale/replayed consent cannot authorize anything. No sidebar/manual command or fabricated form reply. The host honors explicit owner continuation (resume/continue/get it done) after accepting this reviewed next lock even if the optional hint is omitted or false. A true continueGoal hint still requires that same actual owner directive; it never approves criteria.", {
        properties: { decisionId: { type: "string", minLength: 1, maxLength: 256 }, action: { type: "string", enum: ["accept", "reject", "comment"] }, continueGoal: { type: "boolean" } }, required: ["decisionId", "action"],
      }, async (args, context) => this.resolveAmendmentChat(context.sessionID, { decisionId: String(args.decisionId), action: args.action, continueGoal: args.continueGoal === true })),
      tool("propose_amendment", "Stage a validated replacement YAML contract as a reviewed diff for a selected live goal. Does NOT edit goal.yaml or grant consent. Exact owner accept/reject/comment is required; changed statements/checks reset proof and the goal remains stopped. Never call an owner accept operation yourself.", { properties: { slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }, expectedLock: { type: "string", pattern: "^[a-f0-9]{64}$" }, yaml: { type: "string", minLength: 1, maxLength: 200000 }, rationale: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["slug", "expectedLock", "yaml", "rationale"] }, async (args, context) => this.proposeAmendment(context.sessionID, { slug: String(args.slug), expectedLock: String(args.expectedLock), yaml: String(args.yaml), rationale: String(args.rationale) })),
      tool("recover_divergence", "When a live goal's disk goal.yaml differs from its locked contract (an edit made outside the engine), offer the owner a native review of the exact difference and last-writer provenance: Adopt disk version, Restore locked version or Leave unchanged. Callable from any live session of this project. No earlier proposal or approval counts. Inside an owner-set autonomy policy that includes recover, an in-policy difference is adopted directly, journalled and owner-revertible. Never edit goal.yaml yourself.", { properties: { slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }, expectedLock: { type: "string", pattern: "^[a-f0-9]{64}$" } }, required: ["slug", "expectedLock"] }, async (args, context) => this.recoverDivergence(context.sessionID, { slug: String(args.slug), expectedLock: String(args.expectedLock) })),
      tool("prepare_launch", "Validate and stage an exact goal contract for native owner review and same/fresh-session launch. The host executes the owner's choice directly, including after reload or an interrupted question result. Preparation is not permission to start or approve yourself.", { properties: { slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }, fresh: { type: "boolean" } }, required: ["slug"] }, async (args, context) => this.prepareLaunch(context.sessionID, String(args.slug), args.fresh === true)),
      tool("provenance", "Report the actual server PID, location, installed Git revision and loaded server/UI/skill artifact hashes for this goal session. Never substitute an unscoped shared-service or newest-cache lookup for this evidence.", { properties: {} }, async (_args, context) => ({ ...await this.provenance(context.sessionID) })),
      tool("status", "Show the active goal: status, criteria board, plan, budget, last verdict. Cheap; use it after a compaction or when unsure what remains.", { properties: {} }, async (_args, context) => {
        const state = forSession(context)
        if (!state) return "No goal is running in this session."
        return this.view(state) ?? { status: state.status }
      }),
      tool(
        "progress",
        "Record progress only on the active goal in this session. Check goal_status after interruption/reload; stopped or terminal goals return recorded:false with their exact status and no mutation. Do not retry a stopped goal or infer resume permission. Keep note and next within 400 characters each; plan progress is not host-proven criteria.",
        {
          properties: {
            step: { type: "string", description: "Plan step id, e.g. S2" },
            step_done: { type: "boolean", description: "true when the step is finished" },
            note: { type: "string", maxLength: 400, description: "What changed this turn (one line)" },
            next: { type: "string", maxLength: 400, description: "The next concrete action" },
          },
          required: ["note"],
        },
        async (args, context) =>
          this.serial(() => {
            const selected = forSession(context)
            const unavailable = modelCan(selected, "progress")
            if (unavailable) return { ok: false, recorded: false, status: selected?.status ?? "none", message: unavailable,
              nextAction: selected && !isTerminal(selected.status) ? "Owner may resume this exact goal; do not retry progress while stopped." : "Inspect goal_status; no progress was recorded.",
              ...(selected ? { slug: selected.slug, runId: selected.runId } : {}) }
            const state = selected!
            const contract = this.contractOf(state)
            if (args.step) {
              const id = String(args.step).toUpperCase()
              if (!contract?.plan.some((s) => s.id === id)) throw new Error(`unknown plan step ${id}`)
              const before = state.steps[id]
              state.steps[id] = args.step_done ? "done" : "active"
              if (args.step_done) {
                const nextStep = contract!.plan.find((s) => state.steps[s.id] === "pending" && s.depends_on.every((d) => state.steps[d] === "done"))
                if (nextStep) state.steps[nextStep.id] = "active"
              }
              if (before !== state.steps[id]) state.turnFacts.stepsChanged = true
            }
            state.progress = { note: String(args.note).slice(0, 400), ...(args.next ? { next: String(args.next).slice(0, 400) } : {}), at: Date.now(), turn: state.turn }
            state.turnFacts.goalCalls += 1
            // T108: a recorded progress note is host-visible work, so it counts
            // as progress for the stall detector.
            state.turnFacts.progressRecorded = true
            this.store.ledger(state.slug, { type: "progress", turn: state.turn, step: args.step, done: !!args.step_done, note: state.progress.note, next: state.progress.next })
            this.persist(state)
            return { ok: true, recorded: true, status: state.status, slug: state.slug, runId: state.runId, message: "Recorded. Plan progress does not approve completion criteria." }
          }),
      ),
      tool(
        "claim",
        "Claim the goal is complete. Give evidence per criterion (what you ran or inspected and what it showed). Then END YOUR TURN: the host runs every check itself and an independent verifier reviews the rest. Never claim to escape the loop.",
        {
          properties: {
            summary: { type: "string", maxLength: 2000 },
            evidence: { type: "object", description: "Map of criterion id → evidence note, e.g. {\"C1\": \"npm test: 84 passed\"}", additionalProperties: { type: "string", maxLength: 1000 } },
          },
          required: ["summary", "evidence"],
        },
        async (args, context) =>
          this.serial(() => {
            const state = guard(context, "claim")
            const contract = this.contractOf(state)!
            const evidence = Object.fromEntries(Object.entries(args.evidence ?? {}).map(([k, v]) => [k.toUpperCase(), String(v).slice(0, 1000)]))
            const missing = contract.criteria.filter((c) => c.essential && !evidence[c.id]).map((c) => c.id)
            if (missing.length) throw new Error(`Give evidence for every essential criterion; missing: ${missing.join(", ")}`)
            state.claim = { at: Date.now(), turn: state.turn, summary: String(args.summary).slice(0, 2000), evidence }
            for (const id of Object.keys(evidence)) if (state.criteria[id] && state.criteria[id]!.status !== "pass") state.criteria[id]!.status = "claimed"
            this.store.ledger(state.slug, { type: "claim", turn: state.turn, summary: state.claim.summary })
            this.persist(state)
            return "Claim recorded. End your turn now; the host will verify it and either complete the goal or return a verdict."
          }),
      ),
      tool(
        "block",
        "Report a blocker that only the owner can resolve (a missing credential, an access grant, a product decision). Use a short stable key so repeats are counted; after 3 consecutive reports the goal stops and asks the owner. Hard or slow work is not a blocker.",
        {
          properties: {
            key: { type: "string", maxLength: 80, description: "Stable key, e.g. missing-stripe-key" },
            reason: { type: "string", maxLength: 500 },
            needs: { type: "string", enum: ["decision", "credential", "access", "external"] },
          },
          required: ["key", "reason"],
        },
        async (args, context) =>
          this.serial(() => {
            const state = guard(context, "block")
            const key = String(args.key).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 80)
            const same = state.blocker?.key === key && state.blocker.lastTurn >= state.turn - 1
            state.blocker = { key, count: same ? state.blocker!.count + (state.blocker!.lastTurn === state.turn ? 0 : 1) : 1, reason: String(args.reason).slice(0, 500), ...(args.needs ? { needs: String(args.needs) } : {}), lastTurn: state.turn }
            this.store.ledger(state.slug, { type: "block", key, count: state.blocker.count, reason: state.blocker.reason })
            this.persist(state)
            return state.blocker.count >= this.options.blockerRepeats
              ? "Blocker confirmed. The goal will stop and ask the owner when this turn ends."
              : `Blocker noted (${state.blocker.count}/${this.options.blockerRepeats}). Continue with any work that does not depend on it.`
          }),
      ),
      tool(
        "flag",
        "Flag a criterion that is contradictory, impossible or unsafe as written. The goal stops for the owner to review. Use this instead of gaming a check.",
        {
          properties: {
            criterion: { type: "string" },
            kind: { type: "string", enum: ["contradictory", "impossible", "unsafe"] },
            reason: { type: "string", maxLength: 800 },
          },
          required: ["kind", "reason"],
        },
        async (args, context) =>
          this.serial(() => {
            const state = guard(context, "flag")
            state.flags.push({ ...(args.criterion ? { criterion: String(args.criterion).toUpperCase() } : {}), kind: String(args.kind), reason: String(args.reason).slice(0, 800), at: Date.now() })
            setStatus(state, "needs_review", `${args.criterion ? `${String(args.criterion).toUpperCase()} ` : ""}flagged ${args.kind}: ${String(args.reason).slice(0, 160)}`)
            this.store.ledger(state.slug, { type: "flag", ...state.flags.at(-1) })
            this.noticeM(state.sessionID, M.needsReview(state.reason ?? "criterion failed repeatedly"))
            this.persist(state)
            return "Flag recorded; the goal is stopped for the owner's review. End your turn."
          }),
      ),
      tool(
        "wait",
        "Pause the loop without spending tokens while an external process runs (a build, a deploy, CI). The host resumes the goal after the given seconds.",
        {
          properties: {
            seconds: { type: "number", minimum: 10, maximum: 3000 },
            reason: { type: "string", maxLength: 300 },
          },
          required: ["seconds", "reason"],
        },
        async (args, context) =>
          this.serial(() => {
            const state = guard(context, "wait")
            const seconds = Math.max(10, Math.min(3000, Number(args.seconds) || 60))
            state.wait = { until: Date.now() + seconds * 1000, reason: String(args.reason).slice(0, 300) }
            state.activity = { kind: "waiting", since: Date.now(), until: state.wait.until, detail: state.wait.reason }
            this.store.ledger(state.slug, { type: "wait", seconds, reason: state.wait.reason })
            this.persist(state)
            this.noticeM(state.sessionID, M.goalWait(seconds, state.wait.reason))
            return `The goal will resume in ${seconds}s. End your turn now.`
          }),
      ),
      tool(
        "validate",
        "Validate a goal contract at .opencode/goals/<slug>/goal.yaml and report every problem. Use while writing a goal.",
        { properties: { slug: { type: "string", maxLength: 64 } }, required: ["slug"] },
        async (args) => {
          const read = this.store.readContract(String(args.slug))
          if (!read) return `No file at .opencode/goals/${args.slug}/goal.yaml`
          return `${formatIssues(read.issues)}${read.contract ? `\nlock ${read.lock.slice(0, 12)} · ${read.contract.criteria.length} criteria (${read.contract.criteria.filter((c) => isHostCheck(c.check)).length} host-checked), ${read.contract.invariants.length} invariants` : ""}`
        },
      ),
      tool(
        "start",
        `Start a validated goal only after genuine owner approval: a bound native choice, an explicit actual owner chat instruction for the exact previously displayed contract/session/mode, or the owner's /goal start. The host fetches and consumes chat itself once; expired form answers, worker text and changed targets cannot authorize it. With fresh: true the reviewed mode must create a NEW goal session, preserving this one.`,
        { properties: { slug: { type: "string", maxLength: 64 }, fresh: { type: "boolean", description: "Start clean: open a new session owned by the goal, prompt the kickoff there, leave this session untouched" } }, required: ["slug"] },
        async (args, context) => {
          this.factsOf(context.sessionID).busy = true
          const chat = await this.launchFromOwnerChat(context.sessionID, String(args.slug), args.fresh === true)
          if (chat !== undefined) return chat
          const approval = this.launchApproval(context.sessionID)
          if (!approval) {
            // T068: a refusal names what was observed so the agent can
            // self-correct instead of guessing between never-asked, wrong
            // label and expired. An expired approval leaves its record on
            // disk (any age); a wrong label is known from the last form
            // answer in memory.
            const seen = this.factsOf(context.sessionID).lastFormAnswer
            const diskRecord = this.readLaunchApprovals()[context.sessionID]
            const matched = (label?: string) => !!label && (label === LAUNCH_LABEL || label.startsWith(LAUNCH_LABEL))
            const detail = diskRecord && matched(diskRecord.label) && Date.now() - diskRecord.at > this.options.launchApprovalMs
              ? `the approval expired (a ${Math.round(this.options.launchApprovalMs / 60_000)}-minute window; restarts keep it until then)`
              : !seen || seen.labels.some(matched)
                ? "no launch approval was seen in this session"
                : `the owner's last answer was ${JSON.stringify(seen.labels[0] ?? "")}, which does not start with "${LAUNCH_LABEL}"`
            throw new Error(
              `Launching a goal needs the owner's approval: ${detail}. Use a fresh exact native review, or an explicit actual owner start instruction for the already displayed unchanged draft. No expired choice was replayed; restarting does not authorize it.`,
            )
          }
          this.factsOf(context.sessionID).launchApprovedAt = undefined
          if (!approval.slug || !approval.lock || approval.fresh !== false || approval.slug !== String(args.slug) || args.fresh === true)
            throw new Error("Legacy launch approval does not bind this goal/contract/mode. Use goal_prepare_launch for an exact native review; nothing started.")
          this.clearLaunchApproval(context.sessionID)
          return this.startGoal(context.sessionID, String(args.slug), "tool", { expectedLock: approval.lock, decisionId: `legacy:${approval.formID}` })
        },
      ),
      tool(
        "verdict",
        "Verifier only: record your verdict for every criterion you were asked to judge.",
        {
          properties: {
            verdicts: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  verdict: { type: "string", enum: ["proven", "not_proven", "contradicted"] },
                  reason: { type: "string", maxLength: 600 },
                  evidence: { type: "array", items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, quote: { type: "string", maxLength: 2000 } }, required: ["path", "quote"] } },
                },
                required: ["id", "verdict"],
              },
            },
          },
          required: ["verdicts"],
        },
        async (args, context) => {
          if (String(context.agent) !== this.options.verifierAgent && !this.scopedVerifierAgents.has(String(context.agent))) throw new Error("goal_verdict is reserved for the goal verifier.")
          const verdicts: VerifierVerdict[] = (args.verdicts ?? []).map((v: any) => ({ id: String(v.id).toUpperCase(), verdict: v.verdict, ...(v.reason ? { reason: String(v.reason) } : {}), evidence: Array.isArray(v.evidence) ? v.evidence.map((e: any) => ({ path: String(e.path), quote: String(e.quote) })) : [] }))
          this.verifierInbox.set(String(context.sessionID), verdicts)
          return "Verdict recorded. You are done; end your turn."
        },
        { permission: "goal_verdict" },
      ),
    ]

    this.registrations.push(
      await this.ctx.tool.transform((editor: any) => {
        for (const t of tools) editor.add(t)
      }),
    )
  }
}

// ───────────────────────────── helpers

/** Reduce a child session's messages to a storable, human-readable transcript. */
/** Name why a verifier round stalled: Core reports "Permission denied:
 * external_directory" without the path, so pair it with the absolute paths
 * the child asked for outside the project and its granted read roots. */
/** T107: parse the contract's verifier model/effort. Never throws — an unusable
 * value returns a `reason` so the caller falls back to the resolved default and
 * journals why. `#variant` on the model wins over a separate `effort`. */
export function contractVerifierModel(v: { model?: string; effort?: string }): { ref?: { providerID: string; id: string; variant?: string }; label?: string; requested?: string; reason?: string } {
  const raw = (v.model ?? "").trim()
  const effort = (v.effort ?? "").trim()
  if (!raw) return effort ? { reason: `verification.effort "${effort}" was given without verification.model` } : {}
  const m = /^([\w][\w.-]*)\/([^#/\s]+)(?:#(\S+))?$/.exec(raw)
  if (!m) return { requested: raw, reason: `verification.model "${raw}" is not "providerID/modelID[#variant]"` }
  const variant = m[3] ?? (effort || undefined)
  return { ref: { providerID: m[1]!, id: m[2]!, ...(variant ? { variant } : {}) }, label: `${m[1]}/${m[2]}${variant ? `#${variant}` : ""}` }
}

/** The parts of a context message. OpenCode carries them under `parts` in some
 * versions and under `content` (an array) in others; both readers here and the
 * transcript builder must see the same parts, or a denial or a late verdict is
 * silently missed. */
export function messageParts(message: unknown): any[] {
  const m = message as { parts?: any[]; content?: any } | undefined
  return m?.parts ?? (Array.isArray(m?.content) ? m.content : [])
}

/** A goal_verdict call captured in the transcript but recorded too late. */
export function verdictsFromTranscript(messages: unknown[], ids: Set<string>): VerifierVerdict[] {
  for (const message of messages ?? []) {
    for (const part of messageParts(message)) {
      if (part?.type !== "tool" || String(part?.tool ?? part?.name ?? "") !== "goal_verdict") continue
      const raw = part.state?.input
      try {
        const input = typeof raw === "string" ? JSON.parse(raw) : raw
        const verdicts = Array.isArray(input?.verdicts) ? input.verdicts : []
        const usable = verdicts.filter((v: any) => v && ids.has(String(v.id)) && ["proven", "not_proven", "contradicted"].includes(String(v.verdict)))
        if (usable.length) return usable as VerifierVerdict[]
      } catch { /* an unparseable call is not a verdict */ }
    }
  }
  return []
}

export function verifierCause(messages: unknown[], allowedRoots: readonly string[]): string | undefined {
  const canon = (p: string) => p.replace(/^\/private(?=\/(?:var|tmp)\/)/, "")
  const inside = (p: string) => allowedRoots.some((root) => { const rel = relative(canon(root), canon(p)); return rel === "" || !rel.startsWith("..") && !rel.startsWith("/") })
  const paths: string[] = []
  for (const message of messages ?? []) {
    for (const part of messageParts(message)) {
      if (part?.type !== "tool") continue
      // Only a tool RESULT that says the permission was rejected is a denial.
      // Reading a file whose text mentions external_directory is not. Read the
      // same fields the transcript builder stores (content/error/output) and
      // serialise them the same way — on newer OpenCode the denial is an object
      // in state.error, so String() gave "[object Object]" and the cause was
      // reported as unknown.
      const output = JSON.stringify(part.state?.content ?? part.state?.error ?? part.state?.output ?? "")
      if (!/permission\.rejected|Permission denied/i.test(output) || !/external_directory/i.test(output)) continue
      const raw = part.state?.input
      const asked = /"(?:path|filePath|directory|pattern)"\s*:\s*"([^"]+)"/.exec(typeof raw === "string" ? raw : JSON.stringify(raw ?? {}))?.[1]
      if (asked && !inside(asked) && !paths.includes(asked)) paths.push(asked)
    }
  }
  if (!paths.length) return undefined
  return `denied external_directory access to ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ""}; add the folder to verification.read in the contract or cite evidence inside the project`
}

function compactTranscript(messages: unknown[]): unknown[] {
  return messages.map((m) => {
    const message = m as { type?: string; role?: string; parts?: any[]; content?: any }
    const parts = messageParts(message)
    return {
      type: message.type,
      role: message.role,
      parts: parts.map((p) => ({
        type: p?.type,
        ...(p?.text !== undefined ? { text: String(p.text).slice(0, 4000) } : {}),
        ...(p?.tool !== undefined ? { tool: String(p.tool) } : p?.type === "tool" && p?.name !== undefined ? { tool: String(p.name) } : {}),
        ...(p?.state !== undefined ? typeof p.state === "object" && p.state
          // Keep what a reader needs to see why a round stalled: the call,
          // its status and a bounded slice of its output or error.
          ? { state: String(p.state.status ?? "unknown"), input: JSON.stringify(p.state.input ?? null).slice(0, 2000), output: JSON.stringify(p.state.content ?? p.state.error ?? p.state.output ?? null).slice(0, 2000) }
          : { state: String(p.state) } : {}),
      })),
    }
  })
}

/**
 * T044: an exchange is empty when the child's turn ended without any
 * assistant text or tool call after the last user message — the silent
 * GLM/zai failure mode observed on the main host (four rounds, no parts,
 * no tools, no text). Empty exchanges are retried once and always recorded.
 */
function exchangeEmpty(messages: unknown[]): boolean {
  let lastUser = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; type?: string }
    if (m?.role === "user" || m?.type === "user") {
      lastUser = i
      break
    }
  }
  return !messages.slice(lastUser + 1).some((raw) => {
    const m = raw as { role?: string; type?: string; parts?: any[]; content?: any }
    if (m?.role !== "assistant" && m?.type !== "assistant") return false
    const parts = m.parts ?? (Array.isArray(m.content) ? m.content : [])
    return parts.some((p) => {
      const text = typeof p?.text === "string" ? p.text.trim() : ""
      const toolish = p?.tool !== undefined || p?.call !== undefined || p?.toolCallId !== undefined
      return Boolean(text) || toolish
    })
  })
}

/**
 * T016 fallback: when the verifier child ends without calling goal_verdict,
 * accept a fenced ```json block from its final assistant message as the
 * verdict. Same shape and normalization as the tool handler; recorded
 * distinctly as by:"verifier-fallback" so the audit trail never lies about
 * how the verdict arrived. Guards: only assistant messages (the prompt itself
 * demonstrates a fenced example), and at least one verdict id must belong to
 * the criteria this round asked about.
 */
function parseFallbackVerdicts(messages: unknown[], ids: Set<string>): VerifierVerdict[] {
  const valid = new Set(["proven", "not_proven", "contradicted"])
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { type?: string; role?: string; parts?: any[]; content?: any }
    if (message?.type !== "assistant" && message?.role !== "assistant") continue
    const parts = message.parts ?? (Array.isArray(message.content) ? message.content : [])
    const body = parts.map((p) => String(p?.text ?? "")).join("\n")
    if (body.includes("independent completion verifier")) continue // our own prompt's example fence
    const fence = [...body.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!)
    for (const block of fence.reverse()) {
      try {
        const parsed = JSON.parse(block)
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.verdicts) ? parsed.verdicts : []
        const verdicts = list
          .filter((v: any) => v && typeof v.id === "string" && valid.has(v.verdict) && ids.has(String(v.id).toUpperCase()))
          .map((v: any) => ({
            id: String(v.id).toUpperCase(),
            verdict: v.verdict as VerifierVerdict["verdict"],
            ...(v.reason ? { reason: String(v.reason) } : {}),
            evidence: Array.isArray(v.evidence) ? v.evidence.filter((e: any) => e?.path && e?.quote).map((e: any) => ({ path: String(e.path), quote: String(e.quote) })) : [],
          }))
        if (verdicts.length) return verdicts
      } catch {
        // not json; try the next fence
      }
    }
  }
  return []
}

/** One-line summary of a ledger event for the dashboard's Timeline section. */
function timelineText(e: Record<string, unknown>): string {
  const str = (v: unknown, max = 70) => String(v ?? "").slice(0, max)
  switch (e.type) {
    case "start":
      return `run started via ${str(e.source, 20)}`
    case "admit":
      return `turn ${e.turn} admitted (${str(e.kind, 30)})`
    case "admit-failed":
      return `turn ${e.turn} admission failed: ${str(e.error)}`
    case "claim":
      return `completion claimed at turn ${e.turn}`
    case "verdict":
      return `verdict ${e.passed ? "passed" : "failed"}${Array.isArray(e.lines) && e.lines[0] ? ` — ${str(e.lines[0], 90)}` : ""}`
    case "complete":
      return "goal complete"
    case "paused":
      return `paused: ${str(e.reason, 60)}`
    case "resumed":
      return `resumed (${str(e.by, 40)})`
    case "waiting":
      return `waiting ${e.seconds ? `${e.seconds}s` : ""}: ${str(e.reason, 50)}`
    case "blocked":
      return `blocked: ${str(e.reason, 60)}`
    case "steer":
      return `owner steered: ${str(e.text, 60)}`
    case "attached":
      return `goal attached to another session by the owner (from ${str(e.from, 24)})`
    case "verifier-model":
      return `verifier model resolved: ${str(e.model, 40)}`
    case "verifier-empty":
      return `verifier round ${str(e.round, 4)} was empty — retrying`
    case "verifier-fallback":
      return `verifier answered in prose; ${str(e.count, 4)} verdict(s) parsed from it`
    default: {
      const extra = e.reason ?? e.error ?? e.note ?? e.text ?? ""
      return `${str(e.type, 24)}${extra ? `: ${str(extra, 60)}` : ""}`
    }
  }
}

/** Build a user message for the context hook from the host's own Message class. */
function makeUserMessage(messages: any[], text: string): any {
  const sample = messages.find((m) => m?.role === "user") ?? messages[0]
  const Ctor = sample?.constructor
  if (Ctor && typeof Ctor.user === "function") return Ctor.user(text)
  return { role: "user", content: [{ type: "text", text }] }
}

function targetPaths(tool: string, input: any): string[] {
  if (!input || typeof input !== "object") return []
  if ((tool === "edit" || tool === "write") && typeof input.path === "string") return [input.path]
  if (tool === "patch" && typeof input.patchText === "string") return [...input.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim())
  if ((tool === "shell" || tool === "bash" || tool === "execute") && typeof input.command === "string") return shellWriteTargets(input.command)
  return []
}

/** T108: a shell command or script is another reachable write path into a live
 * goal folder. Reads must stay allowed, so only a write-shaped use of the path
 * counts: redirection, tee, in-place edit, move/copy/remove, a truncating
 * descriptor, or an inline interpreter that writes it. */
export function shellWriteTargets(command: string): string[] {
  const goals = /(?:\.opencode\/goals\/|\/\.opencode\/goals\/)/g
  const found = new Set<string>()
  for (const match of command.matchAll(goals)) {
    const at = match.index! + match[0].length
    const rest = command.slice(at)
    const path = /\.opencode\/goals\/([^\s'";|&)>]+)/.exec(match[0] + rest)
    const relative = path ? `.opencode/goals/${path[1]}` : undefined
    if (!relative) continue
    const escaped = relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const writeish = [
      new RegExp(`>>?\\s*['\"]?${escaped}`), // > path, >> path
      new RegExp(`\\btee\\b[^|;&]*${escaped}`), // tee path
      new RegExp(`\\bsed\\b[^|;&]*-i[^|;&]*${escaped}`), // sed -i path
      new RegExp(`\\b(?:mv|cp|install|rm|truncate|touch|chmod|chown|ln|dd)\\b[^|;&]*${escaped}`), // move/remove/replace
      new RegExp(`[|>]\\s*['\"]?${escaped}`),
      new RegExp(`\\b(?:python3?|node|bun|deno|ruby|perl|php)\\b[\s\S]*${escaped}[\s\S]*?(?:\\.write\\(|open\\([^)]*['\"][wa]|writeFile|appendFile|createWriteStream|>>?)`),
      new RegExp(`\\b(?:python3?|node|bun|deno|ruby|perl|php)\\b[\s\S]*?(?:\\.write\\(|open\\([^)]*['\"][wa]|writeFile|appendFile|createWriteStream)[\s\S]*${escaped}`),
      // open('<path>', 'w') and friends put the write beside the path itself.
      // A bare open('<path>') is a READ; only a write call or an explicit
      // write mode counts (the sibling pattern below covers the mode).
      new RegExp(`(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|truncate)\\(\\s*['\"]${escaped}['\"]`),
      new RegExp(`['\"]${escaped}['\"]\\s*,\\s*['\"][wa]`),
      new RegExp(`\\b(?:python3?|node|bun|deno|ruby|perl|php)\\b[\s\S]*?(?:writeFile|appendFile|createWriteStream|truncate|unlink|rename|copyFile)`),
    ].some((pattern) => pattern.test(command))
    if (writeish) found.add(relative)
  }
  return [...found]
}

function globMatch(file: string, glob: string): boolean {
  let re = ""
  const g = glob.replace(/^\.\//, "")
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += g[i + 2] === "/" ? "(?:.*/)?" : ".*"
        i += g[i + 2] === "/" ? 2 : 1
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`).test(file)
}

export type { Status }
