import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"

/** Delay only the fixture amendment's native question creation, not consent. */
export default {
  id: "fixture.delayed-amendment-form",
  async setup(ctx: Plugin.Context) {
    const registration = await ctx.tool.hook("execute.before", async (event) => {
      if (event.tool !== "question" || !JSON.stringify(event.input).includes("Amend chat-amend (run")) return
      await Bun.write(join(ctx.location.directory, "question-dispatched.json"), JSON.stringify({ sessionID: event.sessionID, messageID: event.messageID, input: event.input }))
      await Bun.sleep(1000)
    })
    return () => registration.dispose()
  },
}
