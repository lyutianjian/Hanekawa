import {
  TITLE_BAR_MENUS,
  itemEnabled,
  titleBarRenderSignature,
  toggleMenu,
  type TitleBarAction,
  type TitleBarItem,
  type TitleBarMenu,
  type TitleBarView,
} from '../model/titleBar.js'
import { button } from './controls.js'
import { onPressOutside } from './dismiss.js'
import { el, reconcile } from './dom.js'
import { createPresence } from './presence.js'

/**
 * The frameless window's own title bar (5g).
 *
 * Left to right: the sidebar rail toggle, then 文件 / 视图 / 帮助. Everything
 * right of that is empty strip, and on Windows the last ~140px of it is where the
 * OS paints minimize/maximize/close into `titleBarOverlay` — which is why the
 * stylesheet reserves that space rather than centring anything.
 *
 * The strip is `-webkit-app-region: drag`; every control in it is `no-drag`, or
 * it would move the window instead of being clickable. That pair lives in
 * `styles.css` (`#titlebar` / `#titlebar button`), not here: painting is not this
 * file's job.
 *
 * Menus close on a press outside the menu shells (`dom/dismiss.ts`), on
 * `focusout` from the bar, and on Escape — the same three the canvas header and
 * the composer's popovers use. The press is what covers the hole the other two
 * leave: a click on an unfocusable decoration moves no focus and fires no
 * `focusout`.
 */

export interface TitleBarDom {
  render(view: TitleBarView): void
}

export function createTitleBarView(
  container: HTMLElement,
  onAction: (action: TitleBarAction) => void,
  /** Reports the menu the user opened or closed; `app.ts` owns the flag. */
  onOpenMenu: (id: string | undefined) => void,
): TitleBarDom {
  let openMenu: string | undefined
  let drawn: string | undefined

  // Every menu shell, not the bar: a press on 视图 while 文件 is open has to reach
  // `toggleMenu` and swap them rather than be answered here as a close, and a
  // press on the bar's own blank strip has to shut whatever is open — which a
  // bar-wide scope treated as "inside" and left standing.
  onPressOutside(['.titlebar-menu-shell'], () => {
    if (openMenu === undefined) return
    onOpenMenu(undefined)
  })

  container.addEventListener('focusout', (event) => {
    const next = event.relatedTarget
    // `null` is this view's own repaint destroying the focused node — the same
    // reasoning `sidebarView.ts` spells out. A real departure lands somewhere.
    if (next === null) return
    if (next instanceof Node && container.contains(next)) return
    if (openMenu !== undefined) onOpenMenu(undefined)
  })

  container.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || openMenu === undefined) return
    event.stopPropagation()
    onOpenMenu(undefined)
  })

  const itemNode = (item: TitleBarItem, view: TitleBarView): HTMLElement => {
    const node = button(
      'titlebar-menu-item',
      item.label,
      item.chord ? `${item.label}（${item.chord}）` : item.label,
      () => {
        // Close first, then act: several of these swap the whole canvas, and a
        // menu left open would hang over the screen that replaced it.
        onOpenMenu(undefined)
        onAction(item.action)
      },
      { enabled: itemEnabled(item, view) },
    )
    if (item.chord) node.appendChild(el('span', 'titlebar-menu-chord', item.chord))
    return node
  }

  const menus = TITLE_BAR_MENUS.map((menu: TitleBarMenu) => {
    const shell = el('div', 'titlebar-menu-shell')
    const trigger = button('titlebar-menu-trigger', menu.label, menu.label,
      () => onOpenMenu(toggleMenu(openMenu, menu.id)))
    trigger.setAttribute('aria-haspopup', 'menu')
    const list = el('div', 'titlebar-menu')
    list.setAttribute('role', 'menu')
    const presence = createPresence(list, { direction: 'drop' })
    reconcile(shell, [trigger, list])
    return { menu, shell, trigger, list, presence, items: [] as HTMLElement[] }
  })
  const rail = button('titlebar-rail', '', '', () => onAction('toggle-sidebar'), { icon: 'sidebar' })
  reconcile(container, [rail, ...menus.map((entry) => entry.shell)])

  return {
    render(view) {
      const signature = titleBarRenderSignature(view)
      if (signature === drawn) return
      drawn = signature
      const previous = openMenu
      openMenu = view.openMenu
      rail.title = view.sidebarCollapsed ? '展开侧栏（Ctrl+B）' : '收起侧栏（Ctrl+B）'
      rail.setAttribute('aria-label', rail.title)
      let focus: HTMLElement | undefined
      for (const entry of menus) {
        const open = openMenu === entry.menu.id
        if (open && entry.items.length === 0) {
          entry.items = entry.menu.items.map((item) => itemNode(item, view))
          reconcile(entry.list, entry.items)
        }
        entry.items.forEach((node, index) => { (node as HTMLButtonElement).disabled = !itemEnabled(entry.menu.items[index]!, view) })
        entry.trigger.classList.toggle('open', open)
        entry.trigger.setAttribute('aria-expanded', String(open))
        if (!open && entry.list.contains(document.activeElement)) focus = entry.trigger
        entry.presence.set(open)
        if (open && previous !== openMenu) focus = entry.items.find((node) => !(node as HTMLButtonElement).disabled)
      }
      focus?.focus()
    },
  }
}
