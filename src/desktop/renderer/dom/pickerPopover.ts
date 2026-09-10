import { el, replace } from './dom.js'
import { createPresence } from './presence.js'

/**
 * The shell every pill popover on the welcome screen shares.
 *
 * Extracted from `dom/branchPickerView.ts` when the project pill became a
 * switcher too: the two popovers differ only in their rows and in what a row
 * means, and everything around the rows — the dialog panel, its presence, the
 * scoped keydown, taking focus when it opens — was the same code twice.
 *
 * Three things here are load-bearing and are the reason this is one module
 * rather than two similar ones:
 *
 * 1. **The panel is focusable but not a Tab stop.** It has to take focus when it
 *    opens — that is what makes `focusout` a dismissal at all — and it must not
 *    become a stop on the way from the pills to the composer once it is closed.
 * 2. **The keydown is scoped to the anchor, not to `document`.** Escape has to
 *    unwind the popover rather than interrupt the turn, and Enter has to pick a
 *    row rather than send the composer's text. The caller maps the chord and
 *    answers whether it consumed the key; a consumed key is also stopped, since
 *    the global handler is on `document`.
 * 3. **The body is emptied by presence, not by the close.** Rows leave when the
 *    exit settles, so a closing popover animates over its own contents instead
 *    of over a blank card.
 *
 * The class name is the caller's, so the two popovers keep names that say what
 * they are (`branch-picker`, `project-picker`) and the stylesheet groups them.
 */

export interface PickerPopover {
  /** Puts focus on the panel, for the click that opened it. */
  focus(): void
  /** Mounts or unmounts the popover; the body is cleared when the exit settles. */
  setOpen(open: boolean): void
  /** Replaces the rows. Only meaningful while open — a closed popover draws nothing. */
  setBody(children: readonly HTMLElement[]): void
}

export function createPickerPopover(
  container: HTMLElement,
  options: {
    /** The popover's own class, e.g. `'branch-picker'`. Rows are the caller's. */
    className: string
    /** The dialog's accessible name — 「切换分支」/「切换项目」. */
    label: string
    /**
     * Fed the raw chord; the caller maps it through its own `…KeyToIntent` and
     * answers whether it consumed the key.
     */
    onKey: (chord: { key: string; ctrlKey: boolean; metaKey: boolean }) => boolean
  },
): PickerPopover {
  const body = el('div', `${options.className}-body`)
  const panel = el('div', options.className)
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', options.label)
  panel.tabIndex = -1
  panel.appendChild(body)
  container.appendChild(panel)
  const presence = createPresence(panel, { onClosed: () => replace(body) })

  container.addEventListener('keydown', (event) => {
    const consumed = options.onKey({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    })
    if (!consumed) return
    event.preventDefault()
    event.stopPropagation()
  })

  return {
    focus() {
      panel.focus()
    },
    setOpen(open) {
      presence.set(open)
    },
    setBody(children) {
      replace(body, ...children)
    },
  }
}
