import type { Plugin } from "@opencode/plugin"
import { GoalApp } from "../../../src/server/app"

export default {
  id: "opencode-goal-short-review",
  async setup(ctx: Plugin.Context) {
    const app = new GoalApp({ ...ctx, options: { ...ctx.options, launchApprovalMs: 5000 } } as Plugin.Context)
    await app.start()
    return () => app.stop()
  },
}
