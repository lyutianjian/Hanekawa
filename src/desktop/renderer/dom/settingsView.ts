import { el, reconcile, replace, show } from './dom.js'
import { button, pillSelect, selectField, textField, toggleField } from './controls.js'
import { onPressOutside } from './dismiss.js'
import type {
  SettingsAnchor,
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
 * **Nodes are kept by id and reconciled**, the rule `dom/transcriptView.ts`
 * already follows. A `replace()` of the whole column pulls every card out of
 * the page and puts it back, which cost this screen two things: the scroll
 * anchor (so a row disappearing scrolled the page under the reader) and, worse,
 * the node under the pointer. A form field commits on blur, so `mousedown` on
 * 保存 rebuilt that very button before `mouseup` reached it — the click was
 * never delivered, and the user had to press it twice. Kept nodes plus
 * `textField`'s `live` commit are what make one click enough.
 *
 * **And a kept leaf is only half of it: its wrappers have to be kept too.**
 * `appendChild` moves a node by detaching it first, so a focused `<input>` put
 * into a newly built `.settings-row-control` leaves the document for that instant
 * — which is all it takes for the browser to blur it. Every field commits `live`,
 * so that happened once per character: the 模型/服务商 form could not be typed in
 * at all without clicking back into the box between letters.
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

  // A press outside the open pill closes it — the hole `focusout` alone leaves
  // here as everywhere else: this screen is mostly cards and labels, none of
  // which take focus, so pressing one moved no focus and fired no `focusout`,
  // and the dropdown stayed up over the row the user was reading.
  //
  // Gated on `lastOpenMenu` rather than sent unconditionally: `runSettingsIntent`
  // repaints the whole screen for every intent it is handed, and this listener
  // sees every press in the window, including the ones while settings is shut.
  onPressOutside(['.settings-menu-shell'], () => {
    if (lastOpenMenu === undefined) return
    onIntent({ kind: 'close-menu' })
  })

  // Focus leaving the screen closes an open dropdown. `relatedTarget === null` is
  // this view's own repaint — every render can fire one — and a target still
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
    { icon: 'arrow-left' },
  )
  // First in the column, above the search box: this screen covers the whole
  // window (the sidebar included), so the way back has to be where the eye
  // starts. At the foot of the category list it was below a scroller, which is
  // the one place an exit must not be.
  nav.appendChild(close)
  nav.appendChild(search)
  nav.appendChild(navList)
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

  // The kept nodes, and what a kept node's handler reads *now*. Both are pruned
  // to the keys this paint claimed, which is the rule that keeps a stale ref from
  // outliving the node it belonged to.
  const kept = new Map<string, HTMLElement>()
  const commits = new Map<string, (value: string) => SettingsIntent>()
  let claimed = new Set<string>()
  // Which pill is open, as of the *previous* paint, so a menu that just opened can
  // be told from one that has been open all along and may hold the user's arrow key.
  let lastOpenMenu: string | undefined
  // The node to focus once this paint is in the page. A list rather than a
  // variable: it is written from a callback the paint hands down, and narrowing
  // cannot see that — a `let` reset to `undefined` reads back as `never`.
  const pendingFocus: HTMLElement[] = []

  /** A kept element, created once per key and reused thereafter. */
  function node<K extends keyof HTMLElementTagNameMap>(
    key: string,
    tag: K,
    className: string,
    create?: (element: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K] {
    claimed.add(key)
    const existing = kept.get(key)
    if (existing) {
      existing.className = className
      return existing as HTMLElementTagNameMap[K]
    }
    const made = el(tag, className)
    create?.(made)
    kept.set(key, made)
    return made
  }

  /** The form's fields keep their nodes, so typing never rebuilds the caret away. */
  function keptInput(
    key: string,
    options: {
      value: string
      ariaLabel: string
      placeholder?: string
      mono?: boolean
      live?: boolean
      intentOnCommit: (value: string) => SettingsIntent
    },
  ): HTMLInputElement {
    commits.set(key, options.intentOnCommit)
    claimed.add(key)
    const existing = kept.get(key) as HTMLInputElement | undefined
    if (existing) {
      // The one write-back rule the search box already follows: never type over
      // the user. A focused field is theirs until they leave it.
      if (document.activeElement !== existing && existing.value !== options.value) {
        existing.value = options.value
      }
      return existing
    }
    const made = textField({
      value: options.value,
      ariaLabel: options.ariaLabel,
      ...(options.placeholder !== undefined ? { placeholder: options.placeholder } : {}),
      ...(options.mono ? { mono: true } : {}),
      ...(options.live ? { live: true } : {}),
      // Through the map, not the closure: the node outlives this paint, and a
      // captured `intentOnCommit` would keep answering with the old row's value.
      onCommit: (value) => {
        const commit = commits.get(key)
        if (commit) onIntent(commit(value))
      },
    })
    kept.set(key, made)
    return made
  }

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

      claimed = new Set<string>()
      pendingFocus.length = 0
      const justOpened = view.openMenu !== lastOpenMenu ? view.openMenu : undefined
      lastOpenMenu = view.openMenu
      // Was the user in this screen before the paint? A pill's shell is rebuilt on
      // every render, so the trigger they were standing on is about to be replaced;
      // without the rescue below, focus lands on `<body>` and this screen's own
      // keydown — Esc included — stops firing until something is clicked.
      const focusWasInside =
        document.activeElement instanceof Node && container.contains(document.activeElement)

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

      // The form and the confirmation are drawn *inside* the card that owns them
      // rather than stacked above every card, so the answer to a click appears
      // where the click was. Anything unanchored (a card filtered away by the
      // search) falls back to the column, which is better than not drawing it.
      const anchoredCards = new Set(view.cards.map((card) => card.id))
      const formHomeless = view.form !== undefined && !anchoredCards.has(view.form.anchor.cardId)
      const confirmHomeless =
        view.confirming !== undefined && !anchoredCards.has(view.confirming.anchor.cardId)

      reconcile(column, [
        headerNode(view, onIntent),
        view.error ? el('div', 'settings-error', view.error) : null,
        confirmHomeless && view.confirming ? confirmNode(view.confirming.message, onIntent) : null,
        formHomeless && view.form ? formNode(view.form, node, keptInput, onIntent) : null,
        view.searchEmpty ? el('div', 'settings-empty', view.searchEmpty) : null,
        ...view.cards.map((card) =>
          cardNode(card, {
            openMenu: view.openMenu,
            justOpened,
            focusAfterPaint: (element) => {
              pendingFocus.push(element)
            },
            form: !formHomeless && view.form?.anchor.cardId === card.id ? view.form : undefined,
            confirm:
              !confirmHomeless && view.confirming?.anchor.cardId === card.id
                ? view.confirming
                : undefined,
            node,
            keptInput,
            onIntent,
          }),
        ),
      ])

      // Everything this paint did not ask for is gone for good, refs included —
      // otherwise a kept node keeps answering with the state that built it.
      for (const key of [...kept.keys()]) {
        if (claimed.has(key)) continue
        kept.delete(key)
        commits.delete(key)
      }

      // Only now: everything above is built before it is inserted, and `focus()`
      // on a node outside the document does nothing at all.
      if (pendingFocus[0]) pendingFocus[0].focus()
      else if (
        focusWasInside
        && !(document.activeElement instanceof Node && container.contains(document.activeElement))
      ) {
        // The paint took the focused node out from under the user. The screen is
        // the fallback rather than a guess at a replacement: it is what `Ctrl+,`
        // focuses too, and it is the node whose keydown answers Esc.
        container.focus()
      }
      container.classList.toggle('busy', view.busy)
    },
  }
}

/** The two kept-node factories, as the row and card builders below see them. */
type NodeFactory = <K extends keyof HTMLElementTagNameMap>(
  key: string,
  tag: K,
  className: string,
  create?: (element: HTMLElementTagNameMap[K]) => void,
) => HTMLElementTagNameMap[K]

type InputFactory = (
  key: string,
  options: {
    value: string
    ariaLabel: string
    placeholder?: string
    mono?: boolean
    live?: boolean
    intentOnCommit: (value: string) => SettingsIntent
  },
) => HTMLInputElement

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
  context: {
    openMenu: string | undefined
    justOpened: string | undefined
    focusAfterPaint: (element: HTMLElement) => void
    form?: SettingsForm
    confirm?: { message: string; anchor: SettingsAnchor }
    node: NodeFactory
    keptInput: InputFactory
    onIntent: (intent: SettingsIntent) => void
  },
): HTMLElement {
  const { node, onIntent } = context
  const section = node(`card:${card.id}`, 'section', 'settings-card')
  const children: Array<Node | null> = [el('div', 'settings-card-title', card.title)]
  if (card.note) children.push(el('div', 'settings-card-note', card.note))
  if (card.rows.length === 0 && card.empty) {
    children.push(el('div', 'settings-empty', card.empty))
  }
  for (const row of card.rows) {
    children.push(rowNode(card.id, row, context))
    // Directly under the row it is about: an edit form or a delete confirmation
    // has a subject, and putting it anywhere else makes the reader hunt for it.
    if (context.confirm?.anchor.rowId === row.id) {
      children.push(confirmNode(context.confirm.message, onIntent))
    }
    if (context.form?.anchor.rowId === row.id) {
      children.push(formNode(context.form, node, context.keptInput, onIntent))
    }
  }
  // Anchored to the card rather than a row: 新增… has no subject yet, so it goes
  // at the end of the list it is about to grow, above the button that opened it.
  if (context.confirm && context.confirm.anchor.rowId === undefined) {
    children.push(confirmNode(context.confirm.message, onIntent))
  }
  if (context.form && context.form.anchor.rowId === undefined) {
    children.push(formNode(context.form, node, context.keptInput, onIntent))
  }
  if (card.footerButtons?.length) {
    const footer = el('div', 'settings-card-footer')
    for (const spec of card.footerButtons) footer.appendChild(buttonNode(spec, onIntent))
    children.push(footer)
  }
  reconcile(section, children)
  return section
}

function rowNode(
  cardId: string,
  row: SettingsRow,
  context: {
    openMenu: string | undefined
    justOpened: string | undefined
    focusAfterPaint: (element: HTMLElement) => void
    node: NodeFactory
    keptInput: InputFactory
    onIntent: (intent: SettingsIntent) => void
  },
): HTMLElement {
  const { onIntent } = context
  const label = el('div', 'settings-row-label', el('div', 'settings-row-name', row.label))
  if (row.detail) label.appendChild(el('div', 'settings-row-desc', row.detail))
  if (row.warning) label.appendChild(el('div', 'settings-row-warning', row.warning))

  // Kept, like the row around it, and for a reason the row alone does not cover:
  // a kept `<input>` appended into a *freshly built* control cell is taken out of
  // the document to get there, and a node that leaves the document is blurred on
  // the spot. Keeping the leaf is only half of it — the cell it sits in has to be
  // the same cell too, or the caret is dropped once per keystroke.
  const control = context.node(`control:${cardId}:${row.id}`, 'div', 'settings-row-control')
  const controls: Node[] = []
  switch (row.control.kind) {
    case 'text':
      controls.push(
        el('span', row.control.muted ? 'settings-row-value muted' : 'settings-row-value', row.control.value),
      )
      break
    case 'select': {
      const { intentOnChange } = row.control
      // Keyed by row id, which is already unique per page. The key stays in the
      // DOM so `SettingsControl` — and every model test of it — is untouched.
      const menu = `row:${row.id}`
      controls.push(
        pillSelect({
          value: row.control.value,
          ariaLabel: row.label,
          choices: row.control.choices,
          open: context.openMenu === menu,
          ...(row.pending ? { enabled: false } : {}),
          // Only on the paint that opened it: a menu that was already open may
          // hold a reader who has arrowed down it, and re-focusing the first
          // option would drag them back to the top once per repaint.
          ...(context.justOpened === menu
            ? { onFirstItem: (item: HTMLElement) => context.focusAfterPaint(item) }
            : {}),
          onToggle: () => onIntent({ kind: 'toggle-menu', menu }),
          onChange: (value) => onIntent(intentOnChange(value)),
        }),
      )
      break
    }
    case 'toggle': {
      const { intentOnChange } = row.control
      controls.push(
        toggleField({
          value: row.control.value,
          ariaLabel: row.label,
          // A row waiting on its own change is not a second switch to flip.
          ...(row.control.disabled || row.pending ? { enabled: false } : {}),
          onChange: (value) => onIntent(intentOnChange(value)),
        }),
      )
      break
    }
    case 'input': {
      const { intentOnCommit } = row.control
      controls.push(
        context.keptInput(`input:${row.id}`, {
          value: row.control.value,
          ariaLabel: row.label,
          ...(row.control.placeholder !== undefined ? { placeholder: row.control.placeholder } : {}),
          ...(row.control.mono ? { mono: true } : {}),
          intentOnCommit,
        }),
      )
      break
    }
    case 'buttons':
      for (const spec of row.control.buttons) {
        controls.push(buttonNode(row.pending ? { ...spec, pending: true } : spec, onIntent))
      }
      break
    default:
      // A control kind with no case here would draw an *empty* cell — a row whose
      // setting silently cannot be changed. `runSidebarIntent` was caught by the
      // same omission, which is why this is a compile error instead.
      assertNeverControl(row.control)
  }
  reconcile(control, controls)
  const element = context.node(
    `row:${cardId}:${row.id}`,
    'div',
    row.pending ? 'settings-row pending' : 'settings-row',
  )
  // Says "this row is waiting" to a screen reader, which the dimming alone does
  // not: colour may not be the only carrier.
  if (row.pending) element.setAttribute('aria-busy', 'true')
  else element.removeAttribute('aria-busy')
  reconcile(element, [label, control])
  return element
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
    {
      ...(spec.icon ? { icon: spec.icon } : {}),
      ...(spec.pending ? { enabled: false } : {}),
    },
  )
}

function formNode(
  form: SettingsForm,
  node: NodeFactory,
  keptInput: InputFactory,
  onIntent: (intent: SettingsIntent) => void,
): HTMLElement {
  // Keyed by the anchor, not by a counter: opening a *different* form drops this
  // one's nodes, while re-rendering the same form keeps every field's caret.
  const key = `form:${form.anchor.cardId}:${form.anchor.rowId ?? ''}`
  const section = node(key, 'section', 'settings-card settings-form')
  const children: Node[] = [el('div', 'settings-card-title', form.title)]
  for (const field of form.fields) {
    // Both wrappers are kept, not just the input inside them. `appendChild` moves
    // a node, and moving means *detaching first*: a focused `<input>` appended
    // into a newly built cell is out of the document for that instant, which is
    // all the browser needs to blur it. Since a form field commits `live`, every
    // character typed re-rendered this form — so every character threw the caret
    // out of the field and the user had to click back in to type the next one.
    const row = node(`${key}:row:${field.id}`, 'div', 'settings-row')
    const control = node(`${key}:control:${field.id}`, 'div', 'settings-row-control')
    const controls: Node[] = []
    if (field.choices) {
      controls.push(
        selectField({
          value: field.value,
          ariaLabel: field.label,
          choices: field.choices,
          onChange: (value) => onIntent({ kind: 'draft-field', field: field.id, value }),
        }),
      )
    } else {
      controls.push(
        // `live`, unlike a settings row: a form field writes the draft in the
        // renderer, not the config, so there is no cost per keystroke — and a
        // blur-commit is exactly what used to swallow the click on 保存.
        keptInput(`${key}:${field.id}`, {
          value: field.value,
          ariaLabel: field.label,
          ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
          ...(field.mono ? { mono: true } : {}),
          live: true,
          intentOnCommit: (value) => ({ kind: 'draft-field', field: field.id, value }),
        }),
      )
    }
    reconcile(control, controls)
    // The label may be rebuilt: it holds no caret and no animation.
    reconcile(row, [
      el('div', 'settings-row-label', el('div', 'settings-row-name', field.label)),
      control,
    ])
    children.push(row)
  }
  children.push(
    el(
      'div',
      'settings-card-footer',
      button('settings-btn primary', form.submitLabel, form.submitLabel, () =>
        onIntent({ kind: 'submit-draft' }),
      ),
      button('settings-btn', '取消', '取消（Esc）', () => onIntent({ kind: 'cancel-draft' })),
    ),
  )
  reconcile(section, children)
  return section
}
