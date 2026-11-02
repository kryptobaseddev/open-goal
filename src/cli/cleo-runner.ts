// T171 — the `cleo-goal` bin's CLEO runner. The bin must run on plain Node with
// no Bun APIs, so this is `node:child_process`; the plugin keeps its own Bun
// runner. Reads only: the rollup never passes a mutating verb through here.
import { spawn } from "node:child_process"
import type { CleoRun } from "../engine/cleo-bridge"

/** Spawn the cleo CLI with a hard timeout; every failure resolves with a non-zero exit. */
export function cleoRunner(command = process.env.OCGOAL_CLEO_BIN ?? "cleo", timeoutMs = 15000): CleoRun {
  return (argv) =>
    new Promise((resolve) => {
      let stdout = ""
      let settled = false
      const done = (exit: number) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ stdout, exit })
      }
      const child = spawn(command, argv, { stdio: ["ignore", "pipe", "ignore"] })
      const timer = setTimeout(() => child.kill(), timeoutMs)
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        if (stdout.length < 16 * 1024 * 1024) stdout += chunk
      })
      child.on("error", () => done(127))
      child.on("close", (code) => done(typeof code === "number" ? code : 1))
    })
}
