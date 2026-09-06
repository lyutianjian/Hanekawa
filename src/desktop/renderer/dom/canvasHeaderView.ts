import type { CanvasHeaderMenuItem, CanvasHeaderView } from '../model/canvasHeader.js'
import { renameCommit } from '../model/canvasHeader.js'
import { append, el, replace, show } from './dom.js'
import { button } from './controls.js'
import { onPressOutside } from './dismiss.js'
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
 * 2. **The `⋯` menu closes three ways**: a press outside the menu itself
 *    (`dom/dismiss.ts`), focus leaving the header, and Escape. The first is what
 *    makes the other two enough — this header repaints the trigger out from
 *    under the click that opened the menu, so by the user's next click there is
 *    nothing focused inside to fire a `focusout` at all. Opening the menu also
 *    moves focus onto its first item, which is what puts the keyboard back in it.
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
  /** Whether the last paint drew the menu, so focus moves on the edge only. */
  let menuWasOpen = false
  /** The menu's first item, rebuilt with the menu; where the keyboard lands. */
  let firstMenuItem: HTMLElement | undefined

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

  // The menu's three exits. The press is scoped to the menu and its trigger,
  // *not* to the header: pressing the session title or 打开位置 beside an open
  // menu is "somewhere else" as far as the user is concerned, and a header-wide
  // scope left it standing there. The trigger stays inside so a press on the `⋯`
  // of an open menu reaches `onToggleMenu` as a close, instead of being closed
  // here and re-opened by the click that follows.
  //
  // By selector rather than by node: both are rebuilt by every render, including
  // every snapshot of a streaming turn, so a captured reference would be stale.
  onPressOutside(['.canvas-menu', '.canvas-menu-trigger'], () => actions.onCloseMenu())
  container.addEventListener('focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget
    // `null` is focus going *nowhere*, which is this view's own repaint and not
    // the user leaving — the guard `sidebarView.ts` and `titleBarView.ts` each
    // spell out, and the one this header was missing. Without it the menu shut
    // itself in the act of opening: the paint that draws it destroys the trigger
    // the mouse is on, and the `firstMenuItem.focus()` below then fires a
    // `focusout` with no destination, *from inside `render()`*. That re-entered
    // `render()` with `menuOpen: false` — and the outer paint, still running,
    // then wrote its own menu-bearing subtree over the closed one. The menu
    // stayed on screen with the flag already false, so every later dismissal hit
    // `closeHeaderMenu`'s early return and only choosing an item could close it.
    if (next === null) return
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
        menuWasOpen = false
        firstMenuItem = undefined
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

      // Last, after every node this paint owns is in the page — `focus()` is the
      // one call here that runs other people's code. It fires `focusout` on
      // whatever held the caret, synchronously, and a handler that repaints in
      // answer re-enters this function; anything written after that point would
      // land on top of the newer paint and leave the DOM ahead of the state.
      // Being last makes the re-entrant paint the one that survives, which is
      // the only ordering that cannot lie.
      //
      // On the closed→open transition only, the way the seed above is written
      // once: this header repaints on every snapshot of a streaming turn, and
      // re-focusing per tick would take the caret out of whatever the user moved
      // to. Without it the menu is opened by a click that destroys the button it
      // landed on, and the keyboard is left on `<body>` with a menu on screen.
      const opening = view.menuOpen && !menuWasOpen
      menuWasOpen = view.menuOpen
      if (opening) firstMenuItem?.focus()
    },
  }

  function buildMenu(items: readonly CanvasHeaderMenuItem[]): HTMLElement {
    const menu = el('div', 'canvas-menu')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', '会话操作')
    firstMenuItem = undefined
    for (const item of items) {
      const node = button(
        item.danger ? 'canvas-menu-item danger' : 'canvas-menu-item',
        item.label,
        item.label,
        () => actions.onMenuItem(item.id),
      )
      node.setAttribute('role', 'menuitem')
      firstMenuItem ??= node
      menu.appendChild(node)
    }
    return menu
  }
}
