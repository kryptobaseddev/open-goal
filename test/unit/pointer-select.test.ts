import { expect, test } from "bun:test"
import { SelectRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { pointerSelect } from "../../src/tui/pointer-select"

test("pointer row mapping agrees with the actual centered native Select viewport, including scroll and blank rows", async () => {
  const terminal = await createTestRenderer({ width: 40, height: 20 })
  const selected: number[] = []
  const control = new SelectRenderable(terminal.renderer, { id: "pointer", width: 30, height: 8, showDescription: true,
    options: Array.from({ length: 10 }, (_, i) => ({ name: `ROW_${i}`, description: `detail_${i}`, value: i })),
    onMouseUp: (event) => pointerSelect(control, event, 2) })
  control.on("itemSelected", (i) => selected.push(i))
  terminal.renderer.root.add(control)
  try {
    control.setSelectedIndex(7)
    await terminal.renderOnce()
    expect(terminal.captureCharFrame().split("\n")[0]).toContain("ROW_5")
    await terminal.mockMouse.click(control.x + 4, control.y)
    expect(selected).toEqual([5])
    expect(control.getSelectedIndex()).toBe(5)
    expect(control.focused).toBe(true)
    control.options = control.options.slice(0, 1)
    await terminal.renderOnce()
    await terminal.mockMouse.click(control.x + 4, control.y + 4)
    expect(selected).toEqual([5]) // blank area is not another activation
  } finally { terminal.renderer.destroy() }
})
