import type { TaskPanelState } from '../model/tasks.js'
import { button } from './controls.js'
import { el, replace } from './dom.js'

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
  let panel: HTMLElement | undefined
  let expanded = false

  const ensurePanel = (): HTMLElement => {
    if (panel) return panel
    const node = el('div', 'task-panel')
    // Registered once, on the node that outlives every render: `flash()` adds
    // the class and this takes it off again, so a second pulse is possible.
    node.addEventListener('animationend', () => node.classList.remove('flash'))
    panel = node
    replace(container, node)
    return node
  }

  const paint = (state: TaskPanelState): void => {
    const node = ensurePanel()
    // The completed share, handed to the sheet as a number: the fill resolves
    // its own width from it, so the only thing TypeScript writes is a custom
    // property — the one door into the style attribute the renderer may use,
    // and it is spelled inline because a constant would be a name the style
    // test cannot follow.
    node.style.setProperty('--task-progress', String(state.ratio))
    node.classList.toggle('collapsed', !expanded)

    const head = button('task-panel-head', '', headName(state, expanded), () => {
      expanded = !expanded
      paint(state)
    })
    head.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    head.appendChild(el('span', 'task-count', `${state.counts.completed}/${state.counts.total}`))
    head.appendChild(el('span', 'task-current', currentLabel(state)))

    replace(node, progressBar(), head, expanded ? taskList(state) : undefined)
  }

  const hide = (): void => {
    panel = undefined
    expanded = false
    replace(container)
  }

  return {
    render(state) {
      if (!state) hide()
      else paint(state)
    },

    flash() {
      panel?.classList.add('flash')
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

function taskList(state: TaskPanelState): HTMLElement {
  const list = el('div', 'task-list')
  for (const task of state.tasks) {
    const row = el('div', `task-row ${task.status}`)
    const bead = el('span', `task-bead ${task.status}`)
    // Same contract as the step bead (§3): the dot is the picture, the word is
    // in the row's text, and colour is never the only carrier.
    bead.setAttribute('aria-hidden', 'true')
    row.appendChild(bead)
    row.appendChild(el('span', 'task-label', task.label))
    list.appendChild(row)
  }
  return list
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
