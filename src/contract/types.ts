// goal/v1: the contract a goal is executed against. Written by the owner (usually
// through the write-goal skill), locked by hash when a run starts, never edited by
// the worker agent.

export const SCHEMA = "goal/v1" as const

export type Expect = {
  exit?: number
  stdout_contains?: string
  stdout_regex?: string
}

export type CommandCheck = { kind: "command"; run: string; expect?: Expect; timeout?: number; runs?: number; live?: boolean }
export type FileCheck = { kind: "file"; path: string; exists?: boolean }
export type ContainsCheck = { kind: "contains"; path: string; text?: string; regex?: string }
export type AbsentCheck = { kind: "absent"; pattern: string; paths?: string[] }
export type DiffCheck = { kind: "diff"; paths: string[] }
export type VerifierCheck = { kind: "verifier"; ask: string }
export type HumanCheck = { kind: "human"; ask: string }

export type Check = CommandCheck | FileCheck | ContainsCheck | AbsentCheck | DiffCheck | VerifierCheck | HumanCheck
export type CheckKind = Check["kind"]

export const HOST_KINDS = ["command", "file", "contains", "absent", "diff"] as const
export const CHECK_KINDS = [...HOST_KINDS, "verifier", "human"] as const
export const isHostCheck = (check: Check): boolean => (HOST_KINDS as readonly string[]).includes(check.kind)

export type Criterion = {
  id: string
  statement: string
  essential: boolean
  check: Check
  /**
   * v0.5.0 — the CLEO acceptance criteria this criterion's evidence demonstrates,
   * `T<id>#AC<n>` (the same form as a `satisfies:` atom). This is the PRECISE,
   * non-positional binding: when the criterion passes, the bridge links its
   * evidence to exactly these ACs. Absent ⇒ the criterion proves no CLEO AC.
   */
  proves?: GoalAcRef[]
}

/** A CLEO acceptance-criterion reference, `T<digits>#AC<n>`. */
export type GoalAcRef = `T${number}#AC${number}`

export type Assumption = {
  id: string
  text: string
  rationale?: string
  reversible?: boolean
  status: "assumed" | "confirmed" | "vetoed"
}

export type Step = {
  id: string
  title: string
  proves: string[]
  depends_on: string[]
}

/** T061: optional goal priority. Absent is valid and sorts LAST. */
export type Priority = "low" | "medium" | "high"
export const PRIORITIES: readonly Priority[] = ["low", "medium", "high"]
/** Sort weight: high first, absent last, ties by updatedAt descending. */
export const priorityWeight = (p?: Priority): number => (p === "high" ? 3 : p === "medium" ? 2 : p === "low" ? 1 : 0)

export type Budget = {
  turns?: number
  /** Wall-clock budget in milliseconds of active run time. */
  wallMs?: number
  /** Token spend (input + output + reasoning) across the run. */
  tokens?: number
  cost_usd?: number
}

/** Change classes the OWNER lets the agent apply to its own contract. */
export type AmendClass = "timeout" | "budget" | "plan" | "recover"
export const AMEND_CLASSES: readonly AmendClass[] = ["timeout", "budget", "plan", "recover"]

export type Autonomy = {
  questions: "defer" | "allow"
  on_user_message: "steer" | "pause"
  on_interrupt: "pause" | "resume-on-message"
  /** Owner-set policy: classes the agent may apply itself (default none). */
  amend: AmendClass[]
  /** Owner-set: what the stall detector does. `pause` (default) stops for the
   * owner; `continue` keeps a stalled-but-active run going with a report. */
  on_stall: "pause" | "continue"
}

export type VerificationMode = "host" | "host+verifier" | "strict"

/** v0.5.0 — the optional CLEO linkage block. Absent ⇒ no CLEO behaviour change. */
export const CLEO_GATES = ["implemented", "testsPassed", "qaPassed"] as const
export type CleoGate = (typeof CLEO_GATES)[number]
/**
 * A task the goal serves. The bare id links the task for reporting; `acs` is the
 * DECLARED, non-positional claim of which gate's evidence proves which AC alias.
 * An AC that is not declared (and has no typed gate) is left open and reported.
 */
export type CleoTaskLink = { id: string; acs?: Partial<Record<CleoGate, string[]>> }

export type Contract = {
  schema: typeof SCHEMA
  id: string
  title: string
  /** T061: optional low/medium/high ordering across lists, palette and picker. */
  priority?: Priority
  /** T031: "<slug>@<lock-prefix>" — this goal replaces that one (owner-approved append, never a rewrite). */
  supersedes?: string
  intent: { verbatim: string }
  outcome: string
  why?: string
  scope: { in: string[]; out: string[] }
  non_goals: string[]
  constraints: string[]
  criteria: Criterion[]
  invariants: Criterion[]
  /** T100: the exact-run execution workspace (root-relative). Host checks, the
   *  protect/diff base and the fingerprint resolve here; default is the project
   *  root. `.opencode/goals/**` still resolves at the project root. */
  workspace?: string
  /** v0.5.0 — the tasks this goal serves (absent ⇒ no CLEO behaviour change). */
  cleo?: { tasks: CleoTaskLink[] }
  protect: string[]
  assumptions: Assumption[]
  plan: Step[]
  budget: Budget
  stop: { when?: string; escalate_when: string[] }
  autonomy: Autonomy
  verification: {
    mode: VerificationMode
    max_rejections: number
    read: string[]
    /** T107: the contract names the verifier child's model, "providerID/modelID[#variant]". */
    model?: string
    /** T107: the contract names the verifier child's effort (used as the model variant when the model carries none). */
    effort?: string
  }
  execution: { agent?: string }
  meta: Record<string, unknown>
}

export type Issue = { level: "error" | "warning"; path: string; message: string }
