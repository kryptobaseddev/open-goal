import type { MouseEvent, SelectRenderable } from "@opentui/core"

/** OpenTUI 0.5.14 Select is keyboard-only. Add pointer activation for our
 * plain one/two-line rows, retaining its real selection and keyboard path.
 * Its visible slice is centered on the selected index; derive that slice
 * from public geometry rather than accessing private scrollOffset. */
export function pointerSelect(control: SelectRenderable, event: MouseEvent, rowHeight: 1 | 2): void {
  if (event.button !== 0 || event.isDragging) return
  const row = Math.floor((event.y - control.y) / rowHeight)
  const visible = Math.max(1, Math.floor(control.height / rowHeight))
  if (row < 0 || row >= visible || event.x < control.x || event.x >= control.x + control.width) return
  const first = Math.max(0, Math.min(control.getSelectedIndex() - Math.floor(visible / 2), control.options.length - visible))
  const index = first + row
  if (index >= control.options.length) return
  event.stopPropagation()
  event.preventDefault()
  control.focus()
  control.setSelectedIndex(index)
  control.selectCurrent()
}
