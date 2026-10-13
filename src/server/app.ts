// The goal engine: owns run state for this location, drives continuations from
// session.execution.* events, injects the contract into every request, and runs
// verification. Spike findings referenced as S1-S9 live in docs/spikes.md.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
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
import { AmendmentStore, amendmentChoices, type AmendmentRequest } from "../engine/amendments"
import { selectedReviewChoice, reviewExpired } from "../engine/owner-reviews"
import { DecisionStore, decisionChoices, type DecisionKind, type DecisionRequest, type DecisionTarget } from "../engine/decisions"
import { projectInventory } from "../engine/inventory"
import { admissionNote } from "../engine/similarity"
import { goalHelp } from "./help"
import { cleoFacts, cleoLinkEvent, type Runner } from "../engine/cleo-link"
import { buildPostGoalSummary } from "../summary/build"
import { completionAudit } from "../summary/audit"
import { M, renderMessage, type EngineMessage } from "./messages"
import { directGoalCommand } from "./intent"
import { ownerAmendmentMessage, ownerResumeMessage } from "../engine/owner-intent"

/** Spawn the cleo CLI with a hard timeout; all failures resolve safely. */
const defaultRunner: Runner = (command, args, timeoutMs = 2500) =>
  new Promise((resolve) => {
    const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "ignore" })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    Promise.all([new Response(child.stdout).text(), child.exited])
      .then(([stdout, exit]) => resolve({ stdout, exit: Number(exit) }))
      .catch(() => resolve({ stdout: "", exit: 1 }))
      .finally(() => clearTimeout(timer))
  })
import { ascendingId, runId as newRunId } from "../util/ids"
import { fingerprint, headCommit } from "../util/git"
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
    }, 0)
  }

  async stop() {
    this.disposed = true
    this.controller.abort()
    clearTimeout(this.launchRecoveryTimer)
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    for (const r of this.registrations.splice(0)) await Promise.resolve(r.dispose()).catch(() => {})
  }

  /** Running goals from a previous process come back paused (never resumed blindly). */
  private recover() {
    for (const slug of this.store.slugs()) {
      const state = this.store.readRun(slug)
      if (!state) continue
      if (isActive(state.status)) {
        setStatus(state, "paused", "host restarted; resume when ready")
        this.store.ledger(slug, { type: "recovered", status: "paused" })
        this.store.writeRun(state)
      }
      // T072: EVERY goal on disk — terminal ones included — is mirrored in
      // memory. A re-attaching TUI's snapshot then reads the disk truth
      // (complete/N) instead of nothing, so a server reload can never strand
      // the sidebar card at its last pre-restart view.
      this.runs.set(state.sessionID, state)
    }
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
  private async summarize(state: RunState, contract: Contract) {
    try {
      const summary = buildPostGoalSummary({
        contract,
        state,
        ledgerEvents: this.store.recent(state.slug, 200) as unknown as Array<Record<string, unknown>>,
        cleo: await cleoFacts(this.root, defaultRunner),
        scopeAudit: completionAudit(contract, state),
      })
      const file = this.store.evidence(state.slug, state.runId, `summary-turn-${state.turn}-${Date.now()}`, summary)
      this.store.ledger(state.slug, { type: "summary", turn: state.turn, status: state.status, headline: summary.headline, file })
      void this.rpc?.events.emit("summary", { sessionID: state.sessionID, slug: state.slug, status: state.status, headline: summary.headline, text: summary.text }).catch(() => {})
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
  private reaskDecisionForm(sessionID: string) {
    const pending = this.pendingDecisions.get(sessionID)
    if (!pending || this.pendingFormDecisions.has(sessionID)) return
    if (this.factsOf(sessionID).forms.size > 0) return
    const request = this.decisions.get(pending.id)
    // A dismissal/comment is an unresolved review, not permission to trap
    // the owner in an immediately re-opening form. Reload or goal_review
    // explicitly restores it; ordinary execution events do not.
    if (request?.status === "interrupted") return
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

  private async resolveLaunch(request: LaunchRequest, answer: Record<string, unknown>) {
    request = this.launches.get(request.id) ?? request
    if (request.status !== "pending") return // replay, including during execution
    if (request.issuerPID !== process.pid && processAlive(request.issuerPID)) return // another live session server owns it
    const value = request.fieldKey ? answer[request.fieldKey] : undefined
    const selected = selectedReviewChoice(request, launchChoices, answer)
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
    return this.amendmentReviews.all(sessionID).some((p) => p.status === "pending" && !reviewExpired(p) && p.question === q[0].question && q[0].options.length === amendmentChoices.length && amendmentChoices.every((c) => q[0].options.some((o: any) => o.label === c.label)))
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
      if (reviewExpired(p)) { this.decisions.update(p.id, { status: "expired", result: "Decision review expired; inspect status before a new review." }); continue }
      const current = this.decisionTarget(p.slug)
      if (current.lock !== p.target.lock || current.runId !== p.target.runId || current.sessionID !== p.target.sessionID) { this.decisions.update(p.id, { status: "failed", result: "Goal generation/session changed; old review invalidated." }); continue }
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
    if (request.status === "expired") {
      this.decide(sessionID, request.slug, request.kind, request.message, request.extra)
      return "Expired review replaced by a new exact native review. No operation was authorized or executed."
    }
    if (request.status === "pending" && request.formID) return "The exact review is already present in the native composer. No operation was authorized or executed."
    this.decisions.reopenForm(request.id)
    this.pendingFormDecisions.delete(sessionID)
    this.publishDecision(request)
    await this.askDecisionForm(sessionID, request.slug, request.kind, request.id, request.message)
    return "The same pending decision has been re-presented natively. No choice, approval, rejection or operation was inferred."
  }

  private async proposeAmendment(sessionID: string, input: { slug: string; expectedLock: string; yaml: string; rationale: string }) {
    const proposal = await this.serial(() => {
      const state = [...this.runs.values()].find((s) => s.slug === input.slug)
      if (!state) throw new Error("No live run for the selected goal")
      const unavailable = ownerCan(state, "amend")
      if (unavailable) throw new Error(unavailable)
      if (this.amendmentReviews.all().some((p) => p.slug === state.slug && p.status === "executing")) throw new Error("An owner-accepted amendment is committing; recover it before another proposal")
      if (state.lock !== input.expectedLock) throw new Error("Amendment targets a stale lock; re-read the selected goal")
      if (state.status === "verifying") throw new Error("The selected goal is verifying; wait for its verdict before proposing a generation")
      if (state.sessionID !== sessionID && this.factsOf(state.sessionID).busy) throw new Error("The selected goal is executing elsewhere; pause it before proposing an amendment")
      const disk = this.store.readContract(state.slug)
      if (!disk?.contract || disk.lock !== state.lock) throw new Error("Disk contract differs from the locked goal; resolve the existing edit before staging")
      const next = parseContract(input.yaml, { slug: state.slug })
      if (!next.contract) throw new Error(`Invalid amendment; current contract unchanged:\n${formatIssues(next.issues)}`)
      if (next.lock === state.lock) throw new Error("Nothing changed; no amendment staged")
      const diff = amendmentDiff(disk.contract, next.contract)
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
      this.store.ledger(state.slug, { type: "amendment-staged", decisionId: p.id, sessionID, runId: p.runId, lock: p.lock, nextLock: p.nextLock, summary: diff.summary })
      return p
    })
    await this.presentAmendment(proposal)
    return { decisionId: proposal.id, slug: proposal.slug, runId: proposal.runId, lock: proposal.lock, nextLock: proposal.nextLock, diff: proposal.diff, status: "pending", message: "Validated amendment staged without changing goal.yaml. Show the exact diff in the Composer; resolve the owner's actual chat with goal_resolve_amendment or the native review. No sidebar Accept or manual command is required; acceptance alone does not resume." }
  }

  private async presentAmendment(request: AmendmentRequest) {
    const nativeForm = (this.ctx.session as any).form
    if (typeof nativeForm?.create === "function") {
      const form = await nativeForm.create({ sessionID: request.sessionID, title: `Amend ${request.slug}?`, metadata: { goalDecisionID: request.id }, fields: [{ key: "action", title: request.question, type: "string", custom: true, options: amendmentChoices }] })
      this.amendmentReviews.bind(form)
    } else {
      const payload = { questions: [{ header: "Goal", question: request.question, options: amendmentChoices.map((c) => ({ label: c.label, description: c.description })) }] }
      await this.ctx.session.prompt({ sessionID: request.sessionID, text: `Ask the owner with the question tool using this exact JSON. The host alone applies the selected amendment; do not edit goal.yaml or call an owner action afterwards.\nGOAL_FORM_JSON:${JSON.stringify(payload)}`, resume: true, metadata: { goal: { kind: "amendment-review", decisionId: request.id } } } as any)
    }
  }

  private async reviewAmendment(sessionID: string, request: AmendmentRequest) {
    if (request.sessionID !== sessionID) throw new Error("That amendment review belongs to another authoring session; nothing was reused.")
    if (request.issuerPID !== process.pid && processAlive(request.issuerPID)) throw new Error("Another live server owns this amendment review; inspect it there.")
    if (!["pending", "interrupted", "expired"].includes(request.status)) throw new Error(`Amendment review is ${request.status}; old approval cannot be replayed.`)
    const state = this.runs.get(request.targetSessionID), disk = this.store.readContract(request.slug)
    if (!state || isTerminal(state.status) || state.runId !== request.runId || state.lock !== request.lock || !disk?.contract || disk.lock !== request.lock)
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
      continuation = await this.serial(async () => {
        const selected = this.list().find((g) => g.slug === after.slug && g.runId === after.runId && g.lock === after.nextLock && g.sessionID === after.targetSessionID)
        if (!selected) return { ok: false, message: "Accepted generation changed before continuation; no other goal used." }
        const result = await this.ownerActLocked(sessionID, "resume", undefined, undefined, selected)
        this.store.ledger(after.slug, { type: "amendment-chat-continuation", decisionId: after.id, ownerMessageID: resolved.source.id, lock: after.nextLock, ok: result.ok, message: result.message })
        return result
      })
    }
    if (resolved.request.formID) await (this.ctx.session as any).form?.cancel?.({ sessionID, formID: resolved.request.formID }).catch(() => {})
    return { ok: input.action === "accept" ? after.status === "succeeded" && (!continuation || continuation.ok) : ["rejected", "commented"].includes(after.status),
      decisionId: after.id, status: after.status, ownerMessageID: resolved.source.id, message: after.result, ...(continuation ? { continuation } : {}) }
  }

  private async resolveAmendment(request: AmendmentRequest, answer: Record<string, unknown>, ownerChat?: { action: "accept" | "reject" | "comment"; text: string; messageID: string }) {
    request = this.amendmentReviews.get(request.id) ?? request
    if (request.status !== "pending" || request.issuerPID !== process.pid && processAlive(request.issuerPID)) return
    const value = ownerChat?.text ?? (request.fieldKey ? answer[request.fieldKey] : undefined)
    const selected = ownerChat ? amendmentChoices.find((c) => c.value === ownerChat.action) : selectedReviewChoice(request, amendmentChoices, answer)
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
    await this.serial(() => {
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
        this.amendmentReviews.update(request.id, { status: "succeeded", result: `Amended ${state.slug} to ${state.lock}; the goal stays paused.` })
        if (ownerChat) this.store.ledger(request.slug, { type: "amendment-chat-resolved", decisionId: request.id, ownerMessageID: ownerChat.messageID, lock: state.lock, ok: true })
        this.invalidateOldDecision(state)
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
      if (p.status !== "executing" || p.issuerPID !== process.pid && processAlive(p.issuerPID)) continue
      if (!p.commit) { this.amendmentReviews.update(p.id, { status: "failed", result: "Host interrupted before acceptance was journalled; review again." }); continue }
      // Conflicting third-generation bytes fail setup rather than admitting
      // a worker with an inconsistent approved contract/state pair.
      this.store.commitAmendment(p)
      this.amendmentReviews.update(p.id, { status: "succeeded", result: "Recovered owner-accepted amendment; goal remains paused." })
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
      const rehearsal: Array<{ id: string; pass: boolean; unrunnable: boolean; ms: number; detail: string }> = []
      this.launchActivity(options.decisionId, { phase: "rehearsal", since: Date.now(), detail: `Rehearsing ${commandChecks.length} command checks before run creation.`, completed: 0, total: commandChecks.length })
      for (const c of commandChecks) {
        const started = Date.now()
        this.launchActivity(options.decisionId, { phase: "check", since: started, detail: `Rehearsing ${c.id} (${rehearsal.length + 1}/${commandChecks.length}); no run yet.`, checkId: c.id, completed: rehearsal.length, total: commandChecks.length })
        const result = await runHostCheck(c.check, this.root, headCommit(this.root))
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
      const state = initialRun(contract, { sessionID, runId: newRunId(), lock, commit: headCommit(this.root) })
      if (options.handoff) state.handoff = options.handoff
      state.fingerprint = fingerprint(this.root)
      if (rehearsal.length) {
        this.store.evidence(slug, state.runId, "rehearsal", { at: Date.now(), results: rehearsal })
        this.store.ledger(slug, { type: "rehearsal", turn: 0, baseline: rehearsal.map((r) => ({ id: r.id, pass: r.pass })) })
      }
      this.store.evidence(slug, state.runId, "contract", { lock, text })
      await Bun.write(join(this.store.dir(slug), "evidence", state.runId, "contract.yaml"), text)
      this.runs.set(sessionID, state)
      this.store.ledger(slug, { type: "start", runId: state.runId, sessionID, source, lock, commit: state.base.commit, ...(options.decisionId ? { decisionId: options.decisionId } : {}) })
      // T027: record the CLEO project linkage when present (CLI-only; absent
      // CLEO changes nothing — no event, no field).
      const link = cleoLinkEvent(await cleoFacts(this.root, defaultRunner))
      if (link) this.store.ledger(slug, link)
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
    const note = renderTailNote(state, contract, kind as TailKind)
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

    if (kind === "wrapup") {
      setStatus(state, "budget_limited", "budget used; wrap-up turn done")
      this.store.ledger(state.slug, { type: "budget_limited" })
      this.decide(state.sessionID, state.slug, "budget_limited", M.budgetStopped(contract.title))
      await this.transcript(state.sessionID, `◎ budget used (${contract.title}). The owner decides: raise the budget in goal.yaml and amend, or abort. Do not start new work.`)
      await this.summarize(state, contract)
      return this.persist(state)
    }

    // Progress is authoritative state change, not activity (R3).
    const fp = fingerprint(this.root)
    const changed = fp !== undefined && fp !== state.fingerprint
    state.fingerprint = fp
    let progress = changed || state.turnFacts.stepsChanged
    if (changed && this.options.liveChecks) progress = (await this.liveChecks(state, contract)) || progress
    state.counters.noProgress = progress ? 0 : state.counters.noProgress + 1
    this.store.ledger(state.slug, { type: "turn", turn: state.turn, kind, tools: state.turnFacts.tools, changed, progress, noProgress: state.counters.noProgress })
    state.turnFacts = { tools: 0, goalCalls: 0, stepsChanged: false }

    if (state.blocker && state.blocker.count >= this.options.blockerRepeats) {
      setStatus(state, "blocked", `${state.blocker.key}: ${state.blocker.reason}`)
      this.store.ledger(state.slug, { type: "blocked", blocker: state.blocker })
      this.decide(state.sessionID, state.slug, "blocked", M.blocked(String(state.blocker.key), String(state.blocker.reason), state.blocker.needs), { blocker: state.blocker })
      await this.transcript(state.sessionID, `◎ blocked on ${state.blocker.key}: ${state.blocker.reason}${state.blocker.needs ? ` (needs ${state.blocker.needs})` : ""}. Only the owner can resolve this; stop working around it and wait.`)
      return this.persist(state)
    }

    const use = budgetUse(state, contract)
    const backstop = !contract.budget.turns && state.turn >= this.options.backstopTurns
    if (use.ratio >= 1 || backstop) {
      if (!state.wrapup) {
        state.wrapup = true
        this.store.ledger(state.slug, { type: "wrapup", ratio: use.ratio, backstop })
        return this.admit(state, "wrapup")
      }
      setStatus(state, "budget_limited", backstop ? `backstop of ${this.options.backstopTurns} turns reached` : "budget used")
      this.decide(state.sessionID, state.slug, "budget_limited", M.budgetStopped(contract.title))
      await this.transcript(state.sessionID, `◎ budget used (${contract.title}). The owner decides: raise the budget in goal.yaml and amend, or abort. Do not start new work.`)
      await this.summarize(state, contract)
      return this.persist(state)
    }

    if (state.counters.noProgress >= this.options.stallTurns) {
      setStatus(state, "paused", `stalled: no change the host could see for ${state.counters.noProgress} turns`)
      this.store.ledger(state.slug, { type: "paused", reason: state.reason })
      this.noticeM(state.sessionID, M.pausedStalled(state.reason ?? "stalled"))
      return this.persist(state)
    }

    if (state.wait && state.wait.until > Date.now()) {
      setStatus(state, "waiting", state.wait.reason)
      state.activity = { kind: "waiting", since: Date.now(), until: state.wait.until, detail: state.wait.reason }
      this.persist(state)
      return this.schedule(state, state.wait.until - Date.now(), "continue")
    }
    state.wait = undefined

    const next: PendingKind = state.counters.noProgress >= this.options.recoveryAt ? "recovery" : "continue"
    this.persist(state)
    this.schedule(state, this.options.cooldownMs, next)
  }

  /** Re-run cheap `live: true` command checks after a turn that changed files. */
  private async liveChecks(state: RunState, contract: Contract): Promise<boolean> {
    let transitioned = false
    for (const c of [...contract.criteria, ...contract.invariants]) {
      if (c.check.kind !== "command" || !c.check.live) continue
      const r = await runHostCheck({ ...c.check, runs: 1 }, this.root, state.base.commit)
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
    await this.provenance(state.sessionID)
    const checkContext = JSON.stringify({ slug: state.slug, runId: state.runId, sessionID: state.sessionID, lock: state.lock, serverPID: process.pid })
    const outcome = await verifyClaim(contract, state, {
      root: this.root,
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
      const summary = await this.summarize(state, contract)
      this.noticeM(state.sessionID, M.complete(contract.title, summary ? summary.caveats.length + summary.scopeAudit.length : 0))
      this.decide(state.sessionID, state.slug, "complete", M.completeDecision(contract.title, Boolean(await cleoFacts(this.root, defaultRunner)), summary?.scopeAudit.length ?? 0))
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
    const model = await this.resolveVerifierModel(state.sessionID)
    // T053: the tracer shows the child running while it works
    state.activity = { kind: "verifier-child", since: Date.now(), ...(model ? { detail: model.label } : {}) }
    this.persist(state)
    const child: any = await this.ctx.session.create({ parentID: state.sessionID, agent: this.options.verifierAgent, title: `goal verify · ${contract.id}`, ...(model ? { model: model.ref } : {}) } as any)
    const childID: string = child?.id ?? child?.data?.id
    this.verifierInbox.delete(childID)
    this.store.ledger(state.slug, { type: "verifier-model", turn: state.turn, model: model?.label ?? null })
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
    lines.push("Use read, glob and grep to inspect the repository. Then call goal_verdict exactly once with one entry per criterion above: verdict proven, not_proven or contradicted; a one-line reason; and for proven, evidence items with the file path (relative to the project root) and a verbatim quote of at least one full line. Do not answer in prose instead of calling the tool. If the tool is unavailable or fails, reply with ONLY a fenced json block as your final message: ```json {\"verdicts\":[{\"id\":\"C1\",\"verdict\":\"proven\",\"reason\":\"...\",\"evidence\":[{\"path\":\"relative/path\",\"quote\":\"verbatim line\"}]}]} ```")
    try {
      // T044: empty exchanges are retried once and always recorded — a silent
      // empty round is never accepted as an answer. Housekeeping (v0.3.1):
      // verifierTimeoutMs is the PER-ROUND budget (240s default — the two
      // provider hangs of the last run each burned a 120s round and were
      // retried too late); each of the two rounds gets the full budget, and
      // plugin/project config overrides it (ctx.options merge in the ctor).
      const perRoundMs = Math.max(60_000, this.options.verifierTimeoutMs)
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
        const parsed = parseFallbackVerdicts(messages, new Set(criteria.map((c) => c.id)))
        if (parsed.length) {
          verdicts = parsed
          by = "verifier-fallback"
          this.store.ledger(state.slug, { type: "verifier-fallback", turn: state.turn, count: parsed.length })
        }
      }
      const transcript = this.store.evidence(state.slug, state.runId, `verifier-transcript-turn-${state.turn}-${Date.now()}`, { childID, done: outcome, by, rounds: round, retried, model: model?.label ?? null, messages: compactTranscript(messages) })
      this.store.ledger(state.slug, { type: "verifier-transcript", turn: state.turn, by, rounds: round, retried, model: model?.label ?? null, file: transcript })
      const error = verdicts.length
        ? undefined
        : outcome === "timeout"
          ? "verifier timed out"
          : exchangeEmpty(messages)
            ? `verifier exchange was empty after ${round} round(s); recorded under evidence/ — never silent`
            : "verifier did not call goal_verdict"
      return { verdicts, by, ...(verdicts.length ? {} : { error: error! }) }
    } finally {
      this.verifierInbox.delete(childID)
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

  async ownerAct(sessionID: string, action: "pause" | "resume" | "abort" | "verify" | "approve" | "reject" | "amend" | "archive" | "attach" | "start" | "start-next" | "decompose", arg?: string, via: "form" | "dialog" = "dialog", decisionId?: string): Promise<{ ok: boolean; message: string }> {
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
      if (this.amendmentReviews.all().some((p) => p.slug === state!.slug && p.status === "executing"))
        return { ok: false, message: "An accepted amendment is committing. Reload to recover its recorded acceptance before managing this goal." }
      if (["resume", "verify", "amend", "approve", "reject"].includes(action) && this.amendmentReviews.all().some((p) => p.slug === state!.slug && ["pending", "interrupted"].includes(p.status)))
        return { ok: false, message: "This goal has an unresolved staged amendment. Resolve that exact review in Composer chat with goal_resolve_amendment before resuming or verifying; there is no sidebar Accept." }
      const contract = this.contractOf(state)
      switch (action) {
        case "pause":
          clearTimeout(this.timers.get(state.sessionID))
          setStatus(state, "paused", "paused by you")
          this.store.ledger(state.slug, { type: "paused", reason: "owner" })
          this.persist(state)
          await this.transcript(state.sessionID, `◎ owner paused the goal (${state.title}). Stand by; the owner resumes it with /goal resume.`)
          return { ok: true, message: `Goal paused: ${state.title} — /goal resume · /goal abort` }
        case "resume": {
          if (state.status === "budget_limited") return { ok: false, message: "The goal used its budget. Raise budget in goal.yaml and start a new run, or abort it." }
          state.counters = { noProgress: 0, failures: 0 }
          state.blocker = undefined
          state.wrapup = false
          setStatus(state, "running")
          state.fingerprint = fingerprint(this.root)
          this.store.ledger(state.slug, { type: "resumed", by: "owner" })
          this.persist(state)
          await this.transcript(state.sessionID, `◎ owner resumed the goal. Re-read the contract and the current repository state, then continue from the first unfinished step.`)
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
    // Evidence is owned and written by the host. Read-only requests must
    // never append to completed historical goal folders.
    if (state && !isTerminal(state.status)) this.store.evidence(state.slug, state.runId, "engine-provenance", result)
    return result
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
          if (String(agent.id) === name) continue
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
      case "decompose": {
        const result = await this.ownerAct(sessionID, sub as any, arg)
        return say(result.message, result.ok ? "success" : "error")
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
        return { ok: false, message: "Selected goal identity changed. Refresh its details before acting." }
      if (!selected.valid || selected.archived || !selected.runId)
        return { ok: false, message: "This selected goal is read-only (draft, archived or invalid); review/launch a valid draft instead." }
      const state = [...this.runs.values()].find((s) => s.slug === selected.slug && s.runId === selected.runId) ?? this.store.readRun(selected.slug)
      if (!state) return { ok: false, message: "The selected run is unavailable; no other goal was used as a fallback." }
      const unavailable = action === "attach" ? !selected.attachable ? "Only a stopped live goal can attach." : undefined : ownerCan(state, action)
      if (unavailable) return { ok: false, message: unavailable }
      if (action === "verify" && state.status === "verifying") return { ok: false, message: "The selected goal is already verifying." }
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

  private async registerHooks() {
    // A pending question holds generation. Let a genuine explicit chat reply
    // reach the agent; interruption is not acceptance and spends no consent.
    this.registrations.push(await this.ctx.session.hook("prompt", async (event: any) => {
      if (event.metadata?.goal) return
      const requests = this.amendmentReviews.all(event.sessionID).filter((p) => ["pending", "interrupted"].includes(p.status) && !reviewExpired(p))
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
            throw new Error("The goal contract and run state are owned by the owner and the host. Do not edit a live goal folder, owner consent records or archived history. Use goal_propose_amendment to stage a diff for native owner acceptance.")
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
        `Start a validated goal in this session. Only after the owner approved launching it by choosing an option labelled "${LAUNCH_LABEL}" (a "(Recommended)" suffix is fine) in a question, or ran /goal start themselves. With fresh: true the engine opens a NEW session owned by the goal and prompts the kickoff there instead ("Start clean").`,
        { properties: { slug: { type: "string", maxLength: 64 }, fresh: { type: "boolean", description: "Start clean: open a new session owned by the goal, prompt the kickoff there, leave this session untouched" } }, required: ["slug"] },
        async (args, context) => {
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
              `Launching a goal needs the owner's approval: ${detail}. Ask with the question tool with an option whose label starts with "${LAUNCH_LABEL}", or have them run /goal start ${args.slug}.`,
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
          if (String(context.agent) !== this.options.verifierAgent) throw new Error("goal_verdict is reserved for the goal verifier.")
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
function compactTranscript(messages: unknown[]): unknown[] {
  return messages.map((m) => {
    const message = m as { type?: string; role?: string; parts?: any[]; content?: any }
    const parts = message.parts ?? (Array.isArray(message.content) ? message.content : [])
    return {
      type: message.type,
      role: message.role,
      parts: parts.map((p) => ({
        type: p?.type,
        ...(p?.text !== undefined ? { text: String(p.text).slice(0, 4000) } : {}),
        ...(p?.tool !== undefined ? { tool: String(p.tool) } : {}),
        ...(p?.state !== undefined ? { state: String(p.state) } : {}),
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
  return []
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
