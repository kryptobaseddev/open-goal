// v0.10.0 - the HarnessAdapter seam.
//
// One interface, two paths: the OpenCode in-process engine (`src/server/app.ts`)
// and the CLEO Stop-time tick (`src/engine/tick.ts`). Before this module the two
// paths were two code shapes with implicit differences; a harness was "whatever
// OpenCode does" plus an env var for everything else. The seam makes the
// difference explicit and declarative:
//
//   identity      who the harness is, in the shape the run records
//   capabilities  what this harness can actually deliver, declared (never sniffed)
//   admission     how a goal is admitted into a session
//   continuation  how the host keeps the agent working after a turn
//   events        how the host observes a turn ending
//   forms         the native owner form surface, or null
//   verification  whether the independent verifier child can run here
//
// A capability is a claim about behaviour, so the two must never disagree: the
// surfaces are what a capability means, and `test/unit/harness-adapter.test.ts`
// fails when a profile declares a capability it has no surface for. The matrix
// (what each named harness can do) lives in `HARNESS_NAMES` / `adapterFor` and is
// documented in docs/research/harness-adapter.md; `test/unit/harness-matrix.test.ts`
// pins the table so the note cannot drift from the code.
//
// The TUI stays OpenCode-specific by owner decision (assumptions A1/A4 of the
// adapter-seam contract): a harness with no TUI declares no TUI, it is never
// asked to invent one.

import type { TailKind } from "../contract/render"

/** The harnesses this seam names. `unknown` is a real answer, not a fallback. */
export type HarnessName = "opencode" | "claude" | "codex" | "hermes" | "kimi" | "unknown"

export const HARNESS_NAMES: readonly HarnessName[] = ["opencode", "claude", "codex", "hermes", "kimi", "unknown"]

/**
 * What a harness can deliver. Every key is a claim the adapter must be able to
 * back with a surface; `true` with no surface is the bug this model exists to
 * prevent.
 */
export type HarnessCapabilities = {
  /** Can admit a new goal into a session by itself. */
  readonly start: boolean
  /** Can keep the agent working after a turn ends. */
  readonly continuation: boolean
  /** Has a live stream of turn events (not just a Stop-time notification). */
  readonly events: boolean
  /** The agent can call OCG tools by name. */
  readonly tools: boolean
  /** The host can put a native form in front of the owner. */
  readonly forms: boolean
  /** The independent verifier can run as a child session. */
  readonly verifier: boolean
  /** There is an in-process UI surface (the TUI). */
  readonly tui: boolean
  /** Owner messages can reach the run mid-turn. */
  readonly steering: boolean
  /** A harness transcript is readable (a Stop payload may name one). */
  readonly transcript: boolean
  /** The harness reports its own version. */
  readonly version: boolean
}

/** The identity a run records. Optional and additive: old runs never had one. */
export type HarnessIdentity = {
  name: HarnessName
  version: string | null
  /** Null means "not known on this path" — never an empty array pretending to be a set. */
  capabilities: string[] | null
}

/** Everything an adapter may need to answer who it is. */
export type IdentityInput = {
  /** The serving package version, when the path knows it. */
  version?: string | null
  /** The environment the harness declared itself in. */
  env?: Record<string, string | undefined>
}

/** True capability names, in declaration order — what a run's `capabilities[]` lists. */
export function capabilityList(capabilities: HarnessCapabilities): string[] {
  return (Object.keys(capabilities) as Array<keyof HarnessCapabilities>).filter((key) => capabilities[key])
}

// ── the surfaces a capability means

export type AdmissionSurface =
  | { kind: "in-process"; tool: string }
  | { kind: "owner-only"; reason: string }

export type ContinuationSurface =
  | { kind: "session-prompt"; tail: TailKind; reason: string }
  | { kind: "stop-block"; tail: TailKind; reason: string; payload: string }

export type EventSurface =
  | { kind: "session-events"; turnSignal: string }
  | { kind: "stop-only"; detail: string }

export type FormSurface = { kind: "native-ask"; tool: string }

export type VerificationSurface =
  | { kind: "verifier-child" }
  | { kind: "host-only"; reason: string }

/** The one seam both paths implement. */
export interface HarnessAdapter {
  readonly name: HarnessName
  readonly capabilities: HarnessCapabilities
  identity(input?: IdentityInput): HarnessIdentity
  admission(): AdmissionSurface
  continuation(tail: TailKind, reason: string): ContinuationSurface
  events(): EventSurface
  readonly forms: FormSurface | null
  readonly verification: VerificationSurface
}

// ── the CLEO dispatcher signal

/** The names a Stop dispatcher can declare: everything except the in-process harness. */
export type DispatchedHarness = Exclude<HarnessName, "opencode">

/** CLEO's dispatcher sets this when it spawns the tick (CLEO T13884). */
export const CLEO_HOOK_PROVIDER = "CLEO_HOOK_PROVIDER"

/**
 * Map the dispatcher's provider id onto a harness name. Only the two values CLEO
 * actually sets are mapped; everything else is `unknown` on purpose. This is the
 * single convention — no `OCGOAL_HARNESS`, no `--harness` flag — and a transcript
 * is never consulted (a Stop payload cannot rename the harness).
 */
export function harnessFromHookProvider(value: string | undefined): DispatchedHarness {
  switch ((value ?? "").trim()) {
    case "claude-code":
      return "claude"
    case "codex":
      return "codex"
    default:
      return "unknown"
  }
}

// ── the OpenCode in-process adapter

/**
 * OpenCode is the only path with the whole surface: the agent calls OCG tools,
 * the host sees session events, puts native forms in the composer, spawns the
 * verifier child, paints the TUI, and takes owner messages mid-turn. It does not
 * read a transcript — it sees events instead.
 */
export const OPENCODE_CAPABILITIES: HarnessCapabilities = {
  start: true,
  continuation: true,
  events: true,
  tools: true,
  forms: true,
  verifier: true,
  tui: true,
  steering: true,
  transcript: false,
  version: true,
}

export const OPENCODE_ADAPTER: HarnessAdapter = {
  name: "opencode",
  capabilities: OPENCODE_CAPABILITIES,
  identity: (input) => ({ name: "opencode", version: input?.version ?? null, capabilities: capabilityList(OPENCODE_CAPABILITIES) }),
  admission: () => ({ kind: "in-process", tool: "goal_start" }),
  continuation: (tail, reason) => ({ kind: "session-prompt", tail, reason }),
  events: () => ({ kind: "session-events", turnSignal: "session.execution.succeeded|failed|interrupted" }),
  forms: { kind: "native-ask", tool: "ask" },
  verification: { kind: "verifier-child" },
}

// ── the CLEO tick adapter

/**
 * The tick is a Stop-time observer in a session it does not own. It can continue
 * the agent (CLEO's `{"decision":"block","reason":…}`) and mine a transcript the
 * Stop payload names. It cannot start a goal, call tools, show a form, spawn the
 * verifier child, paint a TUI or take a mid-turn owner message — so it declares
 * none of those, and a goal that needs one of them is not a tick goal.
 */
export const TICK_CAPABILITIES: HarnessCapabilities = {
  start: false,
  continuation: true,
  events: false,
  tools: false,
  forms: false,
  verifier: false,
  tui: false,
  steering: false,
  transcript: true,
  version: false,
}

function tickAdapterFor(name: DispatchedHarness): HarnessAdapter {
  return {
    name,
    capabilities: TICK_CAPABILITIES,
    // CLEO does not tell the dispatcher the harness version or its capabilities
    // (harness-identity A1), so the recorded identity is name-only and says so.
    identity: () => ({ name, version: null, capabilities: null }),
    admission: () => ({ kind: "owner-only", reason: "CLEO starts the goal; the Stop dispatcher only continues and verifies it" }),
    continuation: (tail, reason) => ({ kind: "stop-block", tail, reason, payload: JSON.stringify({ decision: "block", reason }) }),
    events: () => ({ kind: "stop-only", detail: "the dispatcher sees the turn only when it ends; there is no live event stream" }),
    forms: null,
    verification: { kind: "host-only", reason: "the tick has no session to spawn the independent verifier child in" },
  }
}

/** The tick adapter for the harness the dispatcher declared (default: the real env). */
export function tickAdapter(env: Record<string, string | undefined> = process.env): HarnessAdapter {
  return tickAdapterFor(harnessFromHookProvider(env[CLEO_HOOK_PROVIDER]))
}

/** The declared adapter for any named harness — the seam's matrix, in code. */
export function adapterFor(name: HarnessName): HarnessAdapter {
  return name === "opencode" ? OPENCODE_ADAPTER : tickAdapterFor(name)
}

/**
 * A runtime conformance check. TypeScript proves shape at compile time; this
 * proves the object the engine actually holds answers every member, which is
 * what the host test and the seam tests assert.
 */
export function isHarnessAdapter(value: unknown): value is HarnessAdapter {
  if (!value || typeof value !== "object") return false
  const a = value as Partial<HarnessAdapter>
  return (
    HARNESS_NAMES.includes(a.name as HarnessName) &&
    typeof a.capabilities === "object" &&
    a.capabilities !== null &&
    typeof a.identity === "function" &&
    typeof a.admission === "function" &&
    typeof a.continuation === "function" &&
    typeof a.events === "function" &&
    (a.forms === null || typeof a.forms === "object") &&
    typeof a.verification === "object" &&
    a.verification !== null
  )
}
