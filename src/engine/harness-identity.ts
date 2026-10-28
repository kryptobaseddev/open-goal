// v0.9.5 - which harness produced a run, and what that harness can actually do.
//
// Every run records a declared identity: `{name, version, capabilities[]}`. It is
// additive and optional — `schemaVersion` stays 1 and a run written before this
// field existed still parses. Two paths declare it, and neither ever guesses:
//
//   opencode   the in-process engine knows its own harness, its serving package
//              version and the surfaces it can actually drive (`OPENCODE_CAPABILITIES`)
//   claude /   CLEO's Stop dispatcher names the harness in `CLEO_HOOK_PROVIDER`
//   codex      (CLEO T13884). It knows nothing else, so version and capabilities
//              stay null — the run says "not known on this path", never an empty
//              array pretending to be a set
//
// Anything else is `unknown`. A transcript (a Stop payload) is data the harness
// wrote; it never renames the harness. There is deliberately no second
// convention: no `OCGOAL_HARNESS` variable and no `--harness` flag.
//
// The capability names are the seam vocabulary of the next goal
// (`docs/research/harness-adapter.md`): one list of claims a harness either can
// or cannot back with a surface. This goal only needs the OpenCode set, so the
// list is declared here and documented in `docs/research/harness-identity.md`.

/** The harnesses this version names. `unknown` is a real answer, not a fallback. */
export type HarnessName = "opencode" | "claude" | "codex" | "unknown"

/** The identity a run records. Optional and additive: old runs never had one. */
export type HarnessIdentity = {
  name: HarnessName
  /** The serving harness's own version, when that path knows it. */
  version: string | null
  /** What the harness can deliver here; null means "not known on this path". */
  capabilities: string[] | null
}

/**
 * What the OpenCode in-process engine can actually deliver. Each name is a
 * surface this code base really drives:
 *
 *   start         admit a goal into a session (goal_start, owner-approved)
 *   continuation  keep the agent working after a turn (session.execution.* → admit)
 *   events        a live turn/usage event stream (not just a Stop-time notification)
 *   tools         the agent calls the goal_* tools by name
 *   forms         a native owner form in the composer (ask tool)
 *   verifier      an independent verifier child session
 *   tui           the in-process dashboard/manager UI
 *   steering      an owner message reaches the run mid-turn
 *   version       the harness reports its own serving version
 *
 * `transcript` is absent on purpose: OpenCode reports events, so the engine never
 * reads a transcript to learn what happened.
 */
export const OPENCODE_CAPABILITIES: readonly string[] = ["start", "continuation", "events", "tools", "forms", "verifier", "tui", "steering", "version"]

/** The identity the OpenCode engine records at goal start. */
export function opencodeIdentity(version: string | null | undefined): HarnessIdentity {
  return { name: "opencode", version: version ?? null, capabilities: [...OPENCODE_CAPABILITIES] }
}

/** CLEO's dispatcher sets this on the `cleo-goal tick` child (CLEO T13884). */
export const CLEO_HOOK_PROVIDER = "CLEO_HOOK_PROVIDER"

/**
 * Map the dispatcher's provider id onto a harness name. Only the two values CLEO
 * actually sets are mapped; everything else — including absent — is `unknown`.
 * Nothing is inferred from the Stop payload or the transcript.
 */
export function harnessFromHookProvider(value: string | undefined): HarnessName {
  switch ((value ?? "").trim()) {
    case "claude-code":
      return "claude"
    case "codex":
      return "codex"
    default:
      return "unknown"
  }
}

/**
 * The identity a Stop-dispatched tick records: the declared name only. CLEO does
 * not tell the dispatcher the harness version or its capabilities, so they stay
 * null rather than being invented from what the payload happens to contain.
 */
export function dispatcherIdentity(env: Record<string, string | undefined> = {}): HarnessIdentity {
  return { name: harnessFromHookProvider(env[CLEO_HOOK_PROVIDER]), version: null, capabilities: null }
}

/** A recorded identity is usable only if it has the documented shape. */
export function isHarnessIdentity(value: unknown): value is HarnessIdentity {
  if (!value || typeof value !== "object") return false
  const identity = value as Partial<HarnessIdentity>
  return (
    (identity.name === "opencode" || identity.name === "claude" || identity.name === "codex" || identity.name === "unknown") &&
    (identity.version === null || typeof identity.version === "string") &&
    (identity.capabilities === null || (Array.isArray(identity.capabilities) && identity.capabilities.every((c) => typeof c === "string")))
  )
}
