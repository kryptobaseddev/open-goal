// TEST ONLY: read the actual TUI render tree. No owner operations, input
// injection, fabricated controls or production debug bypasses are exposed.
import type { Plugin } from "@opencode/plugin/tui"
import { renameSync, writeFileSync } from "node:fs"

export default {
  id: "goal-manager-pty-probe",
  setup(ctx: Plugin.Context) {
    // Installed V2 forwards server options but not these TUI-local options;
    // the gate supplies an explicit process-local test environment path.
    const output = process.env.OCGOAL_PTY_PROBE_OUTPUT ?? String(ctx.options.output ?? "")
    if (!output) throw new Error("PTY observer requires an output path")
    const timer = setInterval(() => {
      const nodes: any[] = []
      const pointerControls: any[] = []
      const renderedText = (node: any): string => [typeof node.plainText === "string" ? node.plainText : "", ...(node.getChildren?.() ?? []).map(renderedText)].filter(Boolean).join(" ").slice(0, 2000)
      const walk = (node: any) => {
        const select = typeof node.getSelectedOption === "function" && typeof node.selectCurrent === "function"
        if (typeof node.id === "string" && (node.id.startsWith("goal-") || node.id.startsWith("goal-card:") || select)) {
          nodes.push({ id: node.id, select, visible: node.visible !== false, focused: node.focused === true,
            x: node.x, y: node.y, width: node.width, height: node.height,
            ...(select ? { selectedIndex: node.getSelectedIndex(), options: node.options.map((o: any) => ({ name: o.name, description: o.description, value: typeof o.value === "string" ? o.value : o.value?.action })) } : {}) })
        }
        // Host dialog.select is a custom pointer/keymap list, not an
        // OpenTUI SelectRenderable. Observe REAL row handlers and bounds;
        // matching transcript strings alone cannot count as a control.
        const handlers = node._mouseListeners instanceof Map ? [...node._mouseListeners.entries()] : Object.entries(node._mouseListeners ?? {})
        const mouseHandlers = handlers.filter(([, handler]) => typeof handler === "function").map(([name]) => String(name))
        if (mouseHandlers.length) pointerControls.push({ id: node.id, class: node.constructor?.name, visible: node.visible !== false,
          x: node.x, y: node.y, width: node.width, height: node.height, mouseHandlers, text: renderedText(node) })
        for (const child of node.getChildren?.() ?? []) walk(child)
      }
      walk(ctx.renderer.root)
      const data = { pid: process.pid, time: Date.now(), directory: ctx.location?.directory, width: ctx.renderer.terminalWidth, height: ctx.renderer.terminalHeight, route: ctx.ui.router.current(), panel: ctx.ui.panel.current(), tabsEnabled: ctx.ui.tabs.enabled(), tabs: ctx.ui.tabs.list(), nodes, pointerControls }
      const temporary = `${output}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(data))
      renameSync(temporary, output)
    }, 100)
    return () => clearInterval(timer)
  },
}
