import type { CanvasHeaderMenuItem, CanvasHeaderView } from '../model/canvasHeader.js'
import { renameCommit } from '../model/canvasHeader.js'
import { append, el, replace, show } from './dom.js'
import { button } from './controls.js'
import { icon } from './icons.js'

/**
 * The canvas header bar: session identity on the left, "open in editor" on the
 * right (`design_guidance.md` 三.1, minus the two items with no backend).
 *
 * Two things here are load-bearing rather than tidy:
 *
 * 1. **The rename input is a persistent node.** This header repaints on every
 *    `onShellChanged`, which includes every snapshot tick of a streaming turn —
 *    a field rebuilt inside `replace()` would lose the caret, and its value,
 *    mid-word. Same shape as the sidebar's search box (5b) and the settings
 *    screen's (5f): built once, moved in and out of the flow, and written back
 *    exactly once — on the idle→renaming transition.
 * 2. **The `⋯` menu closes on the container's `focusout`**, like the sidebar's
 *    workspace menu. That inherits the same known gap: clicking an unfocusable
 *    decoration does not close it (`todo.md` records it under 5f).
 */

export interface CanvasHeaderDom {
  render(view: CanvasHeaderView): void
}

export interface CanvasHeaderActions {
  onToggleMenu: () => void
  onCloseMenu: () => void
  onMenuItem: (id: CanvasHeaderMenuItem['id']) => void
  /** The committed title, already trimmed and known to differ from the current one. */
  onRename: (title: string) => void
  onCancelRename: () => void
  onOpenLocation: () => void
}

export function createCanvasHeaderView(
  container: HTMLElement,
  actions: CanvasHeaderActions,
): CanvasHeaderDom {
  // Built once. `titleInput` is an `<input>` rather than `controls.ts`'s
  // `textField()` because that helper commits on `change` *and* on Enter, and
  // this one must also be cancellable with Escape — which `textField` leaves to
  // its container, and this container's Escape belongs to the menu.
  const titleInput = el('input', 'canvas-title-input')
  titleInput.type = 'text'
  titleInput.setAttribute('aria-label', '会话标题')
  const identity = el('div', 'canvas-identity')
  const rightControls = el('div', 'canvas-header-controls')
  append(container, [identity, rightControls])

  /** The title the input was seeded from, so a no-op commit sends nothing. */
  let seededTitle: string | undefined

  titleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      actions.onCancelRename()
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    event.stopPropagation()
    commit()
  })
  // Blur commits, matching `textField()`: leaving a field the user typed into
  // must not silently discard it. `renameCommit` is what makes that safe — an
  // unchanged or empty title resolves to "nothing to send".
  titleInput.addEventListener('blur', () => commit())

  // The menu's two exits, on the container rather than on the menu: the menu is
  // rebuilt by every render, and a listener on it would die with it.
  container.addEventListener('focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget
    if (next instanceof Node && container.contains(next)) return
    actions.onCloseMenu()
  })
  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    // The rename field has its own Escape and stops propagation, so reaching
    // here means the menu (or nothing) is what Escape is about.
    actions.onCloseMenu()
  })

  function commit(): void {
    const next = renameCommit(seededTitle ?? '', titleInput.value)
    if (next === undefined) {
      actions.onCancelRename()
      return
    }
    actions.onRename(next)
  }

  return {
    render(view) {
      show(container, view.visible)
      if (!view.visible) {
        // The subtree goes, not just the visibility: an empty window has no
        // session to name, and a stale title would be the last one it had.
        titleInput.remove()
        replace(identity)
        replace(rightControls)
        seededTitle = undefined
        return
      }

      // The input is pulled out of `identity` before it is emptied, so
      // `replace()` never destroys it.
      titleInput.remove()

      const menuShell = el('div', 'canvas-menu-shell')
      const trigger = button('canvas-menu-trigger', '⋯', '会话操作', actions.onToggleMenu)
      trigger.setAttribute('aria-haspopup', 'menu')
      trigger.setAttribute('aria-expanded', view.menuOpen ? 'true' : 'false')
      menuShell.appendChild(trigger)
      if (view.menuOpen) menuShell.appendChild(buildMenu(view.menuItems))

      replace(
        identity,
        icon('folder'),
        view.renaming ? titleInput : el('span', 'canvas-title', view.title),
        menuShell,
      )

      if (view.renaming) {
        // Written back exactly once, on the transition: a repaint mid-typing
        // would otherwise reset the field to the title on disk.
        if (seededTitle === undefined) {
          seededTitle = view.title
          titleInput.value = view.title
          titleInput.focus()
        }
      } else {
        seededTitle = undefined
      }

      replace(
        rightControls,
        button(
          'canvas-open-location',
          view.openLocationLabel,
          view.openLocationTitle,
          actions.onOpenLocation,
          { icon: 'code' },
        ),
      )
    },
  }

  function buildMenu(items: readonly CanvasHeaderMenuItem[]): HTMLElement {
    const menu = el('div', 'canvas-menu')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', '会话操作')
    for (const item of items) {
      const node = button(
        item.danger ? 'canvas-menu-item danger' : 'canvas-menu-item',
        item.label,
        item.label,
        () => actions.onMenuItem(item.id),
      )
      node.setAttribute('role', 'menuitem')
      menu.appendChild(node)
    }
    return menu
  }
}
