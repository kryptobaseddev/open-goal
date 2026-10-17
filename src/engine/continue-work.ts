// v0.8.0 — turning a ready CLEO item into the next goal's contract.
//
// The owner's policy is "take the next ready CLEO item without asking". The
// engine therefore has to author a contract it did not interview for. This file
// does that from facts only: the task's own title, description and acceptance
// statements. Each acceptance statement becomes one verifier criterion (the same
// evidence standard the engine already uses for semantic checks); the task is
// linked so the existing CLEO bridge can close it on evidence and reports every
// AC it cannot prove. Nothing here invents a passing command.

import type { Autonomy } from "../contract/types"
import type { Runner } from "./cleo-link"

export type CleoTask = {
  id: string
  title: string
  description: string
  acceptance: string[]
}

const parse = (stdout: string): any => {
  try { return JSON.parse(stdout) } catch { return undefined }
}

/**
 * The next ready LEAF item, from CLEO's own CLI. `cleo next` suggests by
 * priority and dependency; `cleo show --full` supplies the type and acceptance
 * text. A parent (epic/saga) is never started by itself — its acceptance is a
 * rollup, not work — so parents are reported as skipped and the next leaf is
 * tried. Any failure is "no ready work", never a guess.
 */
export type SkippedParent = { id: string; type: string; title: string }
export type ReadyCleo = { task?: CleoTask; skipped: SkippedParent[] }

export async function readyCleoTask(run: Runner, bin = "cleo"): Promise<ReadyCleo> {
  const next = await run(bin, ["next", "-n", "5"])
  if (next.exit !== 0) return { skipped: [] }
  const suggestions = parse(next.stdout)?.data?.suggestions
  if (!Array.isArray(suggestions)) return { skipped: [] }
  const skipped: SkippedParent[] = []
  for (const suggestion of suggestions) {
    const id = typeof suggestion?.id === "string" ? suggestion.id : undefined
    if (!id) continue
    const show = await run(bin, ["show", id, "--full"])
    if (show.exit !== 0) continue
    const task = parse(show.stdout)?.data?.task
    if (!task || ["done", "completed", "cancelled", "archived"].includes(String(task.status))) continue
    const type = String(task.type ?? suggestion?.type ?? "")
    if (type === "epic" || type === "saga") {
      skipped.push({ id, type, title: String(task.title ?? suggestion?.title ?? id) })
      continue
    }
    return {
      task: {
        id,
        title: String(task.title ?? suggestion?.title ?? id),
        description: String(task.description ?? ""),
        acceptance: Array.isArray(task.acceptance) ? task.acceptance.map(String).filter(Boolean) : [],
      },
      skipped,
    }
  }
  return { skipped }
}

const q = (value: string) => JSON.stringify(value)

/** A slug that does not collide with a live, archived or draft goal. */
export function continuationSlug(taskId: string, taken: ReadonlySet<string>): string {
  const base = `cleo-${taskId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  if (!taken.has(base)) return base
  for (let n = 2; n < 100; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  return `${base}-${Date.now()}`
}

/**
 * The contract for the next goal. Deliberately boring: the linked task, one
 * verifier criterion per acceptance statement (or the title when the task states
 * none), the owner's autonomy policy, and no budget (budgets stay opt-in).
 */
export function continuationContractYaml(input: {
  slug: string
  task: CleoTask
  sourceSlug: string
  autonomy: Autonomy
  now?: number
}): string {
  const { slug, task, sourceSlug, autonomy } = input
  const statements = task.acceptance.length ? task.acceptance : [task.title]
  const criteria = statements.map((statement, i) => [
    `  - id: C${i + 1}`,
    `    statement: ${q(`${task.id} acceptance ${i + 1}: ${statement}`)}`,
    `    essential: true`,
    `    check: {kind: verifier, ask: ${q(`Assess whether the work done for CLEO ${task.id} genuinely satisfies this acceptance criterion: ${statement} Quote the evidence from the repository.`)} }`,
  ].join("\n"))
  return [
    "schema: goal/v1",
    `id: ${slug}`,
    `title: ${q(task.title)}`,
    "intent:",
    `  verbatim: ${q("Take the next ready CLEO item without asking.")}`,
    `outcome: ${q(task.title)}`,
    `why: ${q(`The owner's standing policy: after a goal completes, start the next ready CLEO item (${task.id}) by itself; this goal was started from that policy and the task's own acceptance.`)}`,
    "scope:",
    `  in: []`,
    `  out: []`,
    "non_goals:",
    `  - ${q("Changing anything outside the linked CLEO task's scope")}`,
    `  - ${q("Editing this goal's contract or its evidence")}`,
    "criteria:",
    ...criteria,
    "cleo:",
    "  tasks:",
    `    - id: ${task.id}`,
    "plan:",
    `  - {id: S1, title: ${q(`Complete ${task.id} and prove its acceptance`)}}`,
    "autonomy:",
    `  questions: ${autonomy.questions}`,
    `  on_user_message: ${autonomy.on_user_message}`,
    `  on_interrupt: ${autonomy.on_interrupt}`,
    `  amend: [${autonomy.amend.join(", ")}]`,
    `  on_stall: ${autonomy.on_stall}`,
    "verification: {mode: host+verifier, max_rejections: 3}",
    "meta:",
    `  created: ${q(new Date(input.now ?? Date.now()).toISOString())}`,
    `  author: opencode-goal`,
    `  source: continue-work@0.8.0`,
    `  from: ${sourceSlug}`,
    "",
  ].join("\n")
}
