// OpenCode 2 server entry. A plain-object default export with type-only imports,
// so the plugin loads without @opencode/plugin installed at runtime.
import type { Plugin } from "@opencode/plugin"
import { GoalApp } from "./app"
import { OPENCODE_ADAPTER } from "../engine/harness"

// S6/T173: setup can run more than once for a location. The replacement engine
// is built to completion — recovery, then the whole tool/command/skill surface —
// BEFORE the previous one is retired, so a hot-load whose recovery fails keeps
// the working surface instead of leaving the location with none. Setups for the
// same location are serialized so two concurrent loads cannot each stop the
// other's engine or leave a second event loop attached.
const instances = new Map<string, GoalApp>()
const chains = new Map<string, Promise<unknown>>()

export default {
  id: "open-goal",
  setup(ctx: Plugin.Context) {
    const key = ctx.location.directory
    const next = (chains.get(key) ?? Promise.resolve()).then(async () => {
      const previous = instances.get(key)
      const app = new GoalApp(ctx, OPENCODE_ADAPTER)
      await app.start()
      instances.set(key, app)
      if (previous) await previous.stop()
      return async () => {
        await app.stop()
        if (instances.get(key) === app) instances.delete(key)
      }
    })
    chains.set(key, next.then(() => undefined, () => undefined))
    return next
  },
}
