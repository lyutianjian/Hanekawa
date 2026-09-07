import { el } from './dom.js'
import { icon, type IconName } from './icons.js'

/**
 * The shared form controls.
 *
 * `button()` moved here from `sidebarView.ts` when the settings screen became
 * the second caller; the text and select fields are new with it. Nothing in
 * here holds a colour or a layout decision — that is the stylesheet's, and
 * `test/rendererStyleTokens.test.ts` enforces it by scanning for `.style.*`.
 *
 * No `innerHTML`, ever: every node is built with `el()`, and the one file
 * allowed to reach for `createElementNS` is `icons.ts`.
 */

export function button(
  className: string,
  label: string,
  title: string,
  onClick: () => void,
  options: { enabled?: boolean; icon?: IconName; trailingIcon?: IconName } = {},
): HTMLButtonElement {
  const node = el('button', className)
  node.type = 'button'
  node.title = title
  node.setAttribute('aria-label', title)
  // Built up rather than assigned as `textContent`, because an icon child would
  // be wiped by it. An icon-only button passes an empty label and relies on the
  // `aria-label` above for its name.
  //
  // Two parameters rather than one plus a convention: `icon` used to be inserted
  // before the label unconditionally, which drew every dropdown as `⌵ 跟随系统`
  // while `design_guidance.md` asks for 「左图标 + 文本 + `⌵`」 (六), 「项目名 +
  // `⌵`」 (三.2) and 「已处理 Xm Xs `⌵`」 (四.3). Where the glyph goes is now the
  // call site's explicit decision instead of something it has to remember.
  if (options.icon) node.appendChild(icon(options.icon))
  if (label) node.appendChild(el('span', 'btn-label', label))
  if (options.trailingIcon) node.appendChild(icon(options.trailingIcon))
  node.disabled = options.enabled === false
  node.addEventListener('click', (event) => {
    // Rows are clickable too; a button inside one must not also activate it.
    event.stopPropagation()
    onClick()
  })
  return node
}

/**
 * A text input that commits on `change` and on Enter — **never per keystroke**,
 * unless `live` says otherwise.
 *
 * A settings *row* ends every commit in a config write, so a keystroke-level
 * handler there would rewrite `config.json` once per character typed and fan a
 * runtime rebuild out to every open lane while doing it. A *form* field is the
 * opposite: it writes `SettingsState.draft`, which never leaves the renderer
 * until 保存 is pressed. `live` is for those, and it is not a nicety — a
 * blur-commit re-renders the screen on `mousedown`, which used to rebuild the
 * 保存 button before `mouseup` reached it and swallow the click whole.
 *
 * Escape is not handled: it belongs to the container, which uses it to unwind
 * the form. The input stops propagation only for Enter, which it consumes.
 */
export function textField(options: {
  className?: string
  value: string
  placeholder?: string
  ariaLabel: string
  mono?: boolean
  live?: boolean
  onCommit: (value: string) => void
}): HTMLInputElement {
  const node = el('input', options.className ?? 'settings-input')
  node.type = 'text'
  node.value = options.value
  node.setAttribute('aria-label', options.ariaLabel)
  if (options.placeholder) node.placeholder = options.placeholder
  if (options.mono) node.classList.add('mono')
  // One of the two, never both. A `live` field has already committed every
  // character by the time it loses focus, so a `change` on top of that is a
  // *second* commit fired by the blur — and that blur is the `mousedown` on 保存,
  // whose re-render rebuilt the button before `mouseup` reached it. The click the
  // user aimed at the footer was swallowed, once per edit.
  if (options.live) node.addEventListener('input', () => options.onCommit(node.value))
  else node.addEventListener('change', () => options.onCommit(node.value))
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    event.stopPropagation()
    options.onCommit(node.value)
  })
  return node
}

/**
 * A switch.
 *
 * A `<button role="switch">` rather than a checkbox: a checkbox has to be
 * un-styled before it can be re-styled (`appearance: none` plus a replacement
 * for every state), while a button is a blank surface already, and `aria-checked`
 * says the same thing to a screen reader that `checked` would.
 *
 * The knob is a child element rather than a pseudo-element so the stylesheet can
 * move it without either file knowing a colour.
 */
export function toggleField(options: {
  className?: string
  value: boolean
  ariaLabel: string
  enabled?: boolean
  onChange: (value: boolean) => void
}): HTMLButtonElement {
  const node = el('button', options.className ?? 'settings-toggle')
  node.type = 'button'
  node.setAttribute('role', 'switch')
  node.setAttribute('aria-checked', options.value ? 'true' : 'false')
  node.setAttribute('aria-label', options.ariaLabel)
  node.title = options.ariaLabel
  node.disabled = options.enabled === false
  if (options.value) node.classList.add('on')
  node.appendChild(el('span', 'settings-toggle-knob'))
  node.addEventListener('click', (event) => {
    // Same reason as `button()`: settings rows are clickable containers.
    event.stopPropagation()
    options.onChange(!options.value)
  })
  return node
}

/**
 * A select. `value` is assigned *after* the options are appended — assigning it
 * to an empty select silently does nothing, which reads as "the control forgot
 * the user's setting" and is invisible in review.
 */
export function selectField(options: {
  className?: string
  value: string
  ariaLabel: string
  choices: ReadonlyArray<{ value: string; label: string; disabled?: boolean }>
  onChange: (value: string) => void
}): HTMLSelectElement {
  const node = el('select', options.className ?? 'settings-select')
  node.setAttribute('aria-label', options.ariaLabel)
  for (const choice of options.choices) {
    const option = el('option')
    option.value = choice.value
    option.textContent = choice.label
    if (choice.disabled) option.disabled = true
    node.appendChild(option)
  }
  node.value = options.value
  node.addEventListener('change', () => options.onChange(node.value))
  return node
}

/**
 * A pill dropdown: a trigger button plus a `role="listbox"` of buttons.
 *
 * Used for the settings *rows*; the header's project picker and the form fields
 * stay on `selectField`, because a native `<select>` is keyboard- and
 * screen-reader-complete for free and a form is a keyboard flow. Everything this
 * one has to re-implement by hand is below.
 *
 * Open/closed is not held here: it lives in `SettingsState.openMenu`, so a
 * re-render (which rebuilds this whole subtree) reproduces it rather than losing it.
 */
/**
 * `pillSelect` for a *set*: every option is checkable and a click does not close.
 *
 * Shares the `.settings-menu-shell` class rather than inventing one, so
 * `settingsView.ts`'s single `onPressOutside(['.settings-menu-shell'])` closes
 * this too — with `openMenu` and the screen's Escape handler that is all three
 * dismissal routes, none of them written twice.
 */
export function multiSelectField(options: {
  /** The trigger's text: already-formatted, since "none picked" is caller copy. */
  summary: string
  ariaLabel: string
  choices: ReadonlyArray<{ value: string; label: string }>
  selected: readonly string[]
  open: boolean
  onFirstItem?: (item: HTMLButtonElement) => void
  onToggle: () => void
  onToggleValue: (value: string) => void
}): HTMLElement {
  const shell = el('div', 'settings-menu-shell')
  const trigger = button(
    options.open ? 'settings-pill open' : 'settings-pill',
    options.summary,
    options.ariaLabel,
    options.onToggle,
    { trailingIcon: 'chevron-down' },
  )
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', options.open ? 'true' : 'false')
  shell.appendChild(trigger)

  const items: HTMLButtonElement[] = []
  if (options.open) {
    const menu = el('div', 'settings-menu')
    menu.setAttribute('role', 'listbox')
    menu.setAttribute('aria-multiselectable', 'true')
    menu.setAttribute('aria-label', options.ariaLabel)
    for (const choice of options.choices) {
      const checked = options.selected.includes(choice.value)
      // The check lives in its own leading slot in the stylesheet, so a checked
      // and an unchecked label start at the same x.
      const item = button(
        checked ? 'settings-menu-item checkable checked' : 'settings-menu-item checkable',
        choice.label,
        choice.label,
        () => options.onToggleValue(choice.value),
      )
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', checked ? 'true' : 'false')
      if (checked) item.insertBefore(icon('check', 'icon settings-menu-check'), item.firstChild)
      items.push(item)
      menu.appendChild(item)
    }
    shell.appendChild(menu)
    if (items[0]) options.onFirstItem?.(items[0])
  }

  shell.addEventListener('keydown', (event) => rovingFocus(event, items, options.open, options.onToggle))
  return shell
}

export function pillSelect(options: {
  value: string
  ariaLabel: string
  choices: ReadonlyArray<{ value: string; label: string }>
  open: boolean
  /** False while the row's own change is in flight — see `SettingsRow.pending`. */
  enabled?: boolean
  /**
   * Handed the first option while the menu is open, so the caller can focus it
   * *after* this shell is in the page — `focus()` on a detached node does nothing,
   * and this one is built before it is inserted.
   */
  onFirstItem?: (item: HTMLButtonElement) => void
  onToggle: () => void
  onChange: (value: string) => void
}): HTMLElement {
  // The menu is absolutely positioned against this shell. It cannot be a
  // body-level portal: that needs measured coordinates, and the stylesheet test
  // allows exactly one inline style property (`height`).
  const shell = el('div', 'settings-menu-shell')
  const selected = options.choices.find((choice) => choice.value === options.value)
  // Falls back to the raw value: a config that names something outside `choices`
  // must be visible, not silently read as the first option.
  const trigger = button(
    options.open ? 'settings-pill open' : 'settings-pill',
    selected?.label ?? options.value,
    options.ariaLabel,
    options.onToggle,
    { trailingIcon: 'chevron-down', ...(options.enabled === false ? { enabled: false } : {}) },
  )
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', options.open ? 'true' : 'false')
  shell.appendChild(trigger)

  const items: HTMLButtonElement[] = []
  if (options.open) {
    const menu = el('div', 'settings-menu')
    menu.setAttribute('role', 'listbox')
    menu.setAttribute('aria-label', options.ariaLabel)
    for (const choice of options.choices) {
      const current = choice.value === options.value
      const item = button(
        current ? 'settings-menu-item active' : 'settings-menu-item',
        choice.label,
        choice.label,
        () => options.onChange(choice.value),
      )
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', current ? 'true' : 'false')
      items.push(item)
      menu.appendChild(item)
    }
    shell.appendChild(menu)
    if (items[0]) options.onFirstItem?.(items[0])
  }

  shell.addEventListener('keydown', (event) => rovingFocus(event, items, options.open, options.onToggle))

  return shell
}

/**
 * Arrow/Home/End movement across an open menu's items. Shared by the two
 * dropdowns above, which differ only in what a click does.
 */
function rovingFocus(
  event: KeyboardEvent,
  items: readonly HTMLButtonElement[],
  open: boolean,
  onOpen: () => void,
): void {
  const { key } = event
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return
  if (!open) {
    // ArrowDown only opens: the menu does not exist yet, so focusing its first
    // item waits for the render this toggle causes — which is what `onFirstItem`
    // is for. Nothing here can do it, and nothing did until that existed: the
    // trigger this keydown came from is *replaced* by that render, so focus fell
    // to `<body>` and every later arrow key missed this listener entirely.
    if (key !== 'ArrowDown') return
    event.preventDefault()
    event.stopPropagation()
    onOpen()
    return
  }
  if (items.length === 0) return
  // `event.target` rather than `document.activeElement`: the keydown fires on
  // the focused item and bubbles here, so the target *is* the position.
  const at = items.indexOf(event.target as HTMLButtonElement)
  const next =
    key === 'Home'
      ? 0
      : key === 'End'
        ? items.length - 1
        : at < 0
          ? key === 'ArrowDown'
            ? 0
            : items.length - 1
          : (at + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  event.preventDefault()
  event.stopPropagation()
  items[next]?.focus()
}
