// T054 — actionable message content. Owner directive: "treat users like
// they need everything spelled out — actionable, option-based." Every
// engine notice carries the CAUSE plus CONCRETE CHOICES: what to run, what
// to approve, what to read. This module owns the wording of every notice
// the engine emits; app.ts renders nothing raw. The choices render inline
// (a plain toast stays actionable) and ride the rpc payload as structured
// choices the T050 dialogs wire to rpc.act.
export type Choice = {
  /** short imperative label for a dialog button, e.g. "Resume goal" */
  label: string
  /** the owner command or worker action to run, e.g. "/goal resume" */
  run: string
  /** rpc.act action for dialog wiring (optional; commands run as commands) */
  act?: string
  arg?: string
}

export type EngineMessage = {
  id: string
  text: string
  choices: Choice[]
  level: "info" | "success" | "warning" | "error"
  attention?: "done" | "question" | "error"
}

const msg = (id: string, level: EngineMessage["level"], text: string, choices: Choice[], attention?: EngineMessage["attention"]): EngineMessage => ({
  id,
  level,
  text,
  choices,
  ...(attention ? { attention } : {}),
})

/** Inline rendering: cause + explicit choices, one line, toast-safe. */
export function renderMessage(m: EngineMessage): string {
  return `${m.text} — ${m.choices.map((c) => c.run).join(" · ")}`
}

const resume = { label: "Resume goal", run: "/goal resume", act: "resume" }
const abort = { label: "Abort goal", run: "/goal abort", act: "abort" }
const status = { label: "Show status", run: "/goal status" }
const verify = { label: "Verify now", run: "/goal verify", act: "verify" }
const archive = { label: "Archive goal", run: "/goal archive", act: "archive" }

export const M = {
  managerOperation: (action: string, title: string) => msg("goal.manager.operation", "warning", `${action.toUpperCase()} the selected goal "${title}"? This applies only to the reviewed run and contract. History stays intact; no operation executes until you choose.`, [
    { label: `${action[0]!.toUpperCase()}${action.slice(1)} selected goal`, run: `answer with this option to ${action} the exact reviewed goal; preserve its history`, act: action },
    { label: "Cancel operation", run: "keep the selected goal unchanged" },
    { label: "Comment instead", run: "reply with commentary; no operation is authorized" },
  ]),
  ownerOperationFailed: (reason: string) => msg("goal.owner-operation.failed", "warning", `The selected owner operation did not succeed: ${reason}. No successful resolution was recorded.`, [{ label: "Inspect current status", run: "goal_status before requesting the exact review again" }, { label: "Restore pending review", run: "goal_review for a pending unchanged target" }]),
  amendmentExpired: () => msg("goal.amend.expired", "warning", "The amendment review expired; the locked contract and evidence are unchanged.", [{ label: "Stage a fresh diff", run: "goal_propose_amendment with the current target lock" }]),
  amendmentChanged: () => msg("goal.amend.changed", "warning", "The goal/run/contract changed after amendment review; no amendment was applied.", [{ label: "Read and stage again", run: "read the selected goal and stage a new reviewed diff" }]),
  amendmentInterrupted: () => msg("goal.amend.interrupted", "error", "The amendment commit was interrupted after recorded acceptance; no further work is safe until recovery finishes.", [{ label: "Recover the accepted generation", run: "open a reloaded location to recover the host write-ahead receipt" }]),
  launchExpired: () => msg("goal.launch.expired", "warning", "The launch review expired; nothing started. A fresh review is needed before consent can be used.", [{ label: "Review again", run: "start a new native launch review" }]),
  launchChanged: () => msg("goal.launch.changed", "warning", "The contract changed after review; nothing started. The previous choice cannot approve different bytes.", [{ label: "Review the new contract", run: "read the revised contract and start a new native review" }]),
  launchOutcome: (slug: string, outcome: string, result: string) =>
    msg("goal.launch.outcome", outcome === "succeeded" ? "success" : "warning", `Launch ${slug} (${outcome}): ${result}`, [status, { label: "Inspect the exact review", run: "goal_review; no old approval is replayed" }]),
  launchActivity: (slug: string, detail: string) =>
    msg("goal.launch.activity", "info", `${slug}: ${detail}`, [status]),
  launchFailed: (reason: string) => msg("goal.launch.failed", "error", `Launch failed; the decision has an explicit recoverable result: ${reason}`, [{ label: "Inspect and review again", run: "read the failed launch result and start a new native review" }]),
  goalStarted: (title: string) =>
    msg("goal.started", "success", `Goal started: ${title}. The contract is locked and rendered into every request.`, [status, resume]),
  cleanStarted: (targetID: string, slug: string) =>
    msg("goal.clean-start", "success", `Started clean: the kickoff prompt landed in the new session "${targetID}" (goal kickoff · ${slug}). This session stays untouched — nothing was cleared.`, [
      { label: `Open the goal session`, run: `open the session "goal kickoff · ${slug}"` },
      status,
    ]),
  startPicker: (goals: Array<{ slug: string; title: string; valid: boolean }>) =>
    msg("goal.start-picker", "info", `Start which goal? ${goals.length} startable in this project:`, goals.map((g) => ({
      label: `${g.slug} — ${g.title}`,
      run: `/goal start ${g.slug}`,
      act: "start",
      arg: g.slug,
    }))),
  startPickerEmpty: (folders: number) =>
    msg("goal.start-picker.empty", "warning", `No startable goal here (${folders} goal folder${folders === 1 ? "" : "s"} exist${folders ? ", none fresh" : ""}). Write one first.`, [
      { label: "Write a goal", run: "/goal new <what you want done>" },
    ]),
  goalSummary: (headline: string, caveats: number, status2: string) =>
    msg(`goal.summary.${status2}`, status2 === "complete" ? "success" : "warning", `goal.summary — ${headline}${caveats ? ` (${caveats} caveat${caveats > 1 ? "s" : ""}: provenance and unproven scope flagged in the dialog/evidence)` : ""}. The loop has stopped; follow-ups live in this dialog and the goal folder.`, [
      { label: "Show status", run: "/goal status" },
      ...(status2 === "complete" ? [{ label: "Archive", run: "/goal archive", act: "archive" }, { label: "Start the next goal", run: "/goal new <what you want next>" }] : [{ label: "Resolve review", run: "/goal approve <C#>" }]),
    ]),
  policyApplied: (kind: string, classes: string, summary: string, slug: string) =>
    msg("goal.policy.applied", "warning", `Agent applied an in-policy ${kind} (${classes}): ${summary}. It is journalled; the owner can undo it.`, [{ label: "Undo this change", run: `/goal revert ${slug}` }, status]),
  divergenceChanged: () => msg("goal.divergence.changed", "warning", "The divergence changed since the review; nothing applied.", [{ label: "Review again", run: "goal_recover_divergence for a fresh recovery review" }]),
  divergenceAdopted: (slug: string) => msg("goal.divergence.adopted", "success", `Adopted the disk contract of ${slug} as a new journalled generation; the goal stays paused.`, [resume, status]),
  divergenceRestored: (slug: string) => msg("goal.divergence.restored", "success", `Restored the locked contract of ${slug}; the divergent bytes are kept as evidence. The goal stays paused.`, [resume, status]),
  stallReported: (turns: number) =>
    msg("goal.stall.reported", "warning", `No visible change for ${turns} turns, but the agent kept working: the run continues under the owner-set on_stall policy and this stall is recorded.`, [status, resume]),
  runStateRepaired: (slug: string, kept: string) =>
    msg("goal.runstate.repaired", "warning", `run.json for ${slug} was malformed or carried duplicate keys; it was rebuilt from the run's own ledger and evidence. The raw bytes are kept at ${kept}.`, [status, resume]),
  amended: (generation: number, summary: string) =>
    msg("goal.amended", "success", `Goal amended (generation ${generation}): ${summary}. The contract re-locked; the next turn renders the new text.`, [verify, status]),
  pausedAdmissionError: (reason: string) =>
    msg("goal.paused.admission", "error", `Goal paused: the host could not send the next turn (${reason}).`, [resume, abort], "error"),
  awaitingAnswer: (question: string) =>
    msg("goal.awaiting-answer", "warning", `The goal is waiting for your answer: ${question}. The loop is idle until you reply.`, [
      { label: "Answer in the session", run: "reply in the session" },
      abort,
    ], "question"),
  pausedUserMessage: () =>
    msg("goal.paused.user-message", "info", `Goal paused because you sent a message — reply to steer the run, or resume to hand control back.`, [
      { label: "Resume goal", run: "/goal resume", act: "resume" },
      { label: "Keep steering", run: "keep replying in the session" },
      abort,
    ]),
  budgetStopped: (title: string) =>
    msg("goal.budget.stopped", "warning", `Goal stopped at its budget: ${title}. Raise the budget to continue, or wrap up.`, [
      { label: "Raise budget (amend)", run: "reply in the Composer with the budget change; the agent stages a reviewed amendment" },
      abort,
      archive,
    ], "question"),
  blocked: (key: string, reason: string, needs?: string) =>
    msg("goal.blocked", "warning", `Goal blocked on ${key}: ${reason}${needs ? ` — it needs: ${needs}` : " — only the owner can resolve this"}.`, [
      { label: "Resolve, then resume", run: "/goal resume", act: "resume" },
      { label: "Flag the criterion (worker)", run: "goal_flag it as contradictory/impossible/unsafe" },
      abort,
    ], "question"),
  pausedInterrupted: (why: string) =>
    msg("goal.paused.interrupted", "error", `Goal paused — ${why}.`, [
      { label: "Resume goal", run: "/goal resume", act: "resume" },
      { label: "Keep steering", run: "keep replying in the session" },
      abort,
    ], "error"),
  // T111: the stall notice names the owner-set autonomy.on_stall option and the
  // owner's choices, so a stalled run points at /goal resume and at the policy
  // that would have auto-continued a genuinely working run.
  pausedStalled: (why: string, onStall: "pause" | "continue" = "pause") =>
    msg("goal.paused.stalled", "info", `Goal paused — ${why}. Your autonomy.on_stall is "${onStall}". Choices: /goal resume to continue, /goal abort to stop, or set autonomy.on_stall: continue in goal.yaml so a stalled-but-active run keeps going with a recorded report.`, [resume, abort]),
  verifying: () => msg("goal.verifying", "info", `Verifying the goal: host checks run first, then the independent verifier child. Nothing to do until goal.summary lands.`, [{ label: "Show status", run: "/goal status" }]),
  complete: (title: string, caveats: number) =>
    msg("goal.complete", "success", `Goal complete: ${title}.${caveats ? ` ${caveats} caveat${caveats > 1 ? "s" : ""} in the summary (provenance/unproven scope).` : ""} Every required criterion was verified. The loop has stopped — nothing further runs on its own; follow-ups live in the summary dialog and the goal folder.`, [
      { label: "Archive goal", run: "/goal archive", act: "archive" },
      { label: "Start the next goal", run: "/goal new <what you want next>" },
    ], "done"),
  needsSignOff: (ids: string[]) =>
    msg("goal.needs-review.signoff", "warning", `Goal needs your sign-off on ${ids.join(", ")} — a human criterion only you can prove. Approve runs verification of everything else immediately (your approval is final and never re-checked).`, [
      { label: `Approve ${ids[0] ?? "<id>"} (triggers verify)`, run: `/goal approve ${ids[0] ?? "<id>"}`, act: "approve", arg: ids[0] },
      { label: "Reject with a reason", run: `/goal reject ${ids[0] ?? "<id>"} <why>`, act: "reject", arg: ids[0] },
      status,
    ], "question"),
  needsReview: (reason: string, ids: string[] = []) =>
    msg("goal.needs-review.rejected", "warning", `Goal needs review: ${reason}. A criterion failed verification repeatedly — decide it, change the work, or change the check. Approving runs verification of everything else immediately (final, never re-checked).`, [
      ...ids.map((id) => ({ label: `Approve ${id} (final, triggers verify)`, run: `/goal approve ${id}`, act: "approve", arg: id })),
      ...(ids.length ? [] : [{ label: "Inspect the failed criteria", run: "/goal status" }]),
      { label: "Amend the check", run: "start a Composer interview for the check change; no contract changes before reviewed acceptance", act: "amend", arg: "interview" },
      abort,
    ], "question"),
  claimRejected: (firstLine: string) =>
    msg("goal.claim.rejected", "warning", `Claim rejected by the host — the verdict goes back to the agent: ${firstLine}`, [
      { label: "Agent: fix and re-claim", run: "read the HOST VERDICT lines, fix the work, then goal_claim again" },
      { label: "Owner: verify again", run: "/goal verify", act: "verify" },
    ]),
  attached: (title: string, status2: string) =>
    msg("goal.attached", "success", `Goal attached here: ${title} (${status2}). Every /goal command and palette action now acts on it from this session.`, [
      { label: "Resume goal", run: "/goal resume", act: "resume" },
      status,
    ]),
  archived: (title: string, slug: string) =>
    msg("goal.archived", "success", `Goal archived: ${title} (history intact under .opencode/goals-archive/${slug}/; the registry still answers "was this ever a goal here?").`, [
      { label: "Start the next goal", run: "/goal new <what you want next>" },
      { label: "List everything", run: "/goal list all" },
    ]),
  goalWait: (seconds: number, reason: string) =>
    msg("goal.waiting", "info", `Goal waiting ${seconds}s: ${reason}. The loop resumes itself; the tracer counts down.`, [
      { label: "Show status", run: "/goal status" },
      { label: "Owner: keep steering", run: "reply in the session (it pauses the wait)" },
    ]),
  commandDeferred: (sub: string, held: "turn" | "form") =>
    msg("goal.command.deferred", "info", `/goal ${sub} acknowledged — queued behind the active ${held}; it runs the moment it ends. Nothing is lost, nothing runs early.`, [
      { label: "Show status", run: "/goal status" },
      { label: "Act now anyway", run: "/goal pause or /goal abort run immediately" },
    ]),
  amendProposed: (summary: string) =>
    msg("goal.amend.proposed", "warning", `Amendment proposed: ${summary}. Review the diff; confirming re-locks the contract with a new generation.`, [
      { label: "Confirm re-lock", run: "/goal amend confirm", act: "amend", arg: "confirm" },
      { label: "Revise the proposal", run: "reply in the Composer with your changes; the agent stages a revised diff" },
    ], "question"),
  supersedeAck: (slug: string, predecessor: string, status: string) =>
    msg("goal.supersede.ack", "warning", `Refused to start "${slug}": predecessor "${predecessor}" is still ${status}. Superseding a live predecessor forks the audit trail.`, [
      { label: "Acknowledge and supersede", run: `/goal start ${slug} acknowledge-supersede` },
      { label: "Abort predecessor first", run: "/goal abort", act: "abort" },
    ], "question"),
  pausedAfterVerdict: (firstLine: string) =>
    msg("goal.paused.verdict", "warning", `Verification did not pass while the goal is stopped — ${firstLine} Decide with the verdict in hand.`, [
      resume,
      { label: "Amend the check", run: "start a Composer interview for the check change; no contract changes before reviewed acceptance", act: "amend", arg: "interview" },
      abort,
    ], "question"),
  completeDecision: (title: string, cleoPresent: boolean, unproven: number) =>
    msg("goal.complete.decision", "success", `Goal complete: ${title}.${unproven ? ` ${unproven} discussed-but-unproven item(s) are flagged in the summary.` : ""} The loop has stopped. What next?`, [
      { label: "Start the next goal", run: "start the write-goal interview for the next goal", act: "start-next" },
      // T070: "Decompose with CLEO" was a dead-end guidance row — it is a
      // real act now, dispatching the decomposition prompt into the session.
      ...(cleoPresent
        ? [{ label: "Decompose with CLEO", run: "file the follow-ups as CLEO tasks in this session", act: "decompose" }]
        : []),
      archive,
      // guidance rows carry no act — the TUI renders them as visible rows
      // instead of dropping them (T067: "why was I only offered Archive?");
      // with CLEO linked, Decompose is act-able, so only the install case
      // stays guidance
      ...(cleoPresent ? [] : [{ label: "Install CLEO for tracking", run: "install CLEO — no .cleo workspace in this project yet" }]),
    ], "done"),
}

/** Every engine notice comes from M — the unit suite pins none is actionless. */
export const MESSAGE_BUILDERS = Object.keys(M)
