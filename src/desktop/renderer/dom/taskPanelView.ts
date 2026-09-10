import type { TaskPanelState } from '../model/tasks.js'
import { button } from './controls.js'
import { el, reconcile } from './dom.js'
import { createPresence } from './presence.js'

/**
 * The task panel: the model's checklist, drawn in flow directly above the
 * composer (`activity_group_design.md` §7.2).
 *
 * In flow, and **not** inside `#composer-popovers`: those three panels are
 * transient overlays with their own stacking and `pointer-events: none` shell,
 * and a resident strip parked among them would fight both. Sharing the
 * composer's axis is the point — the checklist reads as part of the thing the
 * user types into, not as the tail of the transcript.
 *
 * Read-only. The list belongs to the model, so no row is a control; the one
 * control here is the head, which folds the list. Its open/closed state is
 * renderer-local and lives in this view: nothing outside the window has an
 * opinion about it, and it must survive the repaint that every arriving record
 * causes.
 *
 * With no checklist the panel does not *exist* rather than sitting empty: the
 * host is emptied, and the next appearance plays `rise-in` once. Which is also
 * why the panel node is reused across renders — an entrance animation on a node
 * rebuilt per streamed token would replay forever.
 */

export interface TaskPanelDom {
  render(state: TaskPanelState | undefined): void
  /**
   * A one-shot outline pulse. The transcript's `TodoWrite` step points here
   * instead of drawing the list a second time inside the activity group (§7.3).
   */
  flash(): void
  hide(): void
}

export function createTaskPanelView(container: HTMLElement): TaskPanelDom {
  let panel: ReturnType<typeof buildPanel> | undefined
  let expanded = false
  let latest: TaskPanelState | undefined

  function buildPanel() {
    const node = el('div', 'task-panel')
    // Registered once, on the node that outlives every render: `flash()` adds
    // the class and this takes it off again, so a second pulse is possible.
    node.addEventListener('animationend', (event) => {
      if (event.target === node && event.animationName === 'task-flash') node.classList.remove('flash')
    })
    const track = progressBar()
    const count = el('span', 'task-count')
    const current = el('span', 'task-current')
    const head = button('task-panel-head', '', '', () => {
      expanded = !expanded
      if (latest) paint(latest)
    })
    reconcile(head, [count, current])
    const list = el('div', 'task-list')
    const presence = createPresence(list, { kind: 'disclosure', direction: 'none', property: 'height', onClosed: () => list.remove() })
    const rows = new Map<string, { node: HTMLElement; bead: HTMLElement; label: HTMLElement }>()
    reconcile(container, [node])
    return { node, track, head, count, current, list, presence, rows, ratio: undefined as number | undefined }
  }

  const paint = (state: TaskPanelState): void => {
    latest = state
    const parts = panel ??= buildPanel()
    const { node, track, head, count, current, list, rows } = parts
    // The completed share, handed to the sheet as a number: the fill resolves
    // its own width from it, so the only thing TypeScript writes is a custom
    // property — the one door into the style attribute the renderer may use,
    // and it is spelled inline because a constant would be a name the style
    // test cannot follow.
    if (parts.ratio !== state.ratio) {
      node.style.setProperty('--task-progress', String(state.ratio))
      parts.ratio = state.ratio
    }
    node.classList.toggle('collapsed', !expanded)

    const name = headName(state, expanded)
    head.title = name
    head.setAttribute('aria-label', name)
    head.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    const countText = `${state.counts.completed}/${state.counts.total}`
    if (count.textContent !== countText) count.textContent = countText
    const currentText = currentLabel(state)
    if (current.textContent !== currentText) current.textContent = currentText

    const live = new Set<string>()
    const children = state.tasks.map((task) => {
      live.add(task.id)
      let row = rows.get(task.id)
      if (!row) {
        const bead = el('span', 'task-bead')
        bead.setAttribute('aria-hidden', 'true')
        const label = el('span', 'task-label')
        row = { node: el('div', 'task-row', bead, label), bead, label }
        rows.set(task.id, row)
      }
      row.node.className = `task-row ${task.status}`
      row.bead.className = `task-bead ${task.status}`
      if (row.label.textContent !== task.label) row.label.textContent = task.label
      return row.node
    })
    reconcile(list, children)
    for (const id of rows.keys()) if (!live.has(id)) rows.delete(id)
    reconcile(node, [track, head, expanded || parts.presence.phase !== 'closed' ? list : undefined])
    parts.presence.set(expanded)
  }

  const hide = (): void => {
    panel?.presence.dispose()
    panel = undefined
    latest = undefined
    expanded = false
    reconcile(container, [])
  }

  return {
    render(state) {
      if (!state) hide()
      else paint(state)
    },

    flash() {
      panel?.node.classList.add('flash')
    },

    hide,
  }
}

/**
 * A track and a fill, both hairlines: the fill is a 2px `border-top` rather than
 * a background, because an accent may rule a line but may not fill a surface —
 * the three exceptions to that are named in `rendererStyleTokens.test.ts` and
 * this is not one of them.
 */
function progressBar(): HTMLElement {
  const track = el('div', 'task-progress')
  track.setAttribute('aria-hidden', 'true')
  track.appendChild(el('div', 'task-progress-fill'))
  return track
}

/**
 * A finished list keeps saying so for the rest of the turn (§7.3) — the model
 * retires it on the next user message, not the view.
 */
function currentLabel(state: TaskPanelState): string {
  if (state.allDone) return '全部完成'
  return state.activeTask?.label ?? state.tasks.find((task) => task.status === 'pending')?.label ?? ''
}

function headName(state: TaskPanelState, open: boolean): string {
  const parts = ['任务', `${state.counts.completed}/${state.counts.total}`, currentLabel(state)]
  return `${parts.filter((part) => part.length > 0).join(' · ')}（${open ? '收起' : '展开'}）`
}
