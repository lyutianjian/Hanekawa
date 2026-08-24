import { el, replace, show } from './dom.js'
import { button, selectField, textField, toggleField } from './controls.js'
import type {
  SettingsButton,
  SettingsCard,
  SettingsChord,
  SettingsForm,
  SettingsIntent,
  SettingsRow,
  SettingsViewModel,
} from '../model/settings.js'

/**
 * The settings screen's nodes. Every decision — which rows exist, what they
 * say, what a keystroke means — already happened in `model/settings.ts`; this
 * file only builds elements and forwards intents.
 *
 * The screen lives *inside* `#canvas` rather than being a body-level overlay:
 * `#overlay` and `#rewind` are `position: fixed` and cover the sidebar, which
 * makes them modal. Settings is not modal — it never parks the agent loop, and
 * the session list stays usable beside it.
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
  container.addEventListener('keydown', (event) => {
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

  const nav = el('div', 'settings-nav')
  nav.id = 'settings-nav'
  const body = el('div', 'settings-body')
  body.id = 'settings-body'
  container.appendChild(nav)
  container.appendChild(body)

  return {
    render(view: SettingsViewModel): void {
      show(container, view.open)
      if (!view.open) return

      replace(
        nav,
        ...view.nav.map((item) =>
          button(
            item.selected ? 'settings-nav-item selected' : 'settings-nav-item',
            item.label,
            item.label,
            () => onIntent({ kind: 'select-category', category: item.category }),
          ),
        ),
        el('div', 'settings-nav-spacer'),
        button('settings-nav-close', '返回会话', '关闭设置（Esc）', () => onIntent({ kind: 'close' })),
      )

      replace(
        body,
        headerNode(view, onIntent),
        view.error ? el('div', 'settings-error', view.error) : null,
        view.confirming ? confirmNode(view.confirming.message, onIntent) : null,
        view.form ? formNode(view.form, onIntent) : null,
        ...view.cards.map((card) => cardNode(card, onIntent)),
      )
      container.classList.toggle('busy', view.busy)
    },
  }
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

function cardNode(card: SettingsCard, onIntent: (intent: SettingsIntent) => void): HTMLElement {
  const node = el('section', 'settings-card', el('div', 'settings-card-title', card.title))
  if (card.note) node.appendChild(el('div', 'settings-card-note', card.note))
  if (card.rows.length === 0 && card.empty) {
    node.appendChild(el('div', 'settings-empty', card.empty))
  }
  for (const row of card.rows) node.appendChild(rowNode(row, onIntent))
  if (card.footerButtons?.length) {
    const footer = el('div', 'settings-card-footer')
    for (const spec of card.footerButtons) footer.appendChild(buttonNode(spec, onIntent))
    node.appendChild(footer)
  }
  return node
}

function rowNode(row: SettingsRow, onIntent: (intent: SettingsIntent) => void): HTMLElement {
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
      control.appendChild(
        selectField({
          value: row.control.value,
          ariaLabel: row.label,
          choices: row.control.choices,
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
