// TEST ONLY: map real isolated execution-end events to deterministic failure
// sequences. No production bypass, owner choice or guard/oracle edit.
import type { Plugin } from "@opencode/plugin"
import { GoalApp } from "../../../src/server/app"
import { readFileSync } from "node:fs"
import { join } from "node:path"

export default {
  id: "opencode-goal-failed-execution-test",
  async setup(ctx: Plugin.Context) {
    let ends = 0
    const mode = readFileSync(join(ctx.location.directory, "failure-mode.txt"), "utf8").trim()
    const app = new GoalApp({ ...ctx, options: { ...ctx.options, maxPromptFailures: 2, cooldownMs: 10 }, event: {
      async *subscribe(options: any) {
        for await (const event of ctx.event.subscribe(options)) {
          if (event.type === "session.execution.succeeded") {
            ends += 1
            // An actual successful model execution between failures must
            // reset the streak; admission acknowledgement must not.
            if (mode !== "recover" || ends !== 2) {
              yield { ...event, type: "session.execution.failed", data: { ...event.data,
                error: { type: "TestExecutionFailure", message: mode === "unavailable" ? "Model unavailable: openai/gpt-6.1-sol" : "Temporary transport failure" } } }
              continue
            }
          }
          yield event
        }
      },
    } } as Plugin.Context)
    await app.start()
    return () => app.stop()
  },
}
