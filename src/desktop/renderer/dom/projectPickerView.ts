import {
  PROJECT_PICKER_EMPTY,
  PROJECT_PICKER_LABEL,
  projectPickerSignature,
  type ProjectPickerIntent,
  type ProjectPickerRow,
  type ProjectPickerView,
} from '../model/projectPicker.js'
import { el } from './dom.js'
import { createPickerPopover } from './pickerPopover.js'
import { button } from './controls.js'
import { icon } from './icons.js'

/**
 * The project switcher as DOM: a popover over the welcome screen's project pill.
 *
 * The branch switcher's twin — same shell (`dom/pickerPopover.ts`), same rows,
 * same tick — with a folder glyph and no waiting states, because the list it
 * draws is the renderer's own rather than git's.
 *
 * Every decision is `model/projectPicker.ts`'s, including which rows exist.
 */

export interface ProjectPickerDom {
  render(view: ProjectPickerView): void
  /** Puts focus on the popover, for the click that opened it. */
  focusPanel(): void
}

export function createProjectPickerView(
  container: HTMLElement,
  onIntent: (intent: ProjectPickerIntent) => void,
  /**
   * Fed the raw chord; the caller maps it through `projectPickerKeyToIntent` and
   * answers whether it consumed the key.
   */
  onKey: (chord: { key: string; ctrlKey: boolean; metaKey: boolean }) => boolean,
): ProjectPickerDom {
  const popover = createPickerPopover(container, {
    className: 'project-picker',
    label: PROJECT_PICKER_LABEL,
    onKey,
  })

  const rowNode = (row: ProjectPickerRow): HTMLElement => {
    const classes = ['project-picker-row']
    if (row.selected) classes.push('selected')
    if (row.current) classes.push('current')
    const node = button(
      classes.join(' '),
      row.name,
      // The project this pane already runs in is not a destination — choosing it
      // closes, the way the branch picker answers its own current row.
      row.current ? '当前项目' : `在 ${row.name} 中新建会话`,
      () => onIntent(row.current ? { kind: 'close' } : { kind: 'pick', root: row.root }),
      { icon: 'folder' },
    )
    node.setAttribute('aria-current', String(row.current))
    if (row.current) node.appendChild(icon('check', 'icon branch-picker-check'))
    return node
  }

  let drawn: string | undefined

  return {
    focusPanel() {
      popover.focus()
    },
    render(view) {
      const signature = projectPickerSignature(view)
      if (signature === drawn) return
      drawn = signature
      popover.setOpen(view.open)
      // Inert immediately; rows leave only when the visual exit settles.
      if (!view.open) return
      popover.setBody(
        view.empty
          ? [el('div', 'project-picker-empty', PROJECT_PICKER_EMPTY)]
          : view.rows.map((row) => rowNode(row)),
      )
    },
  }
}
