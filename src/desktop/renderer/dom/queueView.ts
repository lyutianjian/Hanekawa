import type { QueuedMessagesView } from '../model/queuedMessages.js'
import { el, replace } from './dom.js'
import { createPresence } from './presence.js'

/**
 * The queued-message strip as DOM.
 *
 * One row per waiting message plus a Clear button. Read-only otherwise: there is
 * deliberately no per-row remove, because the wire has no `dequeue` — the host
 * pumps its own queue, and a client popping from it would race that pump.
 *
 * Clear is a button rather than a key chord on purpose. The terminal clears the
 * queue with Escape-Escape while streaming, which is discoverable there because
 * the footer lists it; here a visible control avoids adding a third meaning to
 * Escape, which already has to answer a dialog before it interrupts
 * (`model/keymap.ts`).
 *
 * No `innerHTML`: the labels are whatever the user typed.
 */

export interface QueueDom {
  render(view: QueuedMessagesView): void
  hide(): void
}

export function createQueueView(container: HTMLElement, onClear: () => void): QueueDom {
  const presence = createPresence(container, { onClosed: () => replace(container) })
  let signature: string | undefined
  return {
    render(view) {
      const next = JSON.stringify(view)
      if (signature === next) return
      signature = next
      if (view.title === undefined) {
        presence.set(false)
        return
      }

      const header = el('div', 'queue-header')
      header.appendChild(el('span', 'queue-title', view.title))
      const clear = el('button', 'queue-clear')
      clear.type = 'button'
      clear.textContent = view.clearLabel
      clear.setAttribute('aria-label', '清空排队消息')
      clear.addEventListener('click', onClear)
      header.appendChild(clear)

      replace(
        container,
        header,
        ...view.rows.map((row) => {
          const node = el('div', 'queue-row')
          node.appendChild(el('span', 'queue-position', `${row.position}.`))
          node.appendChild(el('span', 'queue-label', row.label))
          return node
        }),
      )
      presence.set(true)
    },

    hide() {
      signature = undefined
      presence.set(false)
    },
  }
}
