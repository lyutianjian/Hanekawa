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
  options: { enabled?: boolean; icon?: IconName } = {},
): HTMLButtonElement {
  const node = el('button', className)
  node.type = 'button'
  node.title = title
  node.setAttribute('aria-label', title)
  // Built up rather than assigned as `textContent`, because an icon child would
  // be wiped by it. An icon-only button passes an empty label and relies on the
  // `aria-label` above for its name.
  if (options.icon) node.appendChild(icon(options.icon))
  if (label) node.appendChild(el('span', 'btn-label', label))
  node.disabled = options.enabled === false
  node.addEventListener('click', (event) => {
    // Rows are clickable too; a button inside one must not also activate it.
    event.stopPropagation()
    onClick()
  })
  return node
}

/**
 * A text input that commits on `change` and on Enter — **never per keystroke**.
 *
 * Every commit here ends in a config write, so a keystroke-level handler would
 * rewrite `config.json` once per character typed and fan a runtime rebuild out
 * to every open lane while doing it.
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
  onCommit: (value: string) => void
}): HTMLInputElement {
  const node = el('input', options.className ?? 'settings-input')
  node.type = 'text'
  node.value = options.value
  node.setAttribute('aria-label', options.ariaLabel)
  if (options.placeholder) node.placeholder = options.placeholder
  if (options.mono) node.classList.add('mono')
  node.addEventListener('change', () => options.onCommit(node.value))
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    event.stopPropagation()
    options.onCommit(node.value)
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
