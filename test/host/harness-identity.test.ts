import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { GoalRpc } from "../../src/rpc"
import { goalHost, ledger, newSession, run, script, text } from "./goal.helpers"
import { until } from "./harness"

// C1 — a goal started under OpenCode records which harness produced it and what
// that harness can actually do: {name: "opencode", version: <serving version>,
// capabilities: [...]}. The run state and the ledger both carry it, and the
// goal_status surface (the tool result and the view behind it) exposes it.
//
// The version is the SERVING package version, read from this checkout's
// package.json — the same bytes the host loaded — never a hardcoded label.

const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")) as { version: string }

const OPENCODE_CAPABILITIES = ["start", "continuation", "events", "tools", "forms", "verifier", "tui", "steering", "version"]

test("a goal started under OpenCode records and exposes its harness identity", async () => {
  const host = await goalHost(
    script((_req, turn) => {
      if (turn.trigger.includes("goal started")) {
        // Ask the real tool, so the assertion is about goal_status's output and
        // not only about the state object behind it.
        if (turn.results === 0) return { toolCalls: [{ name: "goal_status", args: {} }] }
        return { text: "Harness identity observed." }
      }
      return { text: "Nothing else to do." }
    }),
  )
  try {
    const sessionID = await newSession(host)
    await host.client.session.command({ sessionID, name: "goal", text: "start demo" } as any)

    // ── the run state carries it
    const state = await until(async () => {
      const r = await run(host).catch(() => undefined)
      return r && r.harness ? r : undefined
    }, 60000, 200)
    expect(state.harness).toEqual({ name: "opencode", version: pkg.version, capabilities: OPENCODE_CAPABILITIES })

    // ── and the ledger's start event carries the same identity
    const events = await ledger(host)
    const start = events.find((e) => e.type === "start")
    expect(start).toBeDefined()
    expect(start!.harness).toEqual({ name: "opencode", version: pkg.version, capabilities: OPENCODE_CAPABILITIES })

    // ── goal_status exposes it: the tool result the agent actually received
    const toolResult = await until(() => {
      for (const request of host.fixture.requests) {
        const results = request.messages.filter((m) => m.role === "tool").map((m) => text(m)).join("\n")
        if (results.includes('"harness"') && results.includes('"opencode"')) return results
      }
      return undefined
    }, 60000)
    expect(toolResult).toContain(`"version": "${pkg.version}"`)
    expect(toolResult).toContain('"forms"')

    // ── the view behind goal_status and the runtime provenance agree
    const rpc: any = (host.client as any).rpc(GoalRpc)
    const snapshot = await rpc.snapshot({ sessionID })
    expect(snapshot.view.harness).toEqual({ name: "opencode", version: pkg.version, capabilities: OPENCODE_CAPABILITIES })
    const provenance = await rpc.provenance({ sessionID })
    expect(provenance.harness).toEqual({ name: "opencode", version: pkg.version, capabilities: OPENCODE_CAPABILITIES })
  } finally {
    await host.stop()
  }
}, 120000)
