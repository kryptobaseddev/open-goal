# Session handoff — why a fresh goal session starts blind

Status: **diagnosis + design proposal, 2026-10-17.** Written after the first
`fresh: true` launch in this project started a goal session with the contract and
nothing else. Implementation status is stated at the end; nothing here is a claim
that the design is shipped.

Sources: `.opencode/goals/proactive-continuation/` (contract, run, ledger),
`.opencode/goals/.owner-launches.json`, `src/server/app.ts`, `src/engine/state.ts`,
`src/contract/render.ts`, `skills/write-goal/SKILL.md`, git history, and the live
exchange with `opencode-goal-builder` (session `ses_ebeed1b03ffeDc98PWOK7xeeVM`).

## 1. What actually happened

- v0.7.1 (`tick-records-the-turn`, run `1471f46b9001`) completed 9/9 at
  `040b8bf`. Its owner session prepared and launched v0.8.0
  (`proactive-continuation`, lock `6c7020ff9443…`) with **`fresh: true`**
  (launch decision `9b079792-223c-4801-9100-f033a7f3a392`).
- The host created session `ses_eb82b0d09ffeS3UJBJeRLw1idx`, started run
  `147dfba0e001`, and admitted a **kickoff** turn. The new session received:
  - the contract as the system block (`renderSystemBlock`), and
  - the one-line trigger `◎ goal started: v0.8.0: a loop that keeps finding work`.
- It received **no** pointer to the previous run, no handoff note, no recon
  facts, no red-baseline table, and no "start here". The departing session had
  ~17 minutes of rehearsal output and months of project context that did not
  cross the session boundary.
- The goal folder contains `goal.yaml`, `run.json`, `ledger.jsonl`, `evidence/`
  — and **neither `context.md` nor `decisions.jsonl`**. It is the only current
  goal folder in that state besides `host-owned-run-state-integrity`.
- `docs/HANDOFF.md`, the file `AGENTS.md` tells every session to read first, was
  a stale v0.3.x document about a different mission (T103 lab triage). It was not
  wrong about its own era; it was simply never advanced. The new session read it
  and lost time before discovering the drift.
- `.opencode/goals/.owner-launches.json` records **21 prior launches, every one
  `fresh: false`**, all in one long-lived session. v0.8.0 is the **first**
  `fresh: true` launch in the project. The defect was never exercised because
  the "handoff" had always been the same session's own history.

## 2. Why the code produces this

The engine treats a fresh launch as a **session move**, not a **knowledge move**:

1. `startClean` (`app.ts:1551`) copies the source session's `agent` and `model`,
   creates a new session, and records `Handoff = { fromSessionID, toSessionID,
   agent?, model?, fallback? }` (`state.ts:33`, `app.ts:1566`). That is identity
   metadata only — it carries no facts, decisions, evidence or next action.
2. `startGoalLocked` stores that object on the run (`app.ts:1665`) and admits
   `kickoff` (`app.ts:1691`).
3. The kickoff turn renders `renderTailNote(..., "kickoff")`
   (`render.ts:102-117`): budget, criteria board, plan, last verdict. The
   kickoff header is a generic "read the contract and begin with the first
   unfinished plan step". Nothing reads the handoff object.
4. `context.md` and `decisions.jsonl` are **write-goal artifacts**, specified by
   `skills/write-goal/SKILL.md` (§1 recon, §3 grill), but **no engine code reads
   them** — `grep` over `src/` finds zero references. They are documentation the
   model may write, not input the host consumes. Even a perfect interview would
   not be injected.
5. The launch review shown to the owner (`app.ts:685-694`) names the mode
   ("new root session; the original session and history are NOT cleared") but
   says nothing about what the new session will and will not know, and nothing
   requires a handoff.
6. The rehearsal — the single most valuable artifact for the new session — is
   produced at start (`app.ts:1640-1660`), written to
   `evidence/<run>/rehearsal.json` and a ledger row, and then **not rendered**.
   The new session had to rediscover that C1–C6 and C8 were red and I1/I2 green,
   although the host already knew it.

So the failure is not "the kickoff did not land". It is **kickoff without
continuity**: the host knows a great deal at launch time and deliberately hands
over only the locked contract.

## 3. Why it matters beyond one goal

A fresh launch is exactly what the v0.8.0 contract asks the engine to do more of:
C4 is "completion starts the next ready CLEO item by itself", which means the
engine will routinely open a new session at a moment when the *old* session holds
the context. A loop that keeps finding work while losing the reason for it is a
machine that re-derives the same facts every cycle. The same defect also appears
at a smaller scale in C1 and C2: a restart resume and an amendment resume today
send a bare `continue`/`resume` tail, not "where you were, what changed, what is
next".

## 4. What a new session actually needs

Ordered by how much time it saves, based on this incident:

1. **The one next action.** "S1: author the red tests for every continuation and
   stop rule. Files to create: `test/unit/interrupt-policy.test.ts`,
   `test/host/restart-continuity.test.ts`, …" The contract's plan says S1, but
   not which files are missing.
2. **The known traps.** `stderr_contains` is not a supported `expect` key
   (`parse.ts:121-122` accepts `exit`, `stdout_contains`, `stdout_regex`, `runs`
   and silently drops the rest); `npm pack --dry-run` writes its file list to
   stderr, so use `--json`. Both cost the previous session real time.
3. **The red baseline** the host already measured (which criteria currently
   fail, and why), not just "unknown".
4. **Identity and provenance.** Previous goal/run/lock, release tag and commit,
   installed version and why the completing round must run the *installed*
   engine.
5. **Owner decisions** in the owner's words, and which ones are *not* open
   questions any more.
6. **Which documents are authority and which are stale.** `docs/HANDOFF.md` was
   actively misleading; a handoff must say so by name.
7. **Open threads.** Unanswered decisions, pending reviews, mailbox messages,
   ready CLEO items, known blockers.
8. **Where the evidence lives**, so the new session can read rather than re-run.

## 5. Design: a host-owned handoff bundle

### 5.1 The artifact

Every goal folder gains two host-written files at launch:

- `handoff.json` — machine-readable, bounded, every field carrying a `source`
  (ledger entry, evidence path, git command, CLEO CLI output, peer note).
- `handoff.md` — the rendered digest a human or model reads.

Proposed shape (deliberately small; no free-form model prose required):

```json
{
  "schema": "opencode-goal/handoff/v1",
  "slug": "proactive-continuation",
  "generatedAt": "2026-10-17T03:20:00Z",
  "mode": "fresh",
  "prior": { "slug": "tick-records-the-turn", "runId": "1471f46b9001",
             "status": "complete", "lock": "981c5914…", "release": "v0.7.1",
             "commit": "040b8bf", "summary": "…" },
  "repo": { "head": "040b8bf", "branch": "main", "dirty": [],
            "installedVersion": "0.7.1", "installedFrom": "#v0.7.1" },
  "baseline": [ { "id": "C1", "pass": false }, { "id": "I1", "pass": true } ],
  "nextAction": { "step": "S1", "text": "…", "files": ["test/unit/…"] },
  "decisions": [ { "q": "…", "a": "…", "by": "owner", "source": "decisions.jsonl:4" } ],
  "recon": [ { "fact": "…", "source": "context.md:12" } ],
  "traps": [ { "fact": "…", "source": "src/contract/parse.ts:121" } ],
  "authority": { "trust": ["goal.yaml", "docs/HANDOFF-v0.8.0.md"],
                 "stale": ["docs/HANDOFF.md (v0.3.x body)"] },
  "openThreads": [ { "kind": "mbx", "id": "…", "needs": "reply" } ],
  "evidence": [ ".opencode/goals/tick-records-the-turn/evidence/1471f46b9001/" ]
}
```

Rules:

- **The host builds it from things it can observe.** Ledger, run state, rehearsal,
  git, `git tag`, the prior goal's summary, `context.md`/`decisions.jsonl` when
  present, CLEO's ready list, and an optional peer handoff note. The model may
  *annotate* it; it may not invent facts. Every entry keeps its source.
- **Bounded.** A turn-1 digest of at most ~8 KB; the full file stays on disk.
  The system block stays byte-stable (R8); the handoff is volatile tail content,
  turn 1 only.
- **Not authority.** A handoff cannot approve a criterion, accept an amendment,
  resume a stopped goal, or change a contract. It is context, clearly labelled
  as data. Owner decisions in it are quoted with their source, not re-executed.

### 5.2 The gate

`goal_prepare_launch({fresh:true})` should either build the bundle or surface a
native warning with two choices:

- **Carry the handoff** (recommended) — build it now and inject it at kickoff.
- **Start with the contract only** — the owner explicitly accepts a blind start.

A fresh launch with no handoff must never be silent again. Non-fresh launches
need no bundle (the session already has the context).

### 5.3 Injection

Turn 1's tail note gains a `<goal_handoff>` section rendered from `handoff.md`,
ending with the path to the full file and the phrase "context, not authority".
The kickoff header becomes: read the handoff, confirm its repo facts, then take
the next action. Turn 2+ drops it (the agent has read it), so the prefix cache is
unaffected.

### 5.4 Reuse for restarts and amendments (C1/C2)

The same renderer, scoped smaller, produces a **resume digest** for:

- a clean restart auto-resume: last turn, pending claim or verdict, current step,
  what changed on disk while paused, next action;
- an accepted amendment: which criteria reset, what the new generation changed,
  what stays proven, next action.

This is how C1 and C2 stop being bare "continue" prompts. The continuation
policy and the handoff policy are the same idea at two scopes.

### 5.5 Peer continuity

The departing session should leave an AgentMBX handoff note
(`mbx_handoff save`) before it releases its identity, and the host should read
the prior holder's note into the bundle when it exists. In this incident the
builder released its identity about 20 seconds before the kickoff and had saved
nothing; the only reason orientation was possible at all was that the session
was still alive and answered a direct message. That is luck, not a mechanism.

The host cannot write another agent's mailbox for it, but it can:

- ask for the note at goal completion and before a fresh launch;
- record `handoff-note: present|missing` in the ledger;
- include the note in the bundle, labelled `source: mbx-handoff`.

### 5.6 Freshness of human docs

`docs/HANDOFF.md` should be a **generated pointer**, not a hand-maintained
narrative:

```md
# Handoff
Current: v0.8.0 (proactive-continuation), run 147dfba0e001
Read: docs/HANDOFF-v0.8.0.md (sha256 …)
History: docs/HANDOFF-history/…
```

`ocg handoff --check` (or `goal_status`) can then fail loudly when the pointer's
hash no longer matches the file, or when the current goal's handoff is missing.
A stale document that the onboarding path trusts is worse than no document.

## 6. What the handoff must never do

- Carry consent, approvals, or "the owner already said yes".
- Skip launch review, lock checks, or the rehearsal.
- Change a criterion, a check, a protect glob, or a budget.
- Turn a stale document into authority. Stale sources are named as stale.
- Persist secrets or provider credentials. Bounded, project-local, redacted.

A handoff can also contradict the contract it accompanies. In this project the
handoff says a first visit to a new project and an exhausted budget are **not**
stop rules, while the launched contract's C6 says they **are**. Both cannot be
true. The engine must surface that contradiction to the owner as a decision —
quoting both sources — rather than silently letting the newer prose or the older
contract win. A handoff is context; a contradiction is an owner question.

## 7. Implementation status

At the time of writing (v0.8.0, run `147dfba0e001`):

- **Done, outside the engine:** `docs/HANDOFF-v0.8.0.md` written by the
  departing session after this diagnosis; `docs/HANDOFF.md` now begins with a
  current-state banner pointing at it, so the next session is not sent to the
  v0.3.x body.
- **Proposed, not yet shipped:** the bundle schema, the fresh-launch gate, the
  turn-1 injection, the resume digest, the peer note, and `ocg handoff --check`.
  These are scoped next to C4 (the moment the engine opens a new session) and
  C1/C2 (the resume paths), not treated as already working.
- **Not claimed:** that a handoff makes a new session omniscient. It removes the
  rediscovery of facts the host already holds; the work still has to be done.
