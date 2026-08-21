import type { RewindIntent, RewindViewModel } from '../model/rewindPanel.js'
import { el, replace, show } from './dom.js'

/**
 * The `/rewind` panel: a checkpoint list, then a confirm screen.
 *
 * Modal like `overlayView.ts`, but drawn into its own container and stacked
 * *below* it — a permission prompt that arrives while this is open has to be
 * answered first, because that one is holding the agent loop.
 *
 * Every decision is already made in the view model. Rows and options are
 * clickable and hand back a `RewindIntent`, the same shape the key map produces,
 * so `app.ts` has one code path for both (`sidebarView.ts` does this too).
 *
 * No `innerHTML`, and **no markdown**: a checkpoint label is the user's own
 * message, and this dialog is asking them to confirm destroying work. It shows
 * the bytes, the way the permission dialog's command block does.
 */
export interface RewindPanel {
  render(view: RewindViewModel): void
  hide(): void
  isOpen(): boolean
}

export type RewindActivate = (intent: RewindIntent) => void

export function createRewindView(
  container: HTMLElement,
  panel: HTMLElement,
  onIntent: RewindActivate,
): RewindPanel {
  let open = false

  return {
    render(view) {
      replace(
        panel,
        el('div', 'title', view.title),
        view.subtitle.length > 0 && el('div', 'subtitle', view.subtitle),
        view.error !== undefined && el('div', 'error', view.error),
        view.emptyMessage !== undefined && el('div', 'subtitle', view.emptyMessage),
        view.screen === 'select' ? selectScreen(view, onIntent) : confirmScreen(view, onIntent),
        el('div', 'hint', view.hint),
      )
      show(container, true)
      open = true
    },

    hide() {
      show(container, false)
      replace(panel)
      open = false
    },

    isOpen() {
      return open
    },
  }
}

function selectScreen(view: RewindViewModel, onIntent: RewindActivate): HTMLElement {
  const list = el('div', 'rows')
  list.setAttribute('role', 'listbox')
  for (const row of view.rows) {
    const node = el('div', `row${row.selected ? ' selected' : ''}${row.isCurrent ? ' current' : ''}`)
    node.dataset.rowId = row.id
    node.setAttribute('role', 'option')
    node.setAttribute('aria-selected', String(row.selected))
    node.appendChild(el('span', 'label', row.label))
    if (row.detail.length > 0) node.appendChild(el('span', 'value', row.detail))
    node.addEventListener('click', () => onIntent({ kind: 'select-row', id: row.id }))
    list.appendChild(node)
  }
  return list
}

function confirmScreen(view: RewindViewModel, onIntent: RewindActivate): HTMLElement {
  const body = el('div', 'confirm')
  body.appendChild(el('div', 'message', view.messagePreview))
  if (view.timeLabel.length > 0) body.appendChild(el('div', 'subtitle', view.timeLabel))
  body.appendChild(el('div', 'subtitle', view.codeEffect))

  if (view.busyLabel !== undefined) {
    // Options are withdrawn rather than disabled while a decision runs: the
    // panel is not accepting input at all, and leaving them clickable would say
    // otherwise.
    body.appendChild(el('div', 'busy', view.busyLabel))
    return body
  }

  const options = el('div', 'options')
  for (const option of view.options) {
    const node = el('div', `option${option.selected ? ' selected' : ''}`)
    node.dataset.decision = option.decision
    node.setAttribute('role', 'option')
    node.setAttribute('aria-selected', String(option.selected))
    node.appendChild(document.createTextNode(option.selected ? '> [' : '  ['))
    node.appendChild(el('span', 'hotkey', option.hotkey))
    node.appendChild(document.createTextNode(`] ${option.label}`))
    node.addEventListener('click', () => onIntent({ kind: 'choose', decision: option.decision }))
    options.appendChild(node)
  }
  body.appendChild(options)

  if (view.warning !== undefined) body.appendChild(el('div', 'warning', view.warning))
  return body
}
