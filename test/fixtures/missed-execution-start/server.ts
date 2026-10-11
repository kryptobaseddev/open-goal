import type { Plugin } from "@opencode/plugin"
import { GoalApp } from "../../../src/server/app"

// TEST ONLY: model a freshly loaded plugin that did not observe the turn's
// original execution.started event. All other real host events remain intact.
export default {
  id: "opencode-goal-missed-start",
  async setup(ctx: Plugin.Context) {
    const app = new GoalApp({ ...ctx, event: {
      async *subscribe(options: any) {
        for await (const event of ctx.event.subscribe(options)) {
          if (event.type !== "session.execution.started") yield event
        }
      },
    } } as Plugin.Context)
    await app.start()
    return () => app.stop()
  },
}
