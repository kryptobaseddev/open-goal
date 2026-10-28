# The HarnessAdapter seam

Status: **S1 landed (interface, capability model, seam tests); S2/S3 are the
remaining plan steps.** Written 2026-10-28 for the `adapter-seam` goal (release
0.10.0). It states what the code declares today and marks what is not extracted
yet, so the note never claims more than the seam delivers.

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

## Not done yet (honest scope)

- **S2 / T143** extracts the rest of the OpenCode path: `GoalApp` still owns its
  own event loop, admission, tools and verification. Today only its continuation
  note goes through the seam, which is why the protected oracle suites are
  untouched.
- **S3 / T147** turns the tick declaration into the full tick adapter and proves
  a real Claude project through CLEO's Stop dispatcher (T148), then reports the
  harness in `status --json` (T149).
- **Recording identity on the run** (`harness` in `run.json`, `goal_status`,
  `status --json`) belongs to the `harness-identity` goal (its T126–T131). This
  seam supplies the shape (`HarnessIdentity`) and the mapping; it deliberately
  does not write run state, so the two goals do not implement the same field
  twice.
