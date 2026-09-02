import {
  WORKSPACE_PICKER_NEW_PROJECT,
  WORKSPACE_PICKER_NO_MATCHES,
  WORKSPACE_PICKER_NO_PROJECT,
  WORKSPACE_PICKER_SEARCH_PLACEHOLDER,
  workspacePickerSignature,
  type WorkspacePickerIntent,
  type WorkspacePickerRow,
  type WorkspacePickerView,
} from '../model/workspacePicker.js'
import { el, replace, show } from './dom.js'
import { button, textField } from './controls.js'
import { icon } from './icons.js'

/**
 * The workspace picker as DOM: a popover over the welcome screen's Hero.
 *
 * Mounted inside the Hero's own row and positioned by the stylesheet, not by
 * measured coordinates — the renderer may not write inline geometry, and an
 * anchor that is already the element the popover belongs to needs no maths.
 *
 * Two things belong here and nowhere else. The search input is **persistent**:
 * the welcome screen repaints once per streamed token, and an input rebuilt on
 * each pass would drop the caret between keystrokes — the same reason
 * `sidebarView` keeps its search box outside `render()`. And the keydown is
 * scoped to this subtree, so Escape unwinds the popover instead of interrupting
 * the turn and Enter picks a row instead of sending the composer's text.
 *
 * Every decision is `model/workspacePicker.ts`'s, including which rows exist and
 * whether「不在项目中工作」is offered at all.
 */

export interface WorkspacePickerDom {
  render(view: WorkspacePickerView): void
  /** Puts the caret in the search box — the picker's entry point. */
  focusSearch(): void
}

export function createWorkspacePickerView(
  container: HTMLElement,
  onIntent: (intent: WorkspacePickerIntent) => void,
  /**
   * Fed the raw chord; the caller maps it through `workspacePickerKeyToIntent`
   * and answers whether it consumed the key. A consumed key is also stopped
   * from bubbling — the global handler is on `document`.
   */
  onKey: (chord: { key: string; ctrlKey: boolean; metaKey: boolean }) => boolean,
): WorkspacePickerDom {
  const search = textField({
    className: 'workspace-picker-search',
    value: '',
    ariaLabel: WORKSPACE_PICKER_SEARCH_PLACEHOLDER,
    placeholder: WORKSPACE_PICKER_SEARCH_PLACEHOLDER,
    onCommit: (value) => onIntent({ kind: 'search', query: value }),
  })
  search.addEventListener('input', () => onIntent({ kind: 'search', query: search.value }))

  const body = el('div', 'workspace-picker-body')
  const panel = el('div', 'workspace-picker')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', '选择工作区')
  panel.appendChild(search)
  panel.appendChild(body)
  container.appendChild(panel)

  container.addEventListener('keydown', (event) => {
    const consumed = onKey({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    })
    if (!consumed) return
    event.preventDefault()
    event.stopPropagation()
  })

  const rowNode = (row: WorkspacePickerRow): HTMLElement => {
    const classes = ['workspace-picker-row']
    if (row.selected) classes.push('selected')
    if (row.current) classes.push('current')
    const node = button(
      classes.join(' '),
      row.projectName,
      // The current project is not a destination — picking it reveals the
      // sidebar group instead, which is what the Hero's name used to do alone.
      row.current ? '在侧栏中定位该工作区' : `在 ${row.projectName} 新建会话`,
      () =>
        onIntent(
          row.current
            ? { kind: 'reveal', projectRoot: row.projectRoot }
            : { kind: 'pick', projectRoot: row.projectRoot },
        ),
      { icon: 'folder' },
    )
    node.setAttribute('aria-current', String(row.current))
    // The tick trails the label, the way a menu check does — `check` is the
    // same mark the runtime chip's flyout uses for "this is the one in force".
    if (row.current) node.appendChild(icon('check', 'icon workspace-picker-check'))
    return node
  }

  let drawn: string | undefined

  return {
    focusSearch() {
      search.focus()
    },
    render(view) {
      const signature = workspacePickerSignature(view)
      if (signature === drawn) return
      drawn = signature
      show(panel, view.open)
      if (!view.open) {
        // Rows are dropped rather than hidden: a closed popover that keeps its
        // buttons is a Tab stop the user cannot see. The search box survives —
        // it is the node whose caret this view exists to protect — and is
        // cleared so the next open starts on the whole list.
        replace(body)
        search.value = ''
        return
      }

      const children: HTMLElement[] = view.noMatches
        ? [el('div', 'workspace-picker-empty', WORKSPACE_PICKER_NO_MATCHES)]
        : view.rows.map(rowNode)

      const actions = el('div', 'workspace-picker-actions')
      actions.appendChild(
        button(
          'workspace-picker-action',
          WORKSPACE_PICKER_NEW_PROJECT,
          '打开一个目录作为项目',
          () => onIntent({ kind: 'new-project' }),
          { icon: 'plus' },
        ),
      )
      if (view.canLeaveProject) {
        actions.appendChild(
          button(
            'workspace-picker-action',
            WORKSPACE_PICKER_NO_PROJECT,
            '在全局工作区新建会话',
            () => onIntent({ kind: 'no-project' }),
            { icon: 'close' },
          ),
        )
      }
      children.push(actions)
      replace(body, ...children)
    },
  }
}
