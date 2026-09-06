import {
  composerChipView,
  insertMentionToken,
  permissionPillView,
  submitButtonView,
} from '../model/composer.js'
import {
  CONTEXT_RATIO_VARIABLE,
  hiddenContextGauge,
  type ContextGaugeView,
} from '../model/usage.js'
import type { RuntimeMenuKey, RuntimeMenuView } from '../model/runtimeMenu.js'
import type { SurfaceAction, SurfaceRow } from '../model/surfaces.js'
import type { PermissionMode } from '../../../harness/permissions.js'
import type { WireRuntimeSnapshot } from '../../../runtime/protocol/wire.js'
import { el, replace, show } from './dom.js'
import { button } from './controls.js'
import { onPressOutside } from './dismiss.js'
import { icon } from './icons.js'

/**
 * The composer: a capsule containing the textarea and an inline action bar.
 *
 * `design_guidance.md`'s anchored composite input — attachment control bottom
 * left, a "model · effort" chip and a round send button bottom right. The chip
 * is where stage-4 decision 4 lands: effort is adjustable next to the message
 * it will affect, and never appears in settings.
 * The context-occupancy indicator sits to the chip's left: it reports the live
 * turn's budget, but it is not part of the decision the chip opens.
 *
 * The chip is **one** button for both fields, and it opens a local popover
 * rather than the full-width `#surface` card: two rows naming model and effort
 * with their current values, each flying out into the levels it can take. The
 * `#surface` pickers are untouched — `/model` and `/effort` still open them —
 * so the chip is a second *route* to the choice, never a second answer about
 * what the options are: `model/runtimeMenu.ts` builds its rows out of the same
 * `modelPickerView` / `effortPickerView` those cards use.
 *
 * Choosing from the flyout runs the row's `SurfaceAction`, which is a
 * `run-command` (`/model …`, `/effort …`) rather than `SessionClient.setModel` /
 * `setEffort`. That is the rule `model/surfaces.ts` already states: the slash
 * command is the user expressing a preference, and it is what writes the choice
 * back to config — `setModel` only points the live runtime somewhere else and
 * silently drops the persistence.
 *
 * The permission pill beside `+` is the exception, and deliberately so: the mode
 * *is* the live gate's state, there is nothing to persist, and the settings
 * screen's `permissions.mode` is only the startup mode. So it calls
 * `set-permission-mode` directly and its menu is built here rather than opened
 * as a surface — four fixed options do not need a picker panel.
 */

export interface ComposerView {
  value(): string
  /**
   * The caret offset. `applyFileSuggestion` splices over the `@…` token that
   * ends here, so "the end of the text" is not a usable substitute — a mention
   * edited in the middle of a line would rewrite the wrong span.
   */
  cursorPos(): number
  setValue(text: string, cursorPos?: number): void
  clear(): void
  focus(): void
  /**
   * Retargets the submit button between sending and queueing.
   *
   * It used to *disable* the button, because a second `SessionController.submit`
   * would overwrite the live `AbortController` and leave the first turn
   * impossible to interrupt. The kernel now rejects that outright, so mid-turn
   * input has somewhere to go: the host's message queue. Both this button and the
   * Enter path have to agree on which it is — `requestSubmit()` ignores a
   * disabled button, so a mismatch here silently swallows a click.
   */
  setStreaming(streaming: boolean): void
  /**
   * Repaints the runtime controls — the context indicator, model · effort chip,
   * and permission pill. Driven by the active pane's snapshot, including a
   * missing one, so a pane that has not finished starting shows placeholders
   * rather than the previous pane's model.
   */
  renderRuntime(runtime: WireRuntimeSnapshot | undefined, gauge?: ContextGaugeView): void
  /**
   * Opens the chip's popover with the rows the pane just built.
   *
   * The pane answers `onOpenRuntimeMenu` asynchronously (the model list is a
   * round trip), so this can arrive after the user has clicked again or after
   * the pane went to the background. It is honoured only while an open is still
   * outstanding, which is what stops a menu appearing over the *next* pane.
   */
  showRuntimeMenu(view: RuntimeMenuView): void
  /**
   * Recomputes the send button's three visual states. Called on every keystroke,
   * because emptiness is one of the inputs.
   */
  refreshSubmit(): void
  /**
   * Shuts any transient popup the composer owns.
   *
   * Called when a pane goes to the background: the composer is a singleton the
   * *active* pane drives, so a menu left open would hang over the next pane's
   * runtime and act on it.
   */
  closeMenus(): void
  autosize(): void
}

export const MAX_COMPOSER_HEIGHT_PX = 200

export function createComposerView(els: {
  input: HTMLTextAreaElement
  submit: HTMLButtonElement
  stop: HTMLButtonElement
  attach: HTMLButtonElement
  /** The context-occupancy indicator, immediately left of the runtime chip. */
  contextIndicator: HTMLElement
  /** The model · effort status label, and the shell its popover is drawn into. */
  chipRuntime: HTMLButtonElement
  chipShell: HTMLElement
  /** The permission-mode pill's trigger, and the shell its menu is drawn into. */
  chipPermission: HTMLButtonElement
  permissionShell: HTMLElement
  /** The spinning ring beside the chip while a turn is in flight. */
  progress: HTMLElement
}, actions: {
  /** Asks the pane for the menu's rows; answered by `showRuntimeMenu`. */
  onOpenRuntimeMenu: () => void
  /** A row chosen in a flyout — the pane's `runSurfaceAction`. */
  onRuntimeAction: (action: SurfaceAction) => void
  /** Applies a permission mode to the *live* gate — see `permissionPillView`. */
  onSelectPermissionMode: (mode: PermissionMode) => void
  /**
   * The attachment control. There is no host command behind a file dialog, so
   * it seeds an `@` and lets the existing mention completion take over — the
   * same path typing `@` follows. The callback is what tells the pane to
   * recompute completions, since a programmatic edit fires no `input` event.
   */
  onAttach: () => void
}): ComposerView {
  const autosize = () => {
    // Kept in step with `#composer` / `#input`'s `max-height` in `styles.css`;
    // this one is load-bearing, because `scrollHeight` has to be clamped by
    // something the stylesheet cannot know.
    els.input.style.height = 'auto'
    els.input.style.height = `${Math.min(els.input.scrollHeight, MAX_COMPOSER_HEIGHT_PX)}px`
  }

  // The last snapshot this view painted, so opening the menu can redraw the pill
  // without waiting for the host to post another one.
  let runtimeSnapshot: WireRuntimeSnapshot | undefined
  /** The context-occupancy indicator's state, painted independently of the chip. */
  let contextGauge: ContextGaugeView = hiddenContextGauge()
  let permissionMenuOpen = false
  let streamingNow = false
  /** The chip's popover: its rows while open, `undefined` while shut. */
  let runtimeMenu: RuntimeMenuView | undefined
  /** An open asked for and not yet answered; see `showRuntimeMenu`. */
  let runtimeMenuPending = false
  /** At most one flyout at a time — a menu, not a tree. */
  let openEntry: RuntimeMenuKey | undefined

  // Icon-only controls; the accessible name comes from `aria-label`, refreshed
  // by `setStreaming` for the one button whose meaning changes.
  replace(els.submit, icon('send'))
  replace(els.stop, icon('stop'))
  replace(els.attach, icon('plus'))
  replace(els.progress, icon('spinner'))
  els.attach.setAttribute('aria-label', '插入文件引用')
  els.attach.title = '插入文件引用（@）'
  els.progress.setAttribute('aria-hidden', 'true')
  show(els.progress, false)

  els.attach.addEventListener('click', () => {
    const next = insertMentionToken(els.input.value, els.input.selectionStart ?? els.input.value.length)
    els.input.value = next.text
    els.input.setSelectionRange(next.cursorPos, next.cursorPos)
    autosize()
    els.input.focus()
    actions.onAttach()
  })
  els.chipRuntime.addEventListener('click', () => {
    if (runtimeMenu) {
      closeRuntimeMenu()
      return
    }
    // Asked for, not opened: the rows need a round trip, and the answer comes
    // back through `showRuntimeMenu`.
    runtimeMenuPending = true
    actions.onOpenRuntimeMenu()
  })
  els.chipPermission.addEventListener('click', () => {
    permissionMenuOpen = !permissionMenuOpen
    renderPermission()
    if (permissionMenuOpen) firstMenuItem()?.focus()
  })

  // Closed three ways: a press outside the shell, focus leaving it, and Escape.
  // `relatedTarget` is where focus *went*, so a click on a menu item — which
  // happens before the item's own `click` — must not close it. The shell, not
  // the menu, so the pill can still toggle its own popover shut.
  onPressOutside([els.permissionShell], () => {
    if (!permissionMenuOpen) return
    permissionMenuOpen = false
    renderPermission()
  })
  els.permissionShell.addEventListener('focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget
    if (next instanceof Node && els.permissionShell.contains(next)) return
    if (!permissionMenuOpen) return
    permissionMenuOpen = false
    renderPermission()
  })
  els.permissionShell.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !permissionMenuOpen) return
    // Consumed here, so Escape over an open menu does not also reach the global
    // key map and close a surface or a dialog behind it.
    event.preventDefault()
    event.stopPropagation()
    permissionMenuOpen = false
    renderPermission()
    els.chipPermission.focus()
  })

  // Held rather than looked up: `querySelector` is not on the DOM surface
  // `test/helpers/domStub.ts` fakes, and a view that reaches for it would be
  // untestable for the sake of a search it already knows the answer to.
  let permissionMenu: HTMLElement | undefined
  let permissionItems: HTMLButtonElement[] = []
  /** What the pill and the chip were last drawn from; see `renderPermission`. */
  let permissionSignature: string | undefined
  let chipSignature: string | undefined
  let contextSignature: string | undefined

  function firstMenuItem(): HTMLButtonElement | undefined {
    return permissionItems[0]
  }

  function renderPermission(): void {
    const view = permissionPillView({ runtime: runtimeSnapshot, open: permissionMenuOpen })
    // `renderRuntime` runs on every snapshot, which during a turn is once per
    // streamed chunk, and the two `replace()` calls below rebuild this pill and
    // its menu whole. Nothing under the pointer may be rebuilt for a repaint
    // that changed nothing — the same rule `dom/settingsView.ts` keeps by id.
    // The open flags are part of the signature, or the guard would swallow the
    // click that opens the menu (`sidebarRenderSignature`'s `menuOpen`).
    const signature = [
      view.label,
      view.title,
      view.enabled ? '1' : '0',
      view.open ? '1' : '0',
      permissionMenuOpen ? '1' : '0',
      view.open ? view.options.map((option) => `${option.mode}:${option.current ? '1' : '0'}`).join(',') : '',
    ].join(' ')
    if (signature === permissionSignature) return
    permissionSignature = signature

    // The pill's own label lives in a span, so the chevron survives a repaint.
    replace(els.chipPermission, el('span', 'btn-label', view.label), icon('chevron-down'))
    els.chipPermission.title = view.title
    els.chipPermission.setAttribute('aria-label', view.title)
    els.chipPermission.setAttribute('aria-haspopup', 'listbox')
    els.chipPermission.setAttribute('aria-expanded', view.open ? 'true' : 'false')
    els.chipPermission.disabled = !view.enabled
    els.chipPermission.classList.toggle('open', view.open)

    // Rebuilt rather than hidden: the menu is a list of buttons, and a hidden
    // button is still a Tab stop in some engines.
    permissionMenu?.remove()
    permissionMenu = undefined
    permissionItems = []
    if (!view.open) {
      // The model can refuse to open (no snapshot yet); the flag has to follow,
      // or the next click would read as "close" and do nothing visible.
      permissionMenuOpen = false
      return
    }

    const menu = el('div', 'composer-menu')
    menu.setAttribute('role', 'listbox')
    menu.setAttribute('aria-label', '权限模式')
    for (const option of view.options) {
      const item = button(
        option.current ? 'composer-menu-item active' : 'composer-menu-item',
        option.label,
        option.label,
        () => {
          permissionMenuOpen = false
          renderPermission()
          actions.onSelectPermissionMode(option.mode)
          els.input.focus()
        },
      )
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', option.current ? 'true' : 'false')
      permissionItems.push(item)
      menu.appendChild(item)
    }
    els.permissionShell.appendChild(menu)
    permissionMenu = menu
  }

  // --- the chip's popover ------------------------------------------------------

  // Closed the same three ways the permission menu is. Escape unwinds one level
  // at a time — an open flyout first — because a flyout opened by hover would
  // otherwise take the whole popover with it; a press *outside* the chip is not
  // that kind of unwinding and takes the popover whole.
  onPressOutside([els.chipShell], () => {
    if (!runtimeMenu) return
    closeRuntimeMenu()
  })
  els.chipShell.addEventListener('focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget
    if (next instanceof Node && els.chipShell.contains(next)) return
    if (!runtimeMenu) return
    closeRuntimeMenu()
  })
  els.chipShell.addEventListener('keydown', (event) => {
    if (!runtimeMenu) return
    if (event.key !== 'Escape' && event.key !== 'ArrowLeft') return
    // Consumed here, so Escape over an open menu does not also reach the global
    // key map and close a surface or a dialog behind it.
    event.preventDefault()
    event.stopPropagation()
    if (openEntry) {
      const row = entryRows.get(openEntry)
      openEntry = undefined
      renderFlyout()
      row?.focus()
      return
    }
    if (event.key === 'ArrowLeft') return
    closeRuntimeMenu()
    els.chipRuntime.focus()
  })

  // The popover's nodes are built once per open and then *kept*: the flyout is
  // driven by hover, and rebuilding the row under the pointer would fire
  // `mouseenter` again on the replacement — a render loop with no exit.
  let runtimeMenuNode: HTMLElement | undefined
  let flyoutNode: HTMLElement | undefined
  const entryShells = new Map<RuntimeMenuKey, HTMLElement>()
  const entryRows = new Map<RuntimeMenuKey, HTMLButtonElement>()

  function closeRuntimeMenu(): void {
    runtimeMenuPending = false
    if (!runtimeMenu) return
    runtimeMenu = undefined
    openEntry = undefined
    flyoutNode?.remove()
    flyoutNode = undefined
    runtimeMenuNode?.remove()
    runtimeMenuNode = undefined
    entryShells.clear()
    entryRows.clear()
    els.chipRuntime.setAttribute('aria-expanded', 'false')
    els.chipRuntime.classList.remove('open')
  }

  function openFlyout(key: RuntimeMenuKey): void {
    // The guard is what breaks the hover loop described above, and it also makes
    // a second `mouseenter` on the same row a no-op rather than a rebuild that
    // drops the keyboard position inside the flyout.
    if (openEntry === key) return
    openEntry = key
    renderFlyout()
  }

  function renderFlyout(): void {
    flyoutNode?.remove()
    flyoutNode = undefined
    for (const [key, row] of entryRows) {
      row.classList.toggle('open', key === openEntry)
      row.setAttribute('aria-expanded', key === openEntry ? 'true' : 'false')
    }
    if (!runtimeMenu || !openEntry) return
    const entry = runtimeMenu.entries.find((candidate) => candidate.key === openEntry)
    const shell = entryShells.get(openEntry)
    if (!entry || !shell) return

    const flyout = el('div', 'chip-flyout')
    flyout.setAttribute('role', 'listbox')
    flyout.setAttribute('aria-label', entry.title)
    flyout.appendChild(el('div', 'chip-flyout-title', entry.title))
    for (const row of entry.rows) flyout.appendChild(flyoutItem(row))
    shell.appendChild(flyout)
    flyoutNode = flyout
  }

  function flyoutItem(row: SurfaceRow): HTMLButtonElement {
    const action = row.action
    const classes = ['chip-flyout-item']
    if (row.current) classes.push('active')
    if (row.disabled) classes.push('disabled')
    const item = button(
      classes.join(' '),
      row.label,
      row.disabledReason ?? row.label,
      () => {
        if (!action) return
        closeRuntimeMenu()
        actions.onRuntimeAction(action)
        els.input.focus()
      },
      { enabled: action !== undefined },
    )
    item.setAttribute('role', 'option')
    item.setAttribute('aria-selected', row.current ? 'true' : 'false')
    // A reason is why the row cannot be picked (an effort level over the model's
    // ceiling); a detail is a fact about one that can. Never both — see `SurfaceRow`.
    const note = row.disabledReason ?? row.detail
    if (note) item.appendChild(el('span', 'chip-flyout-note', note))
    if (row.current) item.appendChild(icon('check'))
    return item
  }

  function renderChip(): void {
    const chip = composerChipView(runtimeSnapshot)
    // Signed for the reason the permission pill is: this runs per streamed
    // chunk and the `replace()` below rebuilds the whole button.
    const signature = [
      chip.model,
      chip.effort,
      chip.title,
      chip.enabled ? '1' : '0',
    ].join(' ')
    if (signature === chipSignature) return
    chipSignature = signature

    // Spans in one button: the model has to be replaceable without taking the
    // effort level with it, and nesting buttons is invalid markup.
    replace(
      els.chipRuntime,
      el('span', 'chip-model-label', chip.model),
      el('span', 'chip-effort-label', chip.effort),
    )
    const title = chip.title
    els.chipRuntime.title = title
    els.chipRuntime.setAttribute('aria-label', title)
    els.chipRuntime.setAttribute('aria-haspopup', 'menu')
    els.chipRuntime.disabled = !chip.enabled
  }

  /**
   * The independent occupancy indicator. The parent carries the figures as an
   * accessible name; the ring and tooltip are presentation, so colour is never
   * the only carrier. The whole subtree is signed for the same reason the chip
   * is: streaming repaints must not rebuild a tooltip the pointer is over.
   */
  function renderContextGauge(): void {
    const signature = [
      contextGauge.visible ? `${contextGauge.level}:${contextGauge.ratio}:${contextGauge.title}` : '',
    ].join(' ')
    if (signature === contextSignature) return
    contextSignature = signature

    show(els.contextIndicator, contextGauge.visible)
    if (!contextGauge.visible) {
      replace(els.contextIndicator)
      els.contextIndicator.removeAttribute('aria-label')
      return
    }

    const ring = el('span', `context-gauge ${contextGauge.level}`)
    ring.setAttribute('aria-hidden', 'true')
    ring.style.setProperty(CONTEXT_RATIO_VARIABLE, String(contextGauge.ratio))
    replace(els.contextIndicator, ring, contextTooltipNode(contextGauge))
    els.contextIndicator.setAttribute('role', 'img')
    els.contextIndicator.setAttribute('aria-label', contextGauge.title.replace(/\n/g, '；'))
  }

  function contextTooltipNode(gauge: ContextGaugeView): HTMLElement {
    const tooltip = el('div', 'context-tooltip')
    tooltip.setAttribute('role', 'tooltip')
    tooltip.setAttribute('aria-hidden', 'true')

    const rows = el('dl', 'context-tooltip-rows')
    const values: Array<[string, string]> = [
      ['已用', gauge.used],
      ['可用上限', gauge.usable],
    ]
    if (gauge.modelWindow) values.push(['模型窗口', gauge.modelWindow])
    for (const [label, value] of values) {
      const row = el('div', 'context-tooltip-row')
      row.appendChild(el('dt', 'context-tooltip-label', label))
      row.appendChild(el('dd', 'context-tooltip-value', value))
      rows.appendChild(row)
    }

    tooltip.appendChild(el(
      'div',
      'context-tooltip-header',
      el('span', 'context-tooltip-title', '上下文'),
      el('strong', 'context-tooltip-percent', `${gauge.percent} 已用`),
    ))
    tooltip.appendChild(rows)
    tooltip.appendChild(el('p', 'context-tooltip-note', '可用上限已预留自动压缩空间'))
    return tooltip
  }

  function applySubmitState(): void {
    const view = submitButtonView({
      streaming: streamingNow,
      empty: els.input.value.trim().length === 0,
    })
    // Enabled in every state: `requestSubmit()` ignores a disabled button, so a
    // grey-but-meaningful button would swallow the click with no error anywhere.
    els.submit.disabled = false
    els.submit.classList.remove('idle', 'ready', 'streaming')
    els.submit.classList.add(view.state)
    els.submit.setAttribute('aria-label', view.label)
    els.submit.title = view.label
    show(els.progress, view.progress)
  }

  els.input.addEventListener('input', () => applySubmitState())
  // Painted before the first snapshot too, or the chip stays enabled with
  // `index.html`'s placeholder in it and opens a menu of nothing.
  renderChip()
  renderContextGauge()
  renderPermission()
  applySubmitState()

  return {
    value: () => els.input.value,
    // `selectionStart` is null only for input types that have no selection;
    // a textarea always reports one, and the end of the text is the safe read.
    cursorPos: () => els.input.selectionStart ?? els.input.value.length,
    setValue(text, cursorPos) {
      els.input.value = text
      if (cursorPos !== undefined) els.input.setSelectionRange(cursorPos, cursorPos)
      autosize()
      // A programmatic edit fires no `input` event, so the button state has to be
      // recomputed by hand — otherwise a restored draft leaves it reading "idle".
      applySubmitState()
    },
    clear() {
      els.input.value = ''
      autosize()
      applySubmitState()
    },
    focus() {
      els.input.focus()
    },
    setStreaming(streaming) {
      // Stop appears alongside the send button rather than instead of it:
      // interrupting the turn and queueing the next message are both things a
      // user may want mid-turn, and the round button keeps meaning "send or
      // queue" so it agrees with `model/keymap.ts`. See `submitButtonView`.
      streamingNow = streaming
      applySubmitState()
      show(els.stop, streaming)
    },
    renderRuntime(runtime, gauge) {
      runtimeSnapshot = runtime
      contextGauge = gauge ?? hiddenContextGauge()
      renderChip()
      renderContextGauge()
      renderPermission()
    },
    showRuntimeMenu(view) {
      // A late answer: the user has clicked again, or the pane went to the
      // background and `closeMenus` cleared the request.
      if (!runtimeMenuPending) return
      runtimeMenuPending = false
      // The model can refuse to open (no snapshot yet); nothing is drawn, and the
      // next click asks again rather than reading as "close".
      if (!view.enabled) return
      closeRuntimeMenu()
      runtimeMenu = view

      const menu = el('div', 'chip-menu')
      menu.setAttribute('role', 'menu')
      menu.setAttribute('aria-label', '模型与推理强度')
      for (const entry of view.entries) {
        const shell = el('div', 'chip-menu-shell')
        const row = button(
          'chip-menu-row',
          entry.label,
          `${entry.label}：${entry.value}`,
          () => openFlyout(entry.key),
        )
        row.setAttribute('role', 'menuitem')
        row.setAttribute('aria-haspopup', 'listbox')
        row.setAttribute('aria-expanded', 'false')
        row.appendChild(el('span', 'chip-menu-value', entry.value))
        row.appendChild(icon('chevron-right'))
        // Hover is the affordance the flyout is designed around. Focus is
        // deliberately *not* one of them: the popover focuses its first row when
        // it opens, and a flyout on focus would mean the popover never appears
        // as the two rows it is — the model list would be over it already.
        // `ArrowRight` and Enter are the keyboard's way in.
        row.addEventListener('mouseenter', () => openFlyout(entry.key))
        row.addEventListener('keydown', (event) => {
          if ((event as KeyboardEvent).key !== 'ArrowRight') return
          event.preventDefault()
          event.stopPropagation()
          openFlyout(entry.key)
        })
        shell.appendChild(row)
        menu.appendChild(shell)
        entryShells.set(entry.key, shell)
        entryRows.set(entry.key, row)
      }
      els.chipShell.appendChild(menu)
      runtimeMenuNode = menu
      els.chipRuntime.setAttribute('aria-expanded', 'true')
      els.chipRuntime.classList.add('open')
      // Focused, not flown out: the popover opens as its two rows, and the
      // keyboard still has somewhere to be.
      entryRows.get(view.entries[0]?.key ?? 'model')?.focus()
    },
    refreshSubmit: applySubmitState,
    closeMenus() {
      closeRuntimeMenu()
      if (!permissionMenuOpen) return
      permissionMenuOpen = false
      renderPermission()
    },
    autosize,
  }
}
