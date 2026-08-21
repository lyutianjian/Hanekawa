import {
  SIDEBAR_HINT,
  activateRow,
  newSessionIntent,
  sidebarRenderSignature,
  type SidebarGroup,
  type SidebarIntent,
  type SidebarRow,
  type SidebarSection,
  type SidebarView,
} from '../model/sidebar.js'
import { el, replace, show } from './dom.js'
import { icon, type IconName } from './icons.js'

/**
 * The sidebar as DOM.
 *
 * Three fixed regions, following `design_guidance.md`'s two-column shell: a
 * header carrying the app mark and "new session", a scrolling middle of project
 * groups and age sections, and a footer with "open project…" (4d hangs settings
 * off the same footer). 4e restyles all of it; the structure is here so that
 * stage is a stylesheet rather than a rewrite.
 *
 * Every decision — which rows exist, what order they are in, what a keystroke
 * means, whether a row is asking for confirmation — belongs to
 * `model/sidebar.ts`. This file turns those into nodes and events, and owns
 * exactly two things the model cannot: the `keydown` that feeds
 * `sidebarKeyToIntent` only while focus is inside the sidebar, and the
 * `focusout` that withdraws a pending delete when the user's attention leaves.
 *
 * That second one is why no rank had to be added to `resolveKey`: a delete
 * confirmation scoped to sidebar focus cannot become a dialog that is drawn but
 * unanswerable, which is the trap the per-pane overlay rules exist to avoid.
 *
 * No `innerHTML` — session titles and project names are filesystem- and
 * model-authored. The `el()` helper is the enforcement.
 */

export type SidebarAction = (intent: SidebarIntent) => void

export interface SidebarDom {
  render(view: SidebarView): void
}

const BADGE_LABELS = {
  running: '运行中',
  'awaiting-input': '等待授权',
} as const

export function createSidebarView(
  container: HTMLElement,
  onIntent: SidebarAction,
  /**
   * Fed the raw chord; the caller maps it through `sidebarKeyToIntent` and
   * answers whether it consumed the key. A consumed key is also stopped from
   * bubbling — the global handler is on `document`, and letting an Enter through
   * would activate the row *and* send the composer's text.
   */
  onKey: (chord: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => boolean,
): SidebarDom {
  const header = el('div', 'sidebar-header')
  const list = el('div', 'sidebar-list')
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', '会话')
  // `tabindex` rather than relying on the row buttons: the arrow keys have to
  // work the moment the list is entered, including from a click on a heading.
  list.tabIndex = 0
  const footer = el('div', 'sidebar-footer')

  container.appendChild(header)
  container.appendChild(list)
  container.appendChild(footer)

  container.addEventListener('keydown', (event) => {
    const consumed = onKey({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    })
    if (!consumed) return
    event.preventDefault()
    // The global handler lives on `document`, so this is what keeps a consumed
    // Enter from also submitting the composer.
    event.stopPropagation()
  })

  container.addEventListener('focusout', (event) => {
    const next = event.relatedTarget
    // `null` means focus went nowhere, which is exactly what this view's own
    // `replace()` looks like — clicking 🗑 focuses that button, the repaint that
    // draws the confirmation destroys it, and treating that as "the user left"
    // cancelled the confirmation in the same frame it appeared. A real departure
    // lands on some other element.
    if (next === null) return
    if (next instanceof Node && container.contains(next)) return
    onIntent({ kind: 'cancel-delete' })
  })

  const rowNode = (row: SidebarRow, index: number, selected: boolean): HTMLElement => {
    const classes = ['session-row']
    if (row.active) classes.push('active')
    if (selected) classes.push('selected')
    if (row.lane !== undefined) classes.push('open')
    if (row.confirmingDelete) classes.push('confirming')

    const node = el('div', classes.join(' '))
    node.dataset.sessionId = row.sessionId
    node.dataset.index = String(index)
    node.setAttribute('role', 'option')
    node.setAttribute('aria-selected', String(row.active))

    if (row.confirmingDelete) {
      node.appendChild(el('span', 'session-confirm-text', '删除此会话？'))
      node.appendChild(
        button('session-confirm-yes', '删除', '确认删除', () =>
          onIntent({ kind: 'confirm-delete', projectRoot: row.projectRoot, sessionId: row.sessionId }),
        ),
      )
      node.appendChild(
        button('session-confirm-no', '取消', '取消删除', () => onIntent({ kind: 'cancel-delete' })),
      )
      return node
    }

    const open = el('button', 'session-open')
    open.type = 'button'
    open.title = `${row.title} · ${row.messageCount} 条消息`
    open.appendChild(el('span', 'session-title', row.title))
    if (row.badge !== 'none') {
      const badge = el('span', `session-badge ${row.badge}`)
      badge.setAttribute('aria-label', BADGE_LABELS[row.badge])
      badge.title = BADGE_LABELS[row.badge]
      badge.appendChild(icon('dot'))
      open.appendChild(badge)
    }
    // Through the model so a click and Enter cannot disagree about "open or
    // switch".
    open.addEventListener('click', () => onIntent(activateRow(row)))
    node.appendChild(open)

    const actions = el('div', 'session-actions')
    // No close button, deliberately (stage-4 decision 2): a session the user
    // clicked stays alive, and the resident cap is released by `paneBudget`
    // silently. "Close" would ask them to think about runtimes rather than
    // sessions — `Ctrl+W` is still there for the habit, and delete is the only
    // action on a row that means anything to them.
    actions.appendChild(
      button('session-delete', '', '删除会话', () =>
        onIntent({ kind: 'request-delete', sessionId: row.sessionId }),
        { icon: 'trash' },
      ),
    )
    node.appendChild(actions)
    return node
  }

  const sectionNode = (
    section: SidebarSection,
    indexOf: (row: SidebarRow) => number,
    selectedIndex: number,
  ): HTMLElement => {
    const wrapper = el('div', 'session-section')
    wrapper.appendChild(el('div', 'session-section-label', section.label))
    for (const row of section.rows) {
      const index = indexOf(row)
      wrapper.appendChild(rowNode(row, index, index === selectedIndex))
    }
    return wrapper
  }

  const groupNode = (
    group: SidebarGroup,
    showLabel: boolean,
    indexOf: (row: SidebarRow) => number,
    selectedIndex: number,
  ): HTMLElement => {
    const wrapper = el('div', `project-group${group.own ? ' own' : ''}`)
    if (showLabel) {
      const label = el('div', 'project-label', group.projectName)
      label.title = group.projectRoot
      wrapper.appendChild(label)
    }
    for (const section of group.sections) {
      wrapper.appendChild(sectionNode(section, indexOf, selectedIndex))
    }
    return wrapper
  }

  /**
   * The last drawn view's signature. The guard below is what makes this view
   * affordable: it repaints from `onShellChanged`, which fires on every
   * `SessionClient` snapshot change — including background-task `outputBytes`,
   * so a backgrounded `npm test` would otherwise rebuild every history row at
   * output-flush rate.
   */
  let drawn: string | undefined

  return {
    render(view) {
      const signature = sidebarRenderSignature(view)
      if (signature === drawn) return
      drawn = signature

      // One index lookup built per render, so the row → cursor mapping is the
      // view's flattened order rather than a per-group count that could drift.
      const indices = new Map<string, number>()
      view.rows.forEach((row, index) => indices.set(row.sessionId, index))
      const indexOf = (row: SidebarRow): number => indices.get(row.sessionId) ?? -1

      replace(
        header,
        el('span', 'sidebar-mark', 'Hanekawa'),
        button(
          'sidebar-new',
          '新建会话',
          '在当前项目里新建会话',
          // Through the model, so this and `Ctrl+T` cannot disagree about *which*
          // project — the same rule the row buttons follow via `activateRow`.
          () => onIntent(newSessionIntent(view.activeProjectRoot)),
          { enabled: view.canCreate, icon: 'plus' },
        ),
        button(
          'sidebar-collapse',
          '',
          view.collapsed ? '展开侧栏（Ctrl+B）' : '收起侧栏（Ctrl+B）',
          () => onIntent({ kind: 'toggle-collapse' }),
          { icon: view.collapsed ? 'chevron-right' : 'chevron-left' },
        ),
      )

      container.classList.toggle('collapsed', view.collapsed)
      // Collapsed hides the *contents*, not the rail: the toggle has to stay
      // reachable by mouse, or Ctrl+B becomes the only way back. Returning here
      // rather than after building means a collapsed sidebar builds no rows at
      // all — the guard above already banked the signature, so expanding
      // repaints.
      show(list, !view.collapsed)
      show(footer, !view.collapsed)
      if (view.collapsed) return

      replace(
        list,
        ...(view.isEmpty
          ? [el('div', 'sidebar-empty', '还没有会话。')]
          : view.groups.map((group) =>
              groupNode(group, view.showProjectLabels, indexOf, view.selectedIndex),
            )),
      )

      replace(
        footer,
        button('sidebar-open-project', '打开项目…', '打开另一个项目（Ctrl+Shift+O）', () =>
          onIntent({ kind: 'open-project' }),
          { enabled: view.canCreate, icon: 'folder' },
        ),
        el('div', 'sidebar-hint', SIDEBAR_HINT),
      )
    },
  }
}

function button(
  className: string,
  label: string,
  title: string,
  onClick: () => void,
  options: { enabled?: boolean; icon?: IconName } = {},
): HTMLButtonElement {
  const node = el('button', className)
  node.type = 'button'
  node.title = title
  node.setAttribute('aria-label', title)
  // Built up rather than assigned as `textContent`, because an icon child would
  // be wiped by it. An icon-only button passes an empty label and relies on the
  // `aria-label` above for its name.
  if (options.icon) node.appendChild(icon(options.icon))
  if (label) node.appendChild(el('span', 'btn-label', label))
  node.disabled = options.enabled === false
  node.addEventListener('click', (event) => {
    // Rows are clickable too; a button inside one must not also activate it.
    event.stopPropagation()
    onClick()
  })
  return node
}
