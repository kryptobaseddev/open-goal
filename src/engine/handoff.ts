// v0.8.0 — the launch handoff.
//
// A fresh launch used to give the new session the contract and nothing else:
// no prior run, no red baseline, no "start here". This builder turns facts the
// host ALREADY holds into a bounded document the kickoff can carry. It is
// context, not authority: it cannot approve, resume or change anything.
//
// Pure so the content is testable without a host. The adapter supplies the
// facts (prior run, repo head, rehearsal, plan) and writes the two files.

export type PriorRun = {
  slug: string
  runId: string
  lock: string
  status: string
  turn: number
  evidence: string
  summary?: string
}

export type HandoffFacts = {
  slug: string
  title: string
  fromSessionID: string
  toSessionID: string
  prior?: PriorRun
  repo: { head?: string; branch?: string; dirty?: string[] }
  baseline?: Array<{ id: string; pass: boolean }>
  nextAction?: { step: string; title: string }
  authority?: { trust: string[]; stale: string[] }
  evidence?: string[]
  now?: number
}

export type HandoffDocument = {
  schema: "opencode-goal/handoff/v1"
  generatedAt: string
  markdown: string
  data: Omit<HandoffFacts, "now">
}

/** A turn-1 digest; the full document stays on disk. */
export const HANDOFF_DIGEST_LIMIT = 8_000

export function buildHandoff(facts: HandoffFacts): HandoffDocument {
  const generatedAt = new Date(facts.now ?? Date.now()).toISOString()
  const lines: string[] = []
  lines.push(`# Handoff — ${facts.slug}`)
  lines.push(`Generated ${generatedAt} for a fresh goal session. This is context, not authority: it cannot approve a criterion, accept an amendment, resume a stopped goal or change a contract.`)
  lines.push("")
  lines.push("## Prior run")
  if (facts.prior) {
    lines.push(`- Goal: ${facts.prior.slug} (run ${facts.prior.runId}, ${facts.prior.status}, turn ${facts.prior.turn})`)
    lines.push(`- Lock: ${facts.prior.lock}`)
    lines.push(`- Evidence: ${facts.prior.evidence}`)
    if (facts.prior.summary) lines.push(`- Summary: ${facts.prior.summary}`)
  } else {
    lines.push("- No prior run in this project. This is the first goal here; start from the contract and the repo.")
  }
  lines.push("")
  lines.push("## Current state")
  lines.push(`- Session: ${facts.fromSessionID} → ${facts.toSessionID}`)
  if (facts.repo.head) lines.push(`- HEAD: ${facts.repo.head}`)
  if (facts.repo.branch) lines.push(`- Branch: ${facts.repo.branch}`)
  lines.push(`- Uncommitted: ${facts.repo.dirty?.length ? facts.repo.dirty.slice(0, 20).join(", ") : "none"}`)
  lines.push("")
  if (facts.baseline?.length) {
    lines.push("## Red baseline (measured before this run started)")
    for (const b of facts.baseline) lines.push(`- ${b.id}: ${b.pass ? "pass" : "failing (red baseline)"}`)
    lines.push("")
  }
  if (facts.nextAction) {
    lines.push("## Start here")
    lines.push(`- ${facts.nextAction.step}: ${facts.nextAction.title}`)
    lines.push("")
  }
  if (facts.authority && (facts.authority.trust.length || facts.authority.stale.length)) {
    lines.push("## Authority")
    if (facts.authority.trust.length) lines.push(`- Trust: ${facts.authority.trust.join(", ")}`)
    if (facts.authority.stale.length) lines.push(`- Stale / do not follow blindly: ${facts.authority.stale.join(", ")}`)
    lines.push("")
  }
  if (facts.evidence?.length) {
    lines.push("## Evidence")
    for (const e of facts.evidence) lines.push(`- ${e}`)
    lines.push("")
  }
  lines.push("## What this document is not")
  lines.push("- It is not a contract: only .opencode/goals/<slug>/goal.yaml is locked and verified.")
  lines.push("- It is not consent: owner decisions still need their own exact review.")
  lines.push("- If it disagrees with the contract, the contract wins and the disagreement is an owner question.")
  const markdown = lines.join("\n")
  const { now: _now, ...data } = facts
  return { schema: "opencode-goal/handoff/v1", generatedAt, markdown, data }
}

/** The bounded block a kickoff tail carries. */
export function handoffDigest(markdown: string, limit = HANDOFF_DIGEST_LIMIT): string {
  const text = markdown.trim()
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 200).trimEnd()}\n\n…(truncated; the full handoff is in this goal folder as handoff.md)`
}
