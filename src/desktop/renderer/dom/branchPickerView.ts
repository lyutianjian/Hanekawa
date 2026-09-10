import {
  BRANCH_PICKER_EMPTY,
  BRANCH_PICKER_LABEL,
  BRANCH_PICKER_LOADING,
  branchPickerSignature,
  type BranchPickerIntent,
  type BranchPickerRow,
  type BranchPickerView,
} from '../model/branchPicker.js'
import { el } from './dom.js'
import { createPickerPopover } from './pickerPopover.js'
import { button } from './controls.js'
import { icon } from './icons.js'

/**
 * The branch switcher as DOM: a popover over the welcome screen's branch pill.
 *
 * Mounted inside the pill's own anchor and positioned by the stylesheet, not by
 * measured coordinates — the renderer may not write inline geometry, and an
 * anchor that is already the element the popover belongs to needs no maths.
 *
 * Unlike the workspace picker it replaced there is no persistent search input,
 * so the whole subtree is rebuilt on every signature change and nothing here
 * holds a caret. The panel, its presence and the scoped keydown are
 * `dom/pickerPopover.ts`'s — shared with the project switcher beside it — and
 * what is left here is the part that is about branches: the rows, the tick, and
 * the three mutually exclusive states the list can be in.
 *
 * Every decision is `model/branchPicker.ts`'s, including which rows exist and
 * whether the list is still loading.
 */

export interface BranchPickerDom {
  render(view: BranchPickerView): void
  /** Puts focus on the popover, for the click that opened it. */
  focusPanel(): void
}

export function createBranchPickerView(
  container: HTMLElement,
  onIntent: (intent: BranchPickerIntent) => void,
  /**
   * Fed the raw chord; the caller maps it through `branchPickerKeyToIntent` and
   * answers whether it consumed the key. A consumed key is also stopped from
   * bubbling — the global handler is on `document`.
   */
  onKey: (chord: { key: string; ctrlKey: boolean; metaKey: boolean }) => boolean,
): BranchPickerDom {
  const popover = createPickerPopover(container, {
    className: 'branch-picker',
    label: BRANCH_PICKER_LABEL,
    onKey,
  })

  const rowNode = (row: BranchPickerRow, switching: boolean): HTMLElement => {
    const classes = ['branch-picker-row']
    if (row.selected) classes.push('selected')
    if (row.current) classes.push('current')
    const node = button(
      classes.join(' '),
      row.name,
      // The branch HEAD is already on is not a destination — choosing it closes.
      row.current ? '当前分支' : `切换到 ${row.name}`,
      () => onIntent(row.current ? { kind: 'close' } : { kind: 'pick', branch: row.name }),
      { icon: 'branch', ...(switching ? { enabled: false } : {}) },
    )
    node.setAttribute('aria-current', String(row.current))
    // The tick trails the label, the way a menu check does — the same mark the
    // runtime chip's flyout uses for "this is the one in force".
    if (row.current) node.appendChild(icon('check', 'icon branch-picker-check'))
    return node
  }

  let drawn: string | undefined

  return {
    focusPanel() {
      popover.focus()
    },
    render(view) {
      const signature = branchPickerSignature(view)
      if (signature === drawn) return
      drawn = signature
      popover.setOpen(view.open)
      if (!view.open) {
        // Inert immediately; rows leave only when the visual exit settles.
        return
      }

      const children: HTMLElement[] = []
      if (view.loading) {
        children.push(el('div', 'branch-picker-empty', BRANCH_PICKER_LOADING))
      } else if (view.empty) {
        children.push(el('div', 'branch-picker-empty', BRANCH_PICKER_EMPTY))
      } else {
        children.push(...view.rows.map((row) => rowNode(row, view.switching)))
      }
      // Under the rows rather than in place of them: git's refusal names the
      // files in the way, and the list the user was choosing from is still the
      // thing they are looking at.
      if (view.error !== undefined) {
        children.push(el('div', 'branch-picker-error', view.error))
      }
      popover.setBody(children)
    },
  }
}
