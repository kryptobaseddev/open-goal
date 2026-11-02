# Agnostic OCG — the three-goal roadmap

Status: **planned and validated, not launched.** Written 2026-10-19.
Owner intent: a harness-agnostic OCG goal system that breaks away from OpenCode as
the single operating harness, with a CLEO Saga → Epic → Task spine for each major
goal, and a clear path off `.opencode/goals`.

## The three goals

| # | Goal (slug) | Release | Contract lock | Saga | Outcome |
|---|---|---|---|---|---|
| 1 | `harness-identity` | 0.9.3 | `73a1c6e8680e` | T124 | Every run records a declared harness and both `goal_status` and `cleo-goal status --json` report it (OpenCode supplies name/version/capabilities; the CLEO dispatcher supplies the name only) |
| 2 | `adapter-seam` | 0.10.0 | `24e73ba22170` | T137 | One `HarnessAdapter` seam drives OpenCode and the CLEO tick; a real Claude project completes a host-only goal; a capability matrix states what each harness can do |
| 3 | `agnostic-goal-store` | 0.11.0 | `7b21017bbb35` | T150 | New runs use a canonical harness-neutral store (`.cleo/goals` default, config override); `.opencode/goals` stays readable; migration is opt-in and dry-run first |

Contracts: `.opencode/goals/<slug>/goal.yaml` (current store; Goal 3 migrates future runs).
All three validate with `goal_validate`; each has 5–6 criteria, 2 invariants, and the
existing oracle suites under `protect`.

## CLEO spine (created)

### T124 — OCG Harness Identity (saga)
| Epic | Tasks |
|---|---|
| T125 Run-state identity | T126 `harness` on RunState/initialRun/persist · T127 OpenCode identity at start · T128 expose in goal_status/provenance + host test |
| T129 CLI/status identity | T130 optional `harness` in `status --json` · T131 tick from `CLEO_HOOK_PROVIDER` (claude-code/codex) · T132 unit tests with/without/default |
| T133 CLEO contract/doctor | T134 T13875 optional harness on `GoalRuntimeStatus` · T135 doctor shows harness · T136 document the dispatcher signal |

### T137 — OCG Adapter Seam (saga)
| Epic | Tasks |
|---|---|
| T138 Interface/capabilities | T139 define `HarnessAdapter` · T140 capability matrix · T141 interface tests |
| T142 OpenCode extraction | T143 wrap the in-process path · T144 prove the protected oracles unchanged · T145 document the OpenCode capability set |
| T146 Tick + real proof | T147 implement the CLEO tick adapter · T148 real Claude Stop-dispatch proof · T149 status harness claude + Codex/Hermes/Kimi smoke |

### T150 — OCG Agnostic Goal Store and Protocol (saga)
| Epic | Tasks |
|---|---|
| T151 Canonical store | T152 configure the root (`.cleo/goals` default) · T153 update write guard/status/install · T154 path tests |
| T155 Legacy + migration | T156 read/resume legacy runs · T157 dry-run migration + guide · T158 archive/supersession across roots |
| T159 Protocol/docs | T160 wire the dispatcher `CLEO_HOOK_PROVIDER` signal (T13884) · T161 T10532 portable SKILL.md · T162 ADR + migration/deprecation docs |

## Why this order

1. **Identity first.** Nothing else can be trusted or compared until a run says
   which harness it is and what that harness can do. It is additive, small, and
   independent of the store move.
2. **Seam second.** With identity declared, the two paths can be expressed as one
   interface and a capability matrix. The OpenCode behavior must not change
   (protected oracles), and the tick gains a real second-harness proof.
3. **Store third.** Moving the store is a path/compatibility change. It is safer
   after the identity and seam exist, because the CLI/status/adapter all read the
   same root. It is deliberately a **minor** release with a legacy read path.

Goal 3 can be developed in parallel with Goal 2 after Goal 1 lands, but the
release order is 0.9.3 → 0.10.0 → 0.11.0.

## The agnostic store decision (Goal 3, assumption A1)

- **Canonical:** `.cleo/goals/<slug>/` — CLEO owns the goal protocol; the store is
  no longer named after one harness.
- **Override:** an explicit project config key selects another root; an invalid
  root fails closed.
- **Legacy:** `.opencode/goals/` remains **readable and resumable** for existing
  runs. It is not deleted or silently rewritten.
- **Migration:** opt-in, dry-run first, byte-preserving. The owner chooses when.
- **Archive:** `.cleo/goals-archive/` for the canonical root; the legacy archive
  stays readable.
- **Guard:** the agent write guard covers the active root and the legacy path
  during the transition.
- The three contracts in this plan are written under the current store; Goal 3's
  migration is what moves future runs (and can move these three if the owner opts in).

## CLEO-side tasks (not edited by these goals)

| Task | What it is | Owner |
|---|---|---|
| T13875 | optional `harness {name, version, capabilities[]}` on `GoalRuntimeStatus` | CLEO contracts |
| T13871 / T13872 | PR #2 review blockers: symlinked `.opencode`; eval transcript in the pack | goal-install / review-release |
| T13884 | dispatcher sets `CLEO_HOOK_PROVIDER` (claude-code/codex) | CLEO |
| T1639 | cleo-prime persona harness detection (separate) | CLEO |
| T10532 | cross-harness portable SKILL.md contract | CLEO |
| T13802 / T13804 / T13805 / T13806 | cross-project docs; heavy checks via `cleo run`; fabricated test-report binding; prefer CLEO-run tests | CLEO |
| T13791 | umbrella OCG integration epic | CLEO + OCG |

Goal 1's C4 verifier reads `../cleocode/packages/contracts/src/goal-runtime.ts`
(read-only) and requires the design note to quote the landed field. Goal 3 wires
the `CLEO_HOOK_PROVIDER` signal and records the portable-skill decision. T1639 remains the separate cleo-prime persona task.

## Launch and review gate

- **review-release APPROVED** main `a618897..e10ed69` on 2026-10-19. The 0.9.2
  tarball matches `95cb51b` byte for byte, with SLSA provenance; `release.yml`
  is unchanged; the stale-dist guard correctly stopped the v0.9.1 tag.
- The harness PR may now be opened from `main`. Each goal works in its own
  worktree and opens a **new PR**; merging needs a reviewer's approval on the
  **exact head**, and tags are created only **after CI on that commit is green**
  (v0.9.1 is a dead tag). No force-push on shared branches.
- The release criterion is still the last step. Send the PR number to
  cleo-dev-mac; it needs a reviewer's approval before merge.
- Worktrees: `.worktrees/harness-identity`, `.worktrees/adapter-seam`,
  `.worktrees/agnostic-goal-store` (all cut from `origin/main` e10ed69).
- Launch sequence: Goal 1 → Goal 2 → Goal 3, each in a fresh goal session.
  Goal 3 may be developed in parallel after Goal 1, but releases stay ordered.

## What is never automatic

- Merging to main, tagging, publishing to npm, or deprecating a version.
- Moving or deleting existing `.opencode/goals` history.
- Guessing a harness from a transcript; declaring a capability a harness lacks.
- Writing user-global `~/.claude`, `~/.codex` or `~/.config` files.
- Editing CLEO's repository from these goals.

## Definition of done (three releases)

- **0.9.3:** every run records harness identity; status/doctor report it; old runs
  parse; release installed and proven.
- **0.10.0:** one adapter seam; OpenCode unchanged; real Claude host-only goal
  completes through CLEO's Stop dispatcher; capability matrix; Codex/Hermes/Kimi
  smoke; release installed and proven.
- **0.11.0:** canonical `.cleo/goals` store; legacy `.opencode/goals` readable;
  opt-in dry-run migration; guard/status/install resolve the root; ADR and guide;
  release installed and proven.
