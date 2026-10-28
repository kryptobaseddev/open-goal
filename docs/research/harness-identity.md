# Harness identity — every run says which harness produced it

Status: **implemented in 0.9.5** (saga T124, epics T125/T129/T133).
Read-with: `../cleocode/packages/contracts/src/goal-runtime.ts` (read-only; CLEO owns it)
and `docs/research/agnostic-ocg-roadmap.md` (why this is goal 1 of 3).

The engine used to be OpenCode-branded in its state and status surfaces: a run
said `sessionID`, `runId`, `lock` and nothing about *what produced it*. A second
harness could not be trusted, debugged or compared, because there was no field to
compare. This note records the field, the two paths that declare it, the one
signal the dispatcher uses, and what each capability means.

## 1. The recorded shape

One additive field on the run state:

```ts
export type HarnessIdentity = {
  name: HarnessName            // "opencode" | "claude" | "codex" | "unknown"
  version: string | null       // the serving harness's own version, when known
  capabilities: string[] | null // what it can deliver; null = "not known here"
}
```

- **Optional and additive.** `schemaVersion` stays `1`. A run written before the
  field existed has no `harness` key and still parses; every existing field is
  unchanged. Nothing is backfilled — an old run is honestly "unknown", not
  retro-labelled.
- **Declared, never sniffed.** The OpenCode engine records `opencode`; the CLEO
  Stop dispatcher names its harness through `CLEO_HOOK_PROVIDER`; everything else
  is `unknown`. A transcript (a Stop payload) is harness-written data and never
  renames the harness.
- **`null` is not an empty set.** The dispatcher path knows the name only, so
  `version` and `capabilities` are `null` rather than `null`-like guesses.
- **First writer wins.** The tick records the identity only when the run has none:
  the field says which harness *produced* the run, so a later tick in another
  harness never renames it (it logs the disagreement).

Where it is recorded and reported:

| Surface | What it shows |
|---|---|
| `run.json` (`RunState.harness`) | the recorded identity, persisted with the run |
| `ledger.jsonl` `start` event | `harness` beside `runId`/`sessionID`/`lock`, so a repaired run can be rebuilt with its producer |
| `ledger.jsonl` `harness` event (tick path) | name/version/capabilities with `source: "tick"` |
| `goal_status` / RPC `snapshot.view` / `goal_provenance` | `harness` on the view and on the runtime provenance receipt |
| `cleo-goal status --json` | `harness`, unchanged `schemaVersion: 1` |

The engine module is `src/engine/harness-identity.ts`; the run field is declared in
`src/engine/state.ts`; the CLI shape in `src/cli/status.ts`.

## 2. The dispatcher signal

CLEO's Stop dispatcher spawns `cleo-goal tick` (CLEO T13884) and sets exactly one
environment variable. The CLEO contract file states it:

> Environment variable naming the harness whose Stop the dispatcher is
> answering (`claude-code` or `codex`), set on the `cleo-goal tick` child so
> the tick can tell harnesses apart (T13884).

> `export const GOAL_TICK_PROVIDER_ENV = 'CLEO_HOOK_PROVIDER';`

The mapping, in one place and with no second convention:

| `CLEO_HOOK_PROVIDER` | recorded `name` | `version` | `capabilities` |
|---|---|---|---|
| `claude-code` | `claude` | `null` | `null` |
| `codex` | `codex` | `null` | `null` |
| absent, empty, or any other value | `unknown` | `null` | `null` |

There is deliberately **no `OCGOAL_HARNESS` variable and no `--harness` flag**.
Values are matched exactly (`claude`, `CLAUDE-CODE` and `cursor` are all
`unknown`), and the Stop payload is never consulted for identity.

## 3. What each capability means

Capabilities are claims about behaviour: a name is listed only if this code base
really drives the surface behind it. OpenCode records all of these; the
dispatcher path records `capabilities: null` because CLEO does not tell it.

| Capability | Meaning on the OpenCode path |
|---|---|
| `start` | can admit a goal into a session (`goal_start`, owner-approved) |
| `continuation` | can keep the agent working after a turn (`session.execution.succeeded\|failed\|interrupted` → admit) |
| `events` | a live turn/usage event stream, not just a Stop-time notification |
| `tools` | the agent calls the `goal_*` tools by name |
| `forms` | a native owner form in the composer (the `ask` tool) |
| `verifier` | an independent verifier child session can run |
| `tui` | the in-process dashboard/manager UI |
| `steering` | an owner message reaches the run mid-turn |
| `version` | the harness reports its own serving version (recorded in `version`) |

`transcript` is absent on purpose: OpenCode reports events, so the engine never
reads a transcript to learn what happened. The capability vocabulary is the one
the adapter-seam goal (0.10.0) formalises; that goal turns this list into a
matrix and widens the names. This goal only needs the OpenCode set.

## 4. The CLEO contract (T13875)

The read side is `GoalRuntimeStatus` in `../cleocode/packages/contracts/src/goal-runtime.ts`.
The file currently declares only the schema version and the run shape:

> `export const GOAL_RUNTIME_SCHEMA_VERSION = 1;`

> `export interface GoalRuntimeStatus {`
> `  readonly schemaVersion: typeof GOAL_RUNTIME_SCHEMA_VERSION;`

The optional harness field is CLEO task **T13875**, whose acceptance is:

> GoalRuntimeStatus has optional harness {name, version, capabilities: string[]} in packages/contracts

As of this note it is **pending in CLEO** — the repository above does not yet
declare the field, and this project does not edit CLEO (out of scope). The
runtime already emits the field, so T13875 is a type-only addition on the CLEO
side:

```ts
readonly harness?: {
  readonly name: string;
  readonly version: string | null;
  readonly capabilities: readonly string[] | null;
};
```

Because it is optional, a CLEO that has not landed T13875 ignores it; a CLEO that
has reads it. Neither needs a schema bump.

## 5. Doctor output

`cleo doctor goal-runtime` today reports the runtime it found, without the
harness (CLEO T135 "Show harness in cleo doctor goal-runtime" is still pending on
the CLEO side). Verbatim:

> `"status":"ok","message":"CLEO Goal 0.9.4 at /Users/keatonhoskins/.local/share/mise/shims/cleo-goal, goal harness-identity (running)"`

> `"details":{"bin":"/Users/keatonhoskins/.local/share/mise/shims/cleo-goal","version":"0.9.4","latest":null,"goal":"harness-identity","goalStatus":"running"}`

That is the honest state: the runtime version and the live goal are reported; the
harness line arrives with T135, and until then `cleo-goal status --json` is the
surface that carries it.

## 6. How this is proven

| Criterion | Proof |
|---|---|
| C1 | `bun test test/host/harness-identity.test.ts` — a real host starts a goal; `run.json`, the ledger `start` event, the `goal_status` tool result, the RPC view and provenance all carry `{name:"opencode", version:<serving version>, capabilities:[…]}` |
| C2 | `bun test test/unit/status-harness.test.ts` — a run with the field exposes it; a run without it still parses as `schemaVersion: 1` and omits it; both shapes round-trip through `dist/cli.js` on plain Node |
| C3 | `bun test test/unit/tick-harness.test.ts` — `claude-code` → `claude`, `codex` → `codex`, absent/other → `unknown`; a payload claiming otherwise is not believed; a recorded producer is never renamed |
| I1/I2 | the protected oracle suites and `bun run typecheck` (including generated TUI/CLI freshness) stay green |

## 7. What this note does not decide

- The `HarnessAdapter` seam, the full capability matrix and the Claude/Codex
  parity proof are the next goal (0.10.0). This goal declares identity only.
- Moving the store off `.opencode/goals` is the third goal (0.11.0).
- Writing user-global `~/.claude`, `~/.codex` or `~/.config` files is never part
  of identity.
