---
title: 'Host-suite flake: reproduced port collision, fixed and stress-proven'
audience: maintainer
status: final
---
# Host-suite flake: reproduced port collision, fixed and stress-proven

## The report

The host's verify of the protected suites failed once on
`test/host/goal-launch-flow.test.ts` → "a launch choice cannot approve contract
bytes changed after the displayed review" (37 pass / 1 fail), while three
identical re-runs passed 38/38 and no launch code had changed. Owner direction:
stress first with no assumptions — reproduce under deliberate load before naming a
cause; reproduce, fix, then five consecutive clean runs including one under
parallel load; publish only if src changed.

## The stress command

`bun scripts/stress-host-suite.ts --runs N --concurrency C [--assert-artifacts] [--require-clean] [--report <path>]`

It runs the host's own command shape over the same eight files, with
`bun test --parallel=C` for deliberate overlap, and reports a machine-readable
per-round outcome (pass, fail with the failing test's name, or a harness error),
keeping every round's junit plus the host `server.log` files of any failing round.
Each run writes its own timestamped directory under `.tmp/verification/flake/`, so
a later run can never overwrite the artifacts that document an earlier failure.
Heavy rounds still go through `cleo run --wait --class test`, so the machine-wide
budget governs them. No protected file is edited and the tests are never
re-implemented.

## Reproduction (before the fix)

`--runs 8 --concurrency 8` — eight bun worker processes over the eight files:

| Round | Result |
|---|---|
| 1, 2, 3, 5, 6, 7, 8 | pass |
| 4 | **fail** |

Artifacts: `.tmp/verification/flake/reproduction/results-prefix-8x8.json`
(SHA256 77cfb22bb1e580dc8cd78cc3f14b5263a2f71b9be7e103b5c779b696c379043d) and the
failing round's junit `.tmp/verification/flake/reproduction/round-4-junit.xml`
(SHA256 0970ccbe30133df1b344ae7c9a428de294b58b046a7fd10f18b5c1d2d73fa23c), whose
failure message quotes the child's own words:

    opencode serve did not start: … Failed to start server. Is port 62624 in use?

### Mechanism (from the captured artifact)

The harness allocated a port by opening a listener on port 0, closing it, and
passing the number to the child:

    const reserve = Bun.serve({ port: 0 }); const port = reserve.port; reserve.stop(true)
    Bun.spawn([OPENCODE_BINARY, "serve", …, "--port", String(port)])

The number is unbound for the whole interval between `stop()` and the child
binding it, so with eight hosts starting at once another process took port 62624
first and the child could not listen. The same window has a worse consequence than
the visible error: readiness only waited for *some* server to answer on that port,
so a foreign server would have been adopted as this host's engine — the class of
failure that produces a fast, strange assertion failure instead of a clean
start-up error.

**What is not claimed:** the exact `goal-launch-flow.test.ts` assertion from the
host's run was not reproduced directly. The reproduced failure is the port
collision, which is the same scheduling class as that observation (two hosts
interfering through a shared ephemeral port), and the artifact above names it.

## The fix

`test/host/harness.ts` no longer reserves a port. It asks for port 0, learns the
real port from the child's own `server listening on http://127.0.0.1:<port>` line,
and requires the answering server's pid to equal the pid of the child it spawned.
A taken port — or a foreign server answering on it — is retried on a fresh
ephemeral port, bounded to four attempts, after which the harness throws with the
accumulated reason and the child log. `OCGOAL_HOST_PORT` forces the first attempt
so the collision path is testable.

Guarded behaviour, red → green, on
`test/host/harness-port-identity.test.ts`:

- Red with the identity+retry guard removed:
  `.tmp/verification/flake/harness-port-identity-red-guard-removed.xml`
  (SHA256 78b68ac9bdce1b38c9e375e8d0774957d4310e6628b356b000a61e8f3f85779a) — the
  harness accepted the squatter's port and the test failed.
- Green with the fix:
  `.tmp/verification/flake/harness-port-identity-green.xml`
  (SHA256 30e11358b553a9b78d96f47471dff398b5ac956c901661c73be87f1a01e51f36).

## Stress proof after the fix

Same command shape, more rounds, same maximum overlap:
`--runs 12 --concurrency 8` → **12 of 12 clean**
(`.tmp/verification/flake/hunt-after-fix.log`, SHA256
0947780600fbf8cd87dfdd3e9e44736034abb20dc7d5d5072a35fdd1bdd90cc4; per-round junit
`round-1-junit.xml` 1377d6ae07c87e129967a7e78d892b245aaa5e1f9b907b13f7adb3cd18e02e01,
`round-4-junit.xml` 08cbcf690540ec63947480c5f6f9faf2255845b25b4f0f4eb59d997f0ae040ff,
`round-12-junit.xml` ad4c33841694bfb3108ab99dca5779489b0c94cad4bb40b1a56fb29f8d586b9d).
Before the fix the same 8-wide setting failed 1 of 8.

Five consecutive clean full runs (`--runs 5 --concurrency 3 --require-clean`) are
recorded with the final source in `.tmp/verification/flake/c5-five-clean.log` and
its own stamped `results.json`.

## What is not claimed

- The exact launch-suite assertion was not reproduced; the reproduced failure is
  the port collision in the same class. No engine behaviour is tied to the
  launch assertion.
- Only test infrastructure changed: the fix commit touches
  `test/host/harness.ts` plus the new guard test. No `src/` change, therefore no
  release is published.
- No protected oracle was edited, and no protected test's timeout or retry was
  raised.