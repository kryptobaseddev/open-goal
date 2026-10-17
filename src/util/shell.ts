// Runs owner-declared check commands in the owner's login shell, so PATH and
// toolchains match their terminal rather than the background service.
import { spawn } from "node:child_process"

export type ShellResult = { exit: number; stdout: string; stderr: string; timedOut: boolean; ms: number }

const LIMIT = 64 * 1024

/** Keep head and tail of oversized output so a runaway log never floods the verdict. */
const clip = (out: string) =>
  out.length > LIMIT ? `${out.slice(0, LIMIT / 4)}\n…[truncated ${out.length - LIMIT / 2} chars]…\n${out.slice(-LIMIT / 4)}` : out

export async function runShell(command: string, cwd: string, timeoutSeconds = 300, extraEnv: Record<string, string> = {}): Promise<ShellResult> {
  const shell = process.env.SHELL && process.env.SHELL.startsWith("/") ? process.env.SHELL : "/bin/sh"
  const started = Date.now()
  // node:child_process so the bin also runs on plain Node (Bun implements it too).
  const child = spawn(shell, ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...extraEnv, CI: process.env.CI ?? "1" } })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    if (stdout.length < LIMIT * 2) stdout += chunk
  })
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    if (stderr.length < LIMIT * 2) stderr += chunk
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, Math.max(1, timeoutSeconds) * 1000)
  const exit = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(127))
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)))
  })
  clearTimeout(timer)
  return { exit: timedOut ? 124 : exit, stdout: clip(stdout), stderr: clip(stderr), timedOut, ms: Date.now() - started }
}

export const tail = (text: string, lines = 12, chars = 1200) => {
  const t = text.trimEnd().split("\n").slice(-lines).join("\n")
  return t.length > chars ? `…${t.slice(-chars)}` : t
}
