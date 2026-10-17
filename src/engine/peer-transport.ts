// v0.8.0 — the AgentMBX transport behind the pure announcement policy.
//
// One process boundary, one place that can fail. Every failure is returned as
// "no id"/"no replies" and journalled by the caller; it is never invented. The
// channel is only constructed when an identity is configured, so a project with
// no mailbox does not shell out to a command whose side effects nobody asked for.

import type { PeerChannel, PeerReply } from "./peer-announce"

export type PeerTransportOptions = {
  bin: string
  identity: string
  cli: string
  timeoutMs?: number
}

const asText = (v: unknown) => (typeof v === "string" ? v : "")

/** The id from `{"id": "..."}`, a plain id line, or `id: ...`; undefined if absent. */
export function parseMessageId(stdout: string): string | undefined {
  const text = stdout.trim()
  if (!text) return undefined
  try {
    const parsed = JSON.parse(text)
    const id = asText(parsed?.id ?? parsed?.data?.id)
    if (id) return id
  } catch { /* not JSON */ }
  return /(?:^|\s)(?:id|messageId)[:=]\s*"?([A-Za-z0-9_-]{6,})"?/i.exec(text)?.[1]
    ?? /^([A-Za-z0-9_-]{20,})$/.exec(text)?.[1]
}

export function createPeerChannel(options: PeerTransportOptions): PeerChannel {
  const timeoutMs = options.timeoutMs ?? 10_000
  const run = async (args: string[]): Promise<{ stdout: string; exit: number }> =>
    new Promise((resolve) => {
      const child = Bun.spawn([options.bin, ...args], { stdout: "pipe", stderr: "ignore" })
      const timer = setTimeout(() => child.kill(), timeoutMs)
      Promise.all([new Response(child.stdout).text(), child.exited])
        .then(([stdout, exit]) => resolve({ stdout, exit: Number(exit) }))
        .catch(() => resolve({ stdout: "", exit: 1 }))
        .finally(() => clearTimeout(timer))
    })

  const sessionArgs = (sessionID?: string) =>
    sessionID ? ["--cli", options.cli, "--session", sessionID] : []

  return {
    async announce(input) {
      const result = await run([
        "send", "--as", options.identity, "--to", "*",
        "--subject", "Available for work", "--kind", "message",
        "-m", input.text, ...sessionArgs(input.sessionID),
      ])
      if (result.exit !== 0) return undefined
      const id = parseMessageId(result.stdout)
      return id ? { id } : undefined
    },
    async replies(input) {
      const result = await run([
        "inbox", "--as", options.identity, "--all", "--json",
        ...sessionArgs(input.sessionID),
      ])
      if (result.exit !== 0) return []
      let parsed: unknown
      try { parsed = JSON.parse(result.stdout) } catch { return [] }
      const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as any)?.messages) ? (parsed as any).messages : []
      return rows.flatMap((m: any): PeerReply[] => {
        const id = asText(m?.id)
        const from = asText(m?.from)
        const at = Date.parse(asText(m?.ts))
        if (!id || !from || from === options.identity || Number.isNaN(at) || at <= input.since) return []
        // The list endpoint has no body; the subject is the first line of what
        // the peer said. A fuller read is the next step, never an invention.
        return [{ id, from, at, text: asText(m?.subject) || "(no subject)" }]
      })
    },
  }
}
