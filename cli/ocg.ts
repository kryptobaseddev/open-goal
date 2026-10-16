#!/usr/bin/env bun
// v0.6.0 - the `ocg` bin. Only `tick` is defined today; CLEO's Stop dispatcher
// spawns it with the harness's Stop JSON on stdin and reads JSON from stdout.
//
// Contract (CLEO #2306): JSON ONLY on stdout, logs on stderr, and nothing at all
// when there is no live goal or no `.opencode/goals` in the project.
//
// We deliberately do NOT install our own Stop hook in any harness: CLEO's
// dispatcher owns Stop, and a second entry would tick twice.
import { tick } from "../src/engine/tick"

const sub = process.argv[2]
if (sub !== "tick") {
  console.error("usage: ocg tick   (reads the harness Stop JSON on stdin; writes JSON on stdout)")
  process.exit(2)
}

// Read stdin to EOF (the harness Stop JSON). Its content is not required: the
// decision comes from the project's goal state, not from the payload.
const payload = await new Response(Bun.stdin.stream()).text().catch(() => "")
if (payload.trim()) console.error(`ocg tick: received ${payload.length} bytes of Stop payload`)

const result = tick({ root: process.cwd() })
for (const line of result.log) console.error(line) // logs ONLY on stderr
if (result.stdout) process.stdout.write(`${result.stdout}\n`) // JSON ONLY on stdout
process.exit(0)
