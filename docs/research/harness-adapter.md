# The HarnessAdapter seam

Status: **S1, S2 and S3 landed** (interface and capability model, the OpenCode
path behind the seam, the tick adapter, and a real Claude project through CLEO's
Stop dispatcher). Written 2026-10-28 for the `adapter-seam` goal (release
0.10.0). It states what the code declares today, so the note never claims more
than the seam delivers.

Before this seam, "a harness" meant the OpenCode plugin plus an env var for
everything else. The seam makes the difference explicit: one interface, two
implementations, and a capability set each implementation must be able to back
with a surface. Code: [`src/engine/harness.ts`](../../src/engine/harness.ts);
tests: `test/unit/harness-adapter.test.ts`, `test/unit/harness-matrix.test.ts`.

## The interface

```ts
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
```

The seven members are the seven things the engine needs from a harness:

| Member | Meaning | OpenCode in-process | CLEO tick |
|---|---|---|---|
| `identity()` | who the harness is, in the shape a run records | `{name:"opencode", version:<serving version>, capabilities:[…]}` | `{name:"claude"\|"codex"\|"unknown", version:null, capabilities:null}` |
| `capabilities` | what it can actually deliver (below) | see matrix | see matrix |
| `admission()` | how a goal gets into a session | `{kind:"in-process", tool:"goal_start"}` | `{kind:"owner-only"}` — CLEO starts the goal |
| `continuation()` | how the host keeps the agent working | `{kind:"session-prompt"}` | `{kind:"stop-block", payload:'{"decision":"block","reason":…}'}` |
| `events()` | how the host sees a turn end | `{kind:"session-events", turnSignal:"session.execution.succeeded\|failed\|interrupted"}` | `{kind:"stop-only"}` |
| `forms` | native owner form surface, or `null` | `{kind:"native-ask", tool:"ask"}` | `null` |
| `verification` | can the independent verifier child run | `{kind:"verifier-child"}` | `{kind:"host-only"}` |

Both paths use the seam for the continuation they already sent: `GoalApp.admit`
takes its note from `adapter.continuation(...)`, and `tick()` builds CLEO's
`{"decision":"block"}` payload through the same call. The text is unchanged —
the seam owns the mechanism, not the wording.

The seam also owns the rest of the in-process engine's declarations, in code:

```ts
// GoalApp.start(): the engine exists only where a harness admits in-process.
const admission = this.adapter.admission()
if (admission.kind !== "in-process") throw new Error(`${this.adapter.name} cannot admit a goal into the in-process engine: ${admission.reason}`)

// GoalApp.registerTools(): no tools are registered for a harness without them.
if (!this.adapter.capabilities.tools) { …; return }

// GoalApp.startGoalLocked(): the run records the adapter's own identity.
initialRun(contract, { …, harness: this.adapter.identity({ version: this.packageVersion }) })

// GoalApp.verify(): the verifier child is passed only where it is declared.
...(this.adapter.verification.kind === "verifier-child" ? { verifier: … } : {})
```

For OpenCode every one of those is the same behaviour as before (in-process
admission, tools, a verifier child, the same identity list), which is why the
protected oracle suites are untouched; for any other adapter the declaration is
what decides, not a guess.

## The capability model

```ts
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
```

A capability is a claim about behaviour, so `test/unit/harness-adapter.test.ts`
fails when a declared capability has no surface behind it (`forms: true` must
come with `forms !== null`, `verifier: true` with `{kind:"verifier-child"}`, and
so on) for **every** named harness. That invariant is what "declares only what it
can deliver" means in code.

## The matrix

`test/unit/harness-matrix.test.ts` pins this table; the note and the code cannot
drift apart silently.

| Harness | start | continuation | events | tools | forms | verifier | tui | steering | transcript | version |
|---|---|---|---|---|---|---|---|---|---|---|
| **OpenCode** (in-process) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| **Claude** (`CLEO_HOOK_PROVIDER=claude-code`) | — | ✅ | — | — | — | — | — | — | ✅ | — |
| **Codex** (`CLEO_HOOK_PROVIDER=codex`) | — | ✅ | — | — | — | — | — | — | ✅ | — |
| **Hermes** | — | ✅ | — | — | — | — | — | — | ✅ | — |
| **Kimi** | — | ✅ | — | — | — | — | — | — | ✅ | — |
| **unknown** (no signal / any other value) | — | ✅ | — | — | — | — | — | — | ✅ | — |

Notes that keep the table honest:

- **OpenCode** is the only path with the whole surface. It does not read a
  transcript because it sees session events instead.
- **Claude / Codex** are the two values CLEO's dispatcher can declare
  (`CLEO_HOOK_PROVIDER`, CLEO T13884). They are install-and-tick cases: the tick
  continues the agent and mines a transcript the Stop payload names, and does
  nothing else.
- **Hermes / Kimi** are install-and-tick smoke cases (assumption A3), not parity
  claims. CLEO's dispatcher has no value for them today, so a tick under one
  records `unknown` rather than guessing the name — the matrix row describes the
  tick mechanism they share, not a detection that does not exist.
- **unknown** is a real answer, not a fallback: the tick still continues and
  verifies, but the run does not pretend to know who drove it.
- **The TUI stays OpenCode-specific** (assumption A1/A4): no harness is asked to
  invent an abstraction for a UI it does not have.

## The signal, and what is never sniffed

```ts
/** CLEO's dispatcher sets this when it spawns the tick (CLEO T13884). */
export const CLEO_HOOK_PROVIDER = "CLEO_HOOK_PROVIDER"

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
```

One convention: no `OCGOAL_HARNESS`, no `--harness` flag, no transcript mining
for a name. The tick reads the signal once, before it looks at any run or Stop
payload, so a payload cannot rename the harness. On the dispatcher path the
recorded identity is name-only: version and capabilities are `null`, because CLEO
does not tell the dispatcher either (harness-identity assumption A1).

## What the tick cannot do

Stated plainly, because a goal that needs one of these must run under the
in-process adapter. The tick drives **host-only goals** only: a goal whose
criteria are host checks (command, file, contains, absent, diff). It has:

- **No forms.** The tick cannot put a decision in front of the owner. A contract
  whose check is `human`, or a step that needs an amendment review, is not a tick
  goal.
- **No verifier child.** Verification runs the host checks only
  (`verifyClaim`). A `verifier` criterion — anything asking for an independent
  read-only verifier — needs OpenCode, so such a goal is not a host-only goal.
- **Cannot start a goal.** CLEO starts it and owns the session; the tick only
  continues, records and verifies.
- **No OCG tools.** The agent claims through `ocg claim`, not `goal_claim`.
- **No live events.** It sees one turn, at Stop; it does not see tool calls as
  they happen, and a transcript is optional (a missing one is a stated
  degradation, never a guess).
- **No steering and no TUI.** No owner message mid-turn, no sidebar.
- **No version.** `identity().version` is `null` on this path.

## What is declared today

```ts
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
```

## The Claude proof (what S2/S3 landed)

`test/host/claude-harness.test.ts` is the executable claim, and nothing at the
harness boundary is stubbed: a fresh project is initialized with the real `cleo`
CLI, `cleo goal install --harness claude` installs the project-level Stop
dispatcher in `.claude/settings.local.json`, and the exact hook command Claude
Code would run is executed with a real Stop payload on stdin. CLEO's dispatcher
(`cleo hook stop --provider claude-code`) spawns `cleo-goal tick` with
`CLEO_HOOK_PROVIDER=claude-code`; the tick records `harness: claude` on the run,
continues the turn, and after the agent claims through `ocg claim` verifies
every host criterion and finishes with an empty answer (the session may end).

The test also pins the honesty of the signal: the Stop payload it sends carries
`"harness":"codex"`, and the run still records `claude`. The `cleo-goal status
--json` and `cleo goal status --json` reads both report
`{name:"claude", version:null, capabilities:null}`.

**Codex / Hermes / Kimi** are install-and-tick smoke cases (assumption A3), not
parity claims. `CLEO_HOOK_PROVIDER=codex` records `codex`; Hermes and Kimi have
no dispatcher value today, so a tick under them records `unknown` rather than
guessing the name — the matrix row describes the tick mechanism they share.

**Recording identity on the run** (`harness` in `run.json`, `goal_status`,
`status --json`) comes from the `harness-identity` goal (T126–T131); this seam
supplies the declaration and `src/engine/harness-identity.ts` now derives the
recorded shape from the adapter instead of repeating it. There is one
`OPENCODE_CAPABILITIES` list, one provider mapping and one `HarnessName` union.

## Adding a harness

The seam is meant to make this a declaration plus a test, not a copy of
OpenCode's behaviour:

1. **Declare the name.** `HarnessName` in `src/engine/harness.ts` is the union the
   run can record. Add a name only when something can actually declare it — a
   dispatcher value (as `CLEO_HOOK_PROVIDER` does for `claude-code`) or a new
   entry path. Hermes and Kimi are named for the matrix but have no dispatcher
   value, so a tick under them records `unknown` instead of guessing.
2. **Declare the capabilities.** Build the adapter from `tickAdapterFor(...)` (or
   a new in-process shape) with a `HarnessCapabilities` object whose `true` keys
   each have a surface behind them. `test/unit/harness-adapter.test.ts` fails a
   declaration with no surface for any name in `HARNESS_NAMES`.
3. **Pin the row.** Add the row to the table in this note and to `MATRIX` in
   `test/unit/harness-matrix.test.ts`; the two must agree exactly. Then add the
   install proof: `cleo goal install --harness <h>` plus a real Stop through the
   dispatcher, the way `test/host/claude-harness.test.ts` does for Claude.

Nothing in `GoalApp` changes: it already takes identity, tools, verifier and
admission from the declaration.

## What is still not abstracted (honest scope)

- **The TUI** stays OpenCode-specific (assumption A1/A4): a harness with no TUI
  declares `tui: false` and is never asked to invent one. The store layout is
  likewise unchanged — moving it to a harness-neutral path is a separate goal
  (non-goal of this contract).
- **Live events and steering** are OpenCode surfaces. The tick sees only Stop,
  and a goal that needs an owner form or a verifier child is not a host-only
  goal, so it is not a tick goal.
- **No behavioral parity** is claimed for Claude, Codex, Hermes or Kimi beyond
  the columns in the matrix.
