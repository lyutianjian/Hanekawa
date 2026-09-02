import {
  SIDEBAR_COLLAPSE_FALLBACK_MS,
  SIDEBAR_HINT,
  activateRow,
  newSessionIntent,
  sidebarContentMounted,
  sidebarRenderSignature,
  type SidebarGroup,
  type SidebarIntent,
  type SidebarRow,
  type SidebarView,
} from '../model/sidebar.js'
import { el, replace, show } from './dom.js'
import { button, textField } from './controls.js'
import { icon } from './icons.js'

/**
 * The sidebar as DOM.
 *
 * Four fixed regions, following `design_guidance.md` 三.2 top to bottom: the
 * session search box, the first-level actions, a scrolling middle of workspace
 * groups, and a footer carrying 设置 and the `?` panel. All four live in one
 * shell held at the open width; the stylesheet takes `#sidebar` around it to zero
 * — the one collapse control is the title bar's `.titlebar-rail`.
 *
 * The fold is the third thing this file owns that the model cannot: the phase
 * comes in on the view, but the *evidence* that a move finished is a
 * `transitionend` (or the timer standing in for one that never ran), and both are
 * DOM. It reports them back as `collapse-settled` and lets `nextCollapsePhase`
 * decide what they mean.
 *
 * The header that used to sit above the search box is gone with the workspace
 * dropdown it held: every workspace now has a heading *in the list*, so a control
 * whose job was to choose which one you could see had nothing left to do.
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
  /**
   * Moves focus to one workspace's heading and scrolls it into view.
   *
   * The reveal path for something outside the sidebar that names a project — the
   * welcome screen's Hero project name. Focus rather than a highlight, because
   * the heading is a real button and the next Tab or Enter should be about the
   * group the user just asked for.
   */
  focusProject(projectRoot: string): void
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
  // Persistent, not rebuilt by `render()`: the sidebar repaints on every shell
  // snapshot, and re-creating the input on each pass would drop the caret and the
  // focus mid-search. `app.ts` holds the query as the source of truth, so this
  // never has its `value` written back — it only reports edits outward.
  const search = textField({
    className: 'sidebar-search',
    value: '',
    ariaLabel: '搜索会话',
    placeholder: '搜索会话…',
    onCommit: (value) => onIntent({ kind: 'search', query: value }),
  })
  search.addEventListener('input', () => onIntent({ kind: 'search', query: search.value }))
  // The first-level actions, between the search box and the history. A row, not
  // a bordered pill: it belongs to the same column of destinations the session
  // rows are in (design_guidance 三.2).
  const nav = el('div', 'sidebar-nav')
  const list = el('div', 'sidebar-list')
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', '会话')
  // `tabindex` rather than relying on the row buttons: the arrow keys have to
  // work the moment the list is entered, including from a click on a heading.
  list.tabIndex = 0
  const footer = el('div', 'sidebar-footer')

  // The four regions live in a shell held at the open width rather than directly
  // in `#sidebar`, which is the element that animates. A flex column narrowing
  // to zero reflows on every frame; the shell keeps its 280px, `#sidebar` crops
  // it, and the collapse is a slide rather than a re-wrap. See `styles.css`.
  const shell = el('div', 'sidebar-shell')
  shell.appendChild(search)
  shell.appendChild(nav)
  shell.appendChild(list)
  shell.appendChild(footer)
  container.appendChild(shell)

  /**
   * The fallback timer for the fold, and the only thing here that needs
   * clearing.
   *
   * The `transitionend` listener below is installed once and never removed —
   * one listener that consults the current phase cannot accumulate, which is the
   * leak an add/remove pair per toggle exists to avoid. The timer is per move,
   * so an unfired one from the move being superseded is cancelled here.
   */
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  const clearSettleTimer = (): void => {
    if (settleTimer === undefined) return
    clearTimeout(settleTimer)
    settleTimer = undefined
  }

  container.addEventListener('transitionend', (event) => {
    // Only the sidebar's own width: the rows inside it transition too (hover
    // colours, the shell's own fade), and every one of those bubbles to here.
    if (event.target !== container) return
    if (event.propertyName !== 'flex-basis') return
    clearSettleTimer()
    onIntent({ kind: 'collapse-settled' })
  })

  container.addEventListener('keydown', (event) => {
    // The search box lives inside the sidebar, so its keystrokes bubble to this
    // handler — and Backspace/arrows/Enter there mean "edit the query", not
    // "delete a row" or "move the cursor". Let the input own its own keys.
    if (event.target === search) return
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

  /** The group headings from the last render, so `focusProject` can reach one. */
  const projectHeadings = new Map<string, HTMLButtonElement>()

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
    // The heading's question and its context menu are scoped to sidebar focus
    // for the same reason the row's confirmation is: neither may survive as a
    // dialog drawn where nothing can answer it.
    onIntent({ kind: 'cancel-remove-project' })
    onIntent({ kind: 'open-project-menu', projectRoot: undefined })
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

    // One construction path, confirming or not: the confirmation used to replace
    // the whole row, which took the session's name off screen at exactly the
    // moment the user had to decide *which* session they were deleting (S7/D6).
    // Only the right-hand actions swap; the name, the badge and the truncation
    // are one decision each, as they are in `model/sidebar.ts`.
    const open = el('button', 'session-open')
    open.type = 'button'
    open.title = `${row.title} · ${row.messageCount} 条消息`
    open.appendChild(el('span', 'session-title', row.title))
    if (row.badge !== 'none') {
      const badge = el('span', `session-badge ${row.badge}`)
      badge.setAttribute('aria-label', BADGE_LABELS[row.badge])
      badge.title = BADGE_LABELS[row.badge]
      // Running spins; awaiting-input is a still dot. The spinner is stroked so
      // the `.running` colour rule reaches it through `currentColor`.
      badge.appendChild(icon(row.badge === 'running' ? 'spinner' : 'dot'))
      open.appendChild(badge)
    }
    if (row.confirmingDelete) {
      // Disabled rather than merely unlistened: the row is asking a question, and
      // a name that still looks clickable invites an answer it will not give.
      open.disabled = true
    } else {
      // Through the model so a click and Enter cannot disagree about "open or
      // switch".
      open.addEventListener('click', () => onIntent(activateRow(row)))
    }
    node.appendChild(open)

    const actions = el('div', 'session-actions')
    // No close button, deliberately (stage-4 decision 2): a session the user
    // clicked stays alive, and the resident cap is released by `paneBudget`
    // silently. "Close" would ask them to think about runtimes rather than
    // sessions — `Ctrl+W` is still there for the habit, and delete is the only
    // action on a row that means anything to them.
    if (row.confirmingDelete) {
      // The question is carried by the two buttons and the row's own surface, not
      // by a sentence: at 268px a "删除此会话？" label and a title cannot both fit,
      // and the title is the half only the user can supply.
      actions.appendChild(
        button('session-confirm-yes', '删除', '确认删除', () =>
          onIntent({ kind: 'confirm-delete', projectRoot: row.projectRoot, sessionId: row.sessionId }),
        ),
      )
      actions.appendChild(
        button('session-confirm-no', '取消', '取消删除', () => onIntent({ kind: 'cancel-delete' })),
      )
    } else {
      actions.appendChild(
        button('session-delete', '', '删除会话', () =>
          onIntent({ kind: 'request-delete', sessionId: row.sessionId }),
          { icon: 'trash' },
        ),
      )
    }
    node.appendChild(actions)
    return node
  }

  /**
   * One workspace: a heading that folds the group, a `+`, and its rows.
   *
   * The heading is a real `<button>` rather than the `<div>` label it replaced —
   * it toggles, and it is the target `focusProject` reveals to. Drawn for a
   * single project too: the workspace is the sidebar's only grouping axis now, so
   * hiding the heading when there is one of them would hide *what the axis is*.
   * Drawn for an *empty* project too, which is the whole point of the group
   * surviving its last session: the project is a place to come back to, not a
   * label on a pile of sessions.
   *
   * The heading and the `+` are siblings inside `.project-row` rather than
   * nested, because a `<button>` cannot contain a `<button>` — which is also why
   * the count that used to live inside the heading could be a `<span>` and its
   * replacement cannot.
   */
  const groupNode = (
    group: SidebarGroup,
    indexOf: (row: SidebarRow) => number,
    selectedIndex: number,
    canCreate: boolean,
  ): HTMLElement => {
    const wrapper = el(
      'div',
      `project-group${group.collapsed ? ' collapsed' : ''}`,
    )
    const headingRow = el('div', 'project-row')
    const heading = button(
      'project-heading',
      group.projectName,
      group.projectRoot,
      () => onIntent({ kind: 'toggle-project', projectRoot: group.projectRoot }),
      // Leading glyph, and it points where the fold goes: `⌄` for an open group,
      // `›` for a shut one.
      { icon: group.collapsed ? 'chevron-right' : 'chevron-down' },
    )
    heading.setAttribute('aria-expanded', String(!group.collapsed))
    projectHeadings.set(group.projectRoot, heading)
    headingRow.appendChild(heading)

    const actions = el('div', 'project-actions')
    if (group.confirmingRemove) {
      // The same two-button answer a session row gives, and for the same reason
      // the question is not spelled out: the project name is right there, and it
      // is the half only the user can supply.
      actions.appendChild(
        button('session-confirm-yes', '移除', '从侧边栏移除此项目', () =>
          onIntent({ kind: 'confirm-remove-project', projectRoot: group.projectRoot }),
        ),
      )
      actions.appendChild(
        button('session-confirm-no', '取消', '取消移除', () =>
          onIntent({ kind: 'cancel-remove-project' }),
        ),
      )
    } else {
      // Replaces the session count. A number told the user something they could
      // already see; this is the action they came to the heading for.
      actions.appendChild(
        button('project-new', '', `在 ${group.projectName} 新建会话`, () =>
          onIntent(newSessionIntent(group.projectRoot)),
          { enabled: canCreate, icon: 'plus' },
        ),
      )
    }
    headingRow.appendChild(actions)

    // The global workspace has no registry entry to forget, so it has no menu —
    // and `isGlobal` comes off the wire rather than from matching the display
    // name, which the renderer is not allowed to do.
    if (!group.isGlobal) {
      headingRow.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        onIntent({ kind: 'open-project-menu', projectRoot: group.projectRoot })
      })
    }
    wrapper.appendChild(headingRow)

    if (group.menuOpen) {
      const menu = el('div', 'project-menu')
      menu.setAttribute('role', 'menu')
      menu.appendChild(
        button('project-menu-item', '从侧边栏移除', '从侧边栏移除此项目（会话文件保留）', () =>
          onIntent({ kind: 'request-remove-project', projectRoot: group.projectRoot }),
        ),
      )
      wrapper.appendChild(menu)
    }

    if (!group.collapsed) {
      for (const row of group.rows) {
        const index = indexOf(row)
        wrapper.appendChild(rowNode(row, index, index === selectedIndex))
      }
      // A project kept for its own sake rather than for its sessions has to say
      // so; an empty group with nothing under the heading reads as a load that
      // has not finished.
      if (group.rows.length === 0) wrapper.appendChild(el('div', 'project-empty', '还没有会话'))
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
    focusProject(projectRoot) {
      const heading = projectHeadings.get(projectRoot)
      if (!heading) return
      heading.scrollIntoView({ block: 'nearest' })
      heading.focus()
    },
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
        nav,
        button(
          'sidebar-nav-item',
          '新建会话',
          '在当前项目里新建会话（Ctrl+T）',
          // Through the model, so this and `Ctrl+T` cannot disagree about *which*
          // project — the same rule the row buttons follow via `activateRow`.
          () => onIntent(newSessionIntent(view.activeProjectRoot)),
          { enabled: view.canCreate, icon: 'plus' },
        ),
        button(
          'sidebar-nav-item',
          '打开项目…',
          '打开另一个项目（Ctrl+Shift+O）',
          () => onIntent({ kind: 'open-project' }),
          { enabled: view.canCreate, icon: 'folder' },
        ),
      )

      // The class goes on at the *start* of the collapse and comes off at the
      // start of the expansion — it is what the width transitions between, so it
      // follows the moving phase rather than the settled one.
      const shut = view.collapsePhase === 'collapsing' || view.collapsePhase === 'collapsed'
      container.classList.toggle('collapsed', shut)

      // Arm the fallback the moment a move starts, and disarm it the moment one
      // rests. A move that supersedes another lands here too, so the timer that
      // belonged to the interrupted move never outlives it.
      clearSettleTimer()
      if (view.collapsePhase === 'collapsing' || view.collapsePhase === 'expanding') {
        settleTimer = setTimeout(() => {
          settleTimer = undefined
          onIntent({ kind: 'collapse-settled' })
        }, SIDEBAR_COLLAPSE_FALLBACK_MS)
      }

      // The rail that used to survive a collapse existed only so this view's own
      // toggle stayed reachable by mouse; that toggle now lives in the title bar,
      // which a collapsed sidebar does not touch. Unmounting waits for the fold
      // to *finish*: taken out on the click, the collapse would be a fade of an
      // empty column. Returning here rather than after building means a settled
      // collapse builds no rows at all — the guard above already banked the
      // signature, so expanding repaints.
      const mounted = sidebarContentMounted(view.collapsePhase)
      show(shell, mounted)
      if (!mounted) return

      // Rebuilt from the groups actually drawn, so a heading that is gone cannot
      // be revealed and a stale node cannot be focused into a detached tree.
      projectHeadings.clear()
      replace(
        list,
        ...(view.isEmpty
          ? [el('div', 'sidebar-empty', '还没有会话。')]
          : view.noMatches
            ? [el('div', 'sidebar-empty', '没有匹配的会话。')]
            : view.groups.map((group) =>
                groupNode(group, indexOf, view.selectedIndex, view.canCreate),
              )),
      )

      // A profile row and a `?`, side by side, with the chord list behind the `?`
      // rather than printed under them (design_guidance 三.2). "Open project…"
      // moved up to the nav block, where it reads as an action rather than as
      // part of the personal corner.
      const footerRow = el('div', 'sidebar-footer-row')
      // Always enabled, unlike the nav items: settings is a window-level screen
      // and does not need a project to be open to be reached.
      footerRow.appendChild(
        button('sidebar-settings', '设置', '打开设置（Ctrl+,）', () =>
          onIntent({ kind: 'open-settings' }),
          { icon: 'gear' },
        ),
      )
      footerRow.appendChild(
        button(
          `sidebar-help${view.helpOpen ? ' open' : ''}`,
          '',
          view.helpOpen ? '收起快捷键' : '快捷键',
          () => onIntent({ kind: 'toggle-help' }),
          { icon: 'help' },
        ),
      )
      replace(
        footer,
        ...(view.helpOpen ? [el('div', 'sidebar-hint', SIDEBAR_HINT)] : []),
        footerRow,
      )
    },
  }
}

