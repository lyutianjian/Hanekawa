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
import { el, replace } from './dom.js'

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
 * Menus close on `focusout` from the bar, the same mechanism the sidebar's
 * workspace dropdown and the composer's permission pill use — and with the same
 * known hole (clicking a non-focusable decoration inside the bar does not close
 * them, `todo.md` records it three times over).
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

  const menuNode = (menu: TitleBarMenu, view: TitleBarView): HTMLElement => {
    const shell = el('div', 'titlebar-menu-shell')
    shell.appendChild(
      button(
        `titlebar-menu-trigger${view.openMenu === menu.id ? ' open' : ''}`,
        menu.label,
        menu.label,
        () => onOpenMenu(toggleMenu(view.openMenu, menu.id)),
      ),
    )
    if (view.openMenu !== menu.id) return shell
    const list = el('div', 'titlebar-menu')
    list.setAttribute('role', 'menu')
    for (const item of menu.items) list.appendChild(itemNode(item, view))
    shell.appendChild(list)
    return shell
  }

  return {
    render(view) {
      const signature = titleBarRenderSignature(view)
      if (signature === drawn) return
      drawn = signature
      openMenu = view.openMenu

      replace(
        container,
        button(
          'titlebar-rail',
          '',
          view.sidebarCollapsed ? '展开侧栏（Ctrl+B）' : '收起侧栏（Ctrl+B）',
          () => onAction('toggle-sidebar'),
          { icon: 'sidebar' },
        ),
        ...TITLE_BAR_MENUS.map((menu) => menuNode(menu, view)),
      )
    },
  }
}
