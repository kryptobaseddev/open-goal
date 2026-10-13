import { appendFileSync } from "node:fs"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"

/** Passive traces in the isolated fixture; never alters arguments or consent. */
export default {
  id: "fixture.lab-tool-boundary",
  async setup(ctx: Plugin.Context) {
    const names = ["goal_prepare_launch", "goal_manage", "goal_review", "goal_resolve_amendment"]
    const record = (value: unknown) => appendFileSync(join(ctx.location.directory, "tool-boundary.jsonl"), JSON.stringify(value) + "\n")
    const transform = await ctx.tool.transform((editor) => {
      for (const name of names) editor.update(name, (tool) => {
        const execute = tool.execute
        tool.execute = async (input, context) => {
          record({ phase: "plugin-entry", tool: name, sessionID: context.sessionID, input })
          return execute(input, context)
        }
      })
    })
    const before = await ctx.tool.hook("execute.before", (event) => {
      if (names.includes(event.tool)) record({ phase: "before", ...event })
    })
    const after = await ctx.tool.hook("execute.after", (event) => {
      if (names.includes(event.tool)) record({ phase: "after", ...event })
    })
    return async () => { await after.dispose(); await before.dispose(); await transform.dispose() }
  },
}
