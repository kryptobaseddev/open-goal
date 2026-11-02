// v0.9.5 - which harness produced a run, and what that harness can actually do.
//
// Every run records a declared identity: `{name, version, capabilities[]}`. It is
// additive and optional — `schemaVersion` stays 1 and a run written before this
// field existed still parses. The declarations themselves live in the one seam,
// `src/engine/harness.ts`: this module is the recorded-shape view of it, so a run
// and an adapter can never disagree about who a harness is or what it can do.
//
// Two paths declare an identity, and neither ever guesses:
//
//   opencode   the in-process engine knows its own harness, its serving package
//              version and the surfaces it can actually drive (`OPENCODE_ADAPTER`)
//   claude /   CLEO's Stop dispatcher names the harness in `CLEO_HOOK_PROVIDER`
//   codex      (CLEO T13884). It knows nothing else, so version and capabilities
//              stay null — the run says "not known on this path", never an empty
//              array pretending to be a set
//
// Anything else is `unknown`. A transcript (a Stop payload) is data the harness
// wrote; it never renames the harness. There is deliberately no second
// convention: no `OCGOAL_HARNESS` variable and no `--harness` flag.
//
// The capability vocabulary is the adapter seam's `HarnessCapabilities` (0.10.0);
// the full matrix per harness is documented in `docs/research/harness-adapter.md`
// and pinned by `test/unit/harness-matrix.test.ts`.

import { HARNESS_NAMES, OPENCODE_ADAPTER, tickAdapter, type HarnessIdentity, type HarnessName } from "./harness"

export { CLEO_HOOK_PROVIDER, harnessFromHookProvider } from "./harness"
export type { HarnessIdentity, HarnessName }

/**
 * What the OpenCode in-process engine can actually deliver, in the adapter's own
 * declaration order. Each name is a surface this code base really drives; see
 * `OPENCODE_CAPABILITIES` in `src/engine/harness.ts` for the annotated set.
 */
export const OPENCODE_CAPABILITIES: readonly string[] = OPENCODE_ADAPTER.identity().capabilities ?? []

/** The identity the OpenCode engine records at goal start. */
export function opencodeIdentity(version: string | null | undefined): HarnessIdentity {
  return OPENCODE_ADAPTER.identity({ version: version ?? null })
}

/**
 * The identity a Stop-dispatched tick records: the declared name only. CLEO does
 * not tell the dispatcher the harness version or its capabilities, so they stay
 * null rather than being invented from what the payload happens to contain.
 */
export function dispatcherIdentity(env: Record<string, string | undefined> = {}): HarnessIdentity {
  return tickAdapter(env).identity()
}

/** A recorded identity is usable only if it has the documented shape. */
export function isHarnessIdentity(value: unknown): value is HarnessIdentity {
  if (!value || typeof value !== "object") return false
  const identity = value as Partial<HarnessIdentity>
  return (
    HARNESS_NAMES.includes(identity.name as HarnessName) &&
    (identity.version === null || typeof identity.version === "string") &&
    (identity.capabilities === null || (Array.isArray(identity.capabilities) && identity.capabilities.every((c) => typeof c === "string")))
  )
}
