/**
 * The title bar's menus, as data.
 *
 * The window is frameless (5g), so this row replaces both Electron's default
 * English menu and the OS caption: on Windows the three buttons are still drawn
 * by the system into `titleBarOverlay`, and everything to the left of them is
 * ours. The rest of the strip is a drag region — see `styles.css`.
 *
 * Every item maps to an intent the app **already** has, deliberately: a menu is a
 * second way to reach a command, never a first. That is also why there is no
 * 编辑 menu — cut/copy/paste in a textarea are the platform's own accelerators,
 * and a renderer-drawn 编辑 would either duplicate them or lie about them.
 *
 * DOM-free, like every other `model/` module: decisions here, nodes in
 * `dom/titleBarView.ts`.
 */

/** What a menu item asks the app to do. Each one exists elsewhere already. */
export type TitleBarAction =
  | 'new-session'
  | 'open-project'
  | 'open-settings'
  | 'toggle-sidebar'
  | 'toggle-help'

export interface TitleBarItem {
  readonly action: TitleBarAction
  readonly label: string
  /** The chord that does the same thing, shown right-aligned. */
  readonly chord: string
  /** Greyed while the window cannot open anything (a blocking dialog is up). */
  readonly needsProject?: boolean
}

export interface TitleBarMenu {
  /** Stable across renders, so "which menu is open" survives a repaint. */
  readonly id: string
  readonly label: string
  readonly items: readonly TitleBarItem[]
}

export const TITLE_BAR_MENUS: readonly TitleBarMenu[] = [
  {
    id: 'file',
    label: '文件',
    items: [
      { action: 'new-session', label: '新建会话', chord: 'Ctrl+T', needsProject: true },
      { action: 'open-project', label: '打开项目…', chord: 'Ctrl+Shift+O', needsProject: true },
      { action: 'open-settings', label: '设置', chord: 'Ctrl+,' },
    ],
  },
  {
    id: 'view',
    label: '视图',
    items: [{ action: 'toggle-sidebar', label: '收起 / 展开侧栏', chord: 'Ctrl+B' }],
  },
  {
    id: 'help',
    label: '帮助',
    items: [{ action: 'toggle-help', label: '快捷键', chord: '' }],
  },
]

export interface TitleBarView {
  readonly menus: readonly TitleBarMenu[]
  /** The open menu's id, or `undefined`. At most one is open. */
  readonly openMenu: string | undefined
  readonly sidebarCollapsed: boolean
  /** False while a blocking dialog is up; greys the items that open something. */
  readonly canCreate: boolean
}

/**
 * Opening a menu is idempotent per id: clicking the open one closes it.
 *
 * A single field rather than a set — the same shape `SettingsState.openMenu`
 * uses, and for the same reason: two menus open at once is a state the view
 * would have to be able to draw, and nothing wants it.
 */
export function toggleMenu(open: string | undefined, id: string): string | undefined {
  return open === id ? undefined : id
}

/** Whether an item can be activated in this view's state. */
export function itemEnabled(item: TitleBarItem, view: TitleBarView): boolean {
  return item.needsProject !== true || view.canCreate
}

/**
 * The signature the view repaints against.
 *
 * The title bar is drawn from the same shell snapshot the sidebar is, which
 * fires on every `isStreaming` tick — and rebuilding an open menu under the
 * pointer would close it on the next token.
 */
export function titleBarRenderSignature(view: TitleBarView): string {
  return [
    view.openMenu ?? '-',
    view.sidebarCollapsed ? 'c' : '-',
    view.canCreate ? 'n' : '-',
  ].join('')
}
