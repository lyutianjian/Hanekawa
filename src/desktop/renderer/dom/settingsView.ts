import { el, replace, show } from './dom.js'
import { button, pillSelect, selectField, textField, toggleField } from './controls.js'
import type {
  SettingsButton,
  SettingsCard,
  SettingsChord,
  SettingsForm,
  SettingsIntent,
  SettingsNavItem,
  SettingsRow,
  SettingsViewModel,
} from '../model/settings.js'

/**
 * The settings screen's nodes. Every decision — which rows exist, what they
 * say, what a keystroke means — already happened in `model/settings.ts`; this
 * file only builds elements and forwards intents.
 *
 * The screen fills `#canvas` rather than floating over it. `#overlay` and
 * `#rewind` cover the same canvas (S6) but are modal: each of them parks that
 * lane's agent loop until it is answered. Settings never parks anything, so it
 * hides its siblings from the stylesheet instead of scrimming them, and the
 * sidebar stays usable beside all three.
 *
 * No colours and no `.style.*` here; `styles.css` owns all of it.
 */

export interface SettingsViewHandle {
  render(view: SettingsViewModel): void
}

export function createSettingsView(
  container: HTMLElement,
  onIntent: (intent: SettingsIntent) => void,
  onKey: (chord: SettingsChord) => boolean,
): SettingsViewHandle {
  // Built once, outside `render()`: it lives in the nav column, which is replaced
  // on every render, and an `<input>` rebuilt under the user would drop the caret.
  const search = textField({
    className: 'settings-search',
    value: '',
    ariaLabel: '搜索设置',
    placeholder: '搜索设置…',
    onCommit: (query) => onIntent({ kind: 'search', query }),
  })
  // `textField` commits on blur/Enter, which is right for a setting and wrong for
  // a filter: the list has to move while typing.
  search.addEventListener('input', () => onIntent({ kind: 'search', query: search.value }))

  container.addEventListener('keydown', (event) => {
    // Backspace and the arrows belong to the search box. Escape does not: it is
    // this screen's documented way out, and `settingsKeyToIntent` is what decides
    // whether it clears the query or closes the screen.
    if (event.target === search && event.key !== 'Escape') return
    const consumed = onKey({
      key: event.key,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    })
    if (!consumed) return
    // Both, because the global handler is on `document`: without the second an
    // Escape aimed at a form would also close the whole screen.
    event.preventDefault()
    event.stopPropagation()
  })

  // Focus leaving the screen closes an open dropdown. `relatedTarget === null` is
  // this view's own `replace()` — every render fires one — and a target still
  // inside the container is a move between the trigger and its items.
  container.addEventListener('focusout', (event) => {
    const next = event.relatedTarget
    if (next === null) return
    if (next instanceof Node && container.contains(next)) return
    onIntent({ kind: 'close-menu' })
  })

  const nav = el('div', 'settings-nav')
  nav.id = 'settings-nav'
  const navList = el('div', 'settings-nav-list')
  const close = button('settings-nav-close', '返回会话', '关闭设置（Esc）', () =>
    onIntent({ kind: 'close' }),
  )
  nav.appendChild(search)
  nav.appendChild(navList)
  nav.appendChild(close)
  const body = el('div', 'settings-body')
  body.id = 'settings-body'
  // Two nodes, two jobs (todo V7): `body` is the full-width scroller, so its
  // scrollbar stays on the canvas edge, and `column` is the 880px reading measure
  // everything is rebuilt into. Built once here rather than per render — the
  // replaced region is the column's children.
  const column = el('div', 'settings-column')
  body.appendChild(column)
  container.appendChild(nav)
  container.appendChild(body)

  // Programmatically focusable but not a tab stop, exactly like the sidebar's
  // list. Without focus *inside* the screen the `keydown` above never fires, and
  // this screen is reached by `Ctrl+,` from a composer that the stylesheet then
  // hides — which left focus on `<body>` and made the close button's own promise,
  // 关闭设置（Esc）, false until the user happened to click something.
  container.tabIndex = -1
  let wasOpen = false

  return {
    render(view: SettingsViewModel): void {
      show(container, view.open)
      if (!view.open) {
        wasOpen = false
        return
      }
      // Only on the transition: focusing on every render would pull the caret out
      // of a form field mid-edit.
      if (!wasOpen) {
        wasOpen = true
        container.focus()
      }

      // The only write-back, and conditional on purpose: `input` is synchronous,
      // so the model can only disagree with the box when something *other* than
      // typing emptied the query — Escape, or reopening the screen.
      if (view.query === '' && search.value !== '') search.value = ''

      replace(
        navList,
        ...view.navGroups.map((group) =>
          el(
            'div',
            'settings-nav-group',
            el('div', 'settings-nav-group-label', group.label),
            ...group.items.map((item) => navItemNode(item, onIntent)),
          ),
        ),
      )

      replace(
        column,
        headerNode(view, onIntent),
        view.error ? el('div', 'settings-error', view.error) : null,
        view.confirming ? confirmNode(view.confirming.message, onIntent) : null,
        view.form ? formNode(view.form, onIntent) : null,
        view.searchEmpty ? el('div', 'settings-empty', view.searchEmpty) : null,
        ...view.cards.map((card) => cardNode(card, onIntent, view.openMenu)),
      )
      container.classList.toggle('busy', view.busy)
    },
  }
}

function navItemNode(
  item: SettingsNavItem,
  onIntent: (intent: SettingsIntent) => void,
): HTMLButtonElement {
  return button(
    item.selected ? 'settings-nav-item selected' : 'settings-nav-item',
    item.label,
    item.label,
    () => onIntent({ kind: 'select-category', category: item.category }),
  )
}

function headerNode(
  view: SettingsViewModel,
  onIntent: (intent: SettingsIntent) => void,
): HTMLElement {
  const header = el('div', 'settings-header', el('div', 'settings-title', view.title))
  // Only worth a selector when there is a choice to make.
  if (view.projectChoices.length > 1) {
    header.appendChild(
      selectField({
        className: 'settings-select settings-project',
        value: view.projectValue,
        ariaLabel: '选择项目',
        choices: view.projectChoices,
        onChange: (projectRoot) => onIntent({ kind: 'select-project', projectRoot }),
      }),
    )
  }
  if (view.subtitle) header.appendChild(el('div', 'settings-subtitle', view.subtitle))
  return header
}

function confirmNode(message: string, onIntent: (intent: SettingsIntent) => void): HTMLElement {
  return el(
    'div',
    'settings-confirm',
    el('span', 'settings-confirm-text', message),
    button('settings-btn danger', '删除', `${message}（Enter）`, () =>
      onIntent({ kind: 'confirm-remove' }),
    ),
    button('settings-btn', '取消', '取消（Esc）', () => onIntent({ kind: 'cancel-remove' })),
  )
}

function cardNode(
  card: SettingsCard,
  onIntent: (intent: SettingsIntent) => void,
  openMenu: string | undefined,
): HTMLElement {
  const node = el('section', 'settings-card', el('div', 'settings-card-title', card.title))
  if (card.note) node.appendChild(el('div', 'settings-card-note', card.note))
  if (card.rows.length === 0 && card.empty) {
    node.appendChild(el('div', 'settings-empty', card.empty))
  }
  for (const row of card.rows) node.appendChild(rowNode(row, onIntent, openMenu))
  if (card.footerButtons?.length) {
    const footer = el('div', 'settings-card-footer')
    for (const spec of card.footerButtons) footer.appendChild(buttonNode(spec, onIntent))
    node.appendChild(footer)
  }
  return node
}

function rowNode(
  row: SettingsRow,
  onIntent: (intent: SettingsIntent) => void,
  openMenu: string | undefined,
): HTMLElement {
  const label = el('div', 'settings-row-label', el('div', 'settings-row-name', row.label))
  if (row.detail) label.appendChild(el('div', 'settings-row-desc', row.detail))
  if (row.warning) label.appendChild(el('div', 'settings-row-warning', row.warning))

  const control = el('div', 'settings-row-control')
  switch (row.control.kind) {
    case 'text':
      control.appendChild(
        el('span', row.control.muted ? 'settings-row-value muted' : 'settings-row-value', row.control.value),
      )
      break
    case 'select': {
      const { intentOnChange } = row.control
      // Keyed by row id, which is already unique per page. The key stays in the
      // DOM so `SettingsControl` — and every model test of it — is untouched.
      const menu = `row:${row.id}`
      control.appendChild(
        pillSelect({
          value: row.control.value,
          ariaLabel: row.label,
          choices: row.control.choices,
          open: openMenu === menu,
          onToggle: () => onIntent({ kind: 'toggle-menu', menu }),
          onChange: (value) => onIntent(intentOnChange(value)),
        }),
      )
      break
    }
    case 'toggle': {
      const { intentOnChange } = row.control
      control.appendChild(
        toggleField({
          value: row.control.value,
          ariaLabel: row.label,
          ...(row.control.disabled ? { enabled: false } : {}),
          onChange: (value) => onIntent(intentOnChange(value)),
        }),
      )
      break
    }
    case 'input': {
      const { intentOnCommit } = row.control
      control.appendChild(
        textField({
          value: row.control.value,
          ariaLabel: row.label,
          ...(row.control.placeholder !== undefined ? { placeholder: row.control.placeholder } : {}),
          ...(row.control.mono ? { mono: true } : {}),
          onCommit: (value) => onIntent(intentOnCommit(value)),
        }),
      )
      break
    }
    case 'buttons':
      for (const spec of row.control.buttons) control.appendChild(buttonNode(spec, onIntent))
      break
    default:
      // A control kind with no case here would draw an *empty* cell — a row whose
      // setting silently cannot be changed. `runSidebarIntent` was caught by the
      // same omission, which is why this is a compile error instead.
      assertNeverControl(row.control)
  }
  return el('div', 'settings-row', label, control)
}

function assertNeverControl(value: never): never {
  throw new Error(`Unhandled settings control: ${JSON.stringify(value)}`)
}

function buttonNode(spec: SettingsButton, onIntent: (intent: SettingsIntent) => void): HTMLButtonElement {
  return button(
    spec.danger ? 'settings-btn danger' : 'settings-btn',
    spec.label,
    spec.title,
    () => onIntent(spec.intent),
    spec.icon ? { icon: spec.icon } : {},
  )
}

function formNode(form: SettingsForm, onIntent: (intent: SettingsIntent) => void): HTMLElement {
  const node = el('section', 'settings-card settings-form', el('div', 'settings-card-title', form.title))
  for (const field of form.fields) {
    const control = el('div', 'settings-row-control')
    if (field.choices) {
      control.appendChild(
        selectField({
          value: field.value,
          ariaLabel: field.label,
          choices: field.choices,
          onChange: (value) => onIntent({ kind: 'draft-field', field: field.id, value }),
        }),
      )
    } else {
      control.appendChild(
        textField({
          value: field.value,
          ariaLabel: field.label,
          ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
          ...(field.mono ? { mono: true } : {}),
          onCommit: (value) => onIntent({ kind: 'draft-field', field: field.id, value }),
        }),
      )
    }
    node.appendChild(
      el('div', 'settings-row', el('div', 'settings-row-label', el('div', 'settings-row-name', field.label)), control),
    )
  }
  node.appendChild(
    el(
      'div',
      'settings-card-footer',
      button('settings-btn primary', form.submitLabel, form.submitLabel, () =>
        onIntent({ kind: 'submit-draft' }),
      ),
      button('settings-btn', '取消', '取消（Esc）', () => onIntent({ kind: 'cancel-draft' })),
    ),
  )
  return node
}
