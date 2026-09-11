import {
  composerChipView,
  insertMentionToken,
  permissionPillView,
  submitButtonView,
} from '../model/composer.js'
import type { AttachmentStripView } from '../model/composerAttachments.js'
import {
  CONTEXT_RATIO_VARIABLE,
  hiddenContextGauge,
  type ContextGaugeView,
} from '../model/usage.js'
import type { RuntimeMenuKey, RuntimeMenuView } from '../model/runtimeMenu.js'
import { submenuIntentDelay, type PointerPoint } from '../model/menuIntent.js'
import type { SurfaceAction, SurfaceRow } from '../model/surfaces.js'
import type { PermissionMode } from '../../../harness/permissions.js'
import type { WireRuntimeSnapshot } from '../../../runtime/protocol/wire.js'
import { el, reconcile, replace, show } from './dom.js'
import { createPresence, finishPresenceWithin, type Presence } from './presence.js'
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
   * *active* pane drives, so a menu left open would hang over the *next* pane's
   * runtime and act on it.
   */
  closeMenus(): void
  /**
   * Paints this pane's draft attachment grid (S11). The grid lives in the
   * capsule above the textarea — it is composer content the way the text is,
   * not a popover. Only the active pane may call this; a background pane
   * passes an empty view to clear the paint.
   */
  renderAttachments(view: AttachmentStripView): void
  /**
   * Why the send button cannot send right now, when it has a say: pending or
   * failed attachments, or drafts against a model with no image capability.
   * Carried on the button's `title`/`aria-label` rather than disabling it —
   * the click still reaches the pane, which explains itself in the transcript.
   */
  setSendBlockNote(note: string | undefined): void
  /** The send gate's title, off the strip the pane just painted. */
  attachStripEl(): HTMLElement
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
  /** The draft attachments' strip host, above the textarea in the capsule. */
  attachStrip: HTMLElement
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
  /** 「选择图片」: the pane puts up the host-side picker (S11). */
  onPickImages: () => void
  /** A draft's ✕. The pane releases the host-side hold for ready drafts. */
  onRemoveAttachment: (draftId: string) => void
  /** A failed draft's 重试. A draft with no source cannot retry. */
  onRetryAttachment: (draftId: string) => void
  /** A ready draft's 打开原图, from the tile's context affordance: host-resolved. */
  onOpenAttachment: (draftId: string) => void
  /** A ready draft's tile, clicked: the pane opens the window's fullscreen viewer. */
  onPreviewAttachment: (draftId: string) => void
  /**
   * The image files a paste carried. Handed as DOM `File`s on purpose: the
   * pane's import owns reading them (`arrayBuffer`) — the view only routes
   * the event, and `model/composerAttachments.ts` stays DOM-free.
   */
  onPasteImages: (files: readonly File[]) => void
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
  els.attach.setAttribute('aria-label', '附件')
  els.attach.title = '添加附件（图片 / @ 引用项目文件）'
  els.progress.setAttribute('aria-hidden', 'true')
  show(els.progress, false)

  // --- the attachment control (S11) ------------------------------------------------
  //
  // One button, two entrances: 选择图片 (a host-side picker over the Electron
  // boundary) and 引用项目文件 (the `@` seed that always lived here, handed to
  // the mention completion). A local menu rather than two buttons, so the bar
  // stays one affordance wide and the `@` path keeps its caret-inserting
  // behaviour untouched.
  let attachMenuOpen = false
  let attachMenu: HTMLElement | undefined
  let attachPresence: Presence | undefined
  let attachItems: HTMLButtonElement[] = []
  /** What the strip was last drawn from; repaints are signed, like the pill's. */
  let attachSignature: string | undefined
  /** The send button's explanatory note, applied to title/aria-label. */
  let sendBlockNote: string | undefined

  function closeAttachMenu(): void {
    const returnFocus = attachMenu?.contains(document.activeElement)
    attachMenuOpen = false
    attachPresence?.set(false)
    els.attach.setAttribute('aria-expanded', 'false')
    els.attach.classList.remove('open')
    if (returnFocus) els.attach.focus()
  }

  function renderAttachMenu(): void {
    if (!attachMenuOpen) {
      closeAttachMenu()
      return
    }
    if (attachMenu) {
      attachPresence!.set(true)
      els.attach.setAttribute('aria-expanded', 'true')
      els.attach.classList.add('open')
      return
    }

    const menu = el('div', 'composer-menu attachment-menu')
    menu.setAttribute('role', 'listbox')
    menu.setAttribute('aria-label', '附件')
    const pickItem = button('composer-menu-item', '选择图片', '选择图片', () => {
      closeAttachMenu()
      actions.onPickImages()
    })
    pickItem.setAttribute('role', 'option')
    pickItem.setAttribute('aria-selected', 'false')
    const mentionItem = button('composer-menu-item', '引用项目文件（@）', '在光标处插入 @，引用项目文件', () => {
      closeAttachMenu()
      const next = insertMentionToken(els.input.value, els.input.selectionStart ?? els.input.value.length)
      els.input.value = next.text
      els.input.setSelectionRange(next.cursorPos, next.cursorPos)
      autosize()
      els.input.focus()
      actions.onAttach()
    })
    mentionItem.setAttribute('role', 'option')
    mentionItem.setAttribute('aria-selected', 'false')
    attachItems.push(pickItem, mentionItem)
    menu.appendChild(pickItem)
    menu.appendChild(mentionItem)
    els.attach.parentElement?.appendChild(menu)
    attachMenu = menu
    attachPresence = createPresence(menu)
    attachPresence.set(true)
    els.attach.setAttribute('aria-expanded', 'true')
    els.attach.classList.add('open')
  }

  els.attach.addEventListener('click', () => {
    attachMenuOpen = !attachMenuOpen
    renderAttachMenu()
    if (attachMenuOpen) attachItems[0]?.focus()
  })
  // Scope dismissal to the menu and trigger, not the surrounding bar.
  const attachShell = els.attach.parentElement ?? els.attach
  onPressOutside([els.attach, '.attachment-menu'], () => {
    if (!attachMenuOpen) return
    closeAttachMenu()
  })
  attachShell.addEventListener('focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget
    if (next === null) return
    if (next instanceof Node && (els.attach.contains(next) || attachMenu?.contains(next))) return
    if (!attachMenuOpen) return
    closeAttachMenu()
  })
  attachShell.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !attachMenuOpen) return
    event.preventDefault()
    event.stopPropagation()
    closeAttachMenu()
    els.attach.focus()
  })

  /**
   * The draft grid. Signed for the reason the pill is: `renderAttachments`
   * follows the runtime snapshot tick, which during a turn is once per chunk,
   * and rebuilding a tile the pointer is on at that rate is what the signature
   * guards exist to stop.
   */
  function renderAttachments(view: AttachmentStripView): void {
    const signature = view.rows
      .map((row) => `${row.draftId}:${row.state}:${row.label}:${row.detail ?? ''}:${row.thumbUrl ?? ''}`)
      .join('|')
    if (signature === attachSignature) {
      setSendBlockNote(view.sendBlockNote)
      return
    }
    attachSignature = signature

    replace(els.attachStrip)
    if (view.rows.length === 0) {
      els.attachStrip.removeAttribute('aria-label')
      setSendBlockNote(view.sendBlockNote)
      return
    }
    els.attachStrip.setAttribute('role', 'list')
    els.attachStrip.setAttribute('aria-label', '待发送图片')
    for (const row of view.rows) {
      els.attachStrip.appendChild(attachmentTileNode(row))
    }
    setSendBlockNote(view.sendBlockNote)
  }

  /**
   * One square tile per draft.
   *
   * The name is not drawn: at 64px a file name is either truncated to nothing
   * or wider than the picture it labels, so it lives in the `title` and the
   * accessible name instead, where it is still one hover or one screen reader
   * away. The two non-ready states keep the tile's box — an import that
   * finishes must not shove the tiles beside it sideways — and carry their
   * words in the same two places.
   */
  function attachmentTileNode(row: AttachmentStripView['rows'][number]): HTMLElement {
    const item = el('div', `attachment-tile ${row.state}`)
    item.setAttribute('role', 'listitem')
    // The name and the state's own words, in the two places a 64px square can
    // carry them: the hover tooltip and the accessible name.
    const described = row.detail === undefined ? row.label : `${row.label}（${row.detail}）`
    item.setAttribute('title', described)
    item.setAttribute('aria-label', described)

    if (row.state === 'ready') {
      // The thumbnail (S12): the pane's on-demand data URL, painted in place.
      // Absent until that load settles — the alt text carries the facts until
      // then, and the arrival is a signature change so the tile repaints once.
      // Clicking it opens the window's fullscreen viewer, which asks the host
      // for a screen-sized copy of its own.
      const thumb = el('img', 'attachment-thumb')
      thumb.setAttribute('alt', row.label)
      if (row.thumbUrl !== undefined) thumb.setAttribute('src', row.thumbUrl)
      thumb.setAttribute('role', 'button')
      thumb.setAttribute('tabindex', '0')
      thumb.addEventListener('click', () => actions.onPreviewAttachment(row.draftId))
      thumb.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key !== 'Enter') return
        actions.onPreviewAttachment(row.draftId)
      })
      item.appendChild(thumb)
    } else {
      // A placeholder of the same size: `importing` pulses, `failed` is a
      // danger-bordered box. Neither is a control — the ✕ and 重试 are — so it
      // is `aria-hidden` and the tile's own label does the talking.
      const placeholder = el('div', 'attachment-placeholder')
      placeholder.setAttribute('aria-hidden', 'true')
      item.appendChild(placeholder)
    }

    if (row.state === 'failed') {
      const retry = button('attachment-retry', '重试', `重新导入 ${row.label}`, () => {
        actions.onRetryAttachment(row.draftId)
      })
      item.appendChild(retry)
    }
    // The corner ✕, over the picture rather than after it: the tile is the
    // whole row now, so the remove has nowhere else to sit.
    const remove = button('attachment-remove', '✕', `移除 ${row.label}`, () => {
      actions.onRemoveAttachment(row.draftId)
    })
    item.appendChild(remove)
    return item
  }

  function setSendBlockNote(note: string | undefined): void {
    if (note === sendBlockNote) return
    sendBlockNote = note
    applySubmitState()
  }

  function applySubmitState(): void {
    const view = submitButtonView({
      streaming: streamingNow,
      empty: els.input.value.trim().length === 0 && (attachSignature ?? '') === '',
    })
    // Enabled in every state: `requestSubmit()` ignores a disabled button, so a
    // grey-but-meaningful button would swallow the click with no error anywhere.
    els.submit.disabled = false
    els.submit.classList.remove('idle', 'ready', 'streaming')
    els.submit.classList.add(view.state)
    // The note rides the button's own tooltip: the click still reaches the
    // pane (which explains itself in the transcript); this is the *why* shown
    // before the click, not a gate the renderer enforces on its own.
    const label = view.state === 'streaming' ? view.label : (sendBlockNote ?? view.label)
    els.submit.setAttribute('aria-label', label)
    els.submit.title = label
    show(els.progress, view.progress)
  }
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
  onPressOutside([els.chipPermission, '.permission-menu'], () => {
    if (!permissionMenuOpen) return
    permissionMenuOpen = false
    renderPermission()
  })
  els.permissionShell.addEventListener('focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget
    if (next === null) return
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
  let permissionPresence: Presence | undefined
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

    if (!view.open) {
      // The model can refuse to open (no snapshot yet); the flag has to follow,
      // or the next click would read as "close" and do nothing visible.
      permissionMenuOpen = false
      const returnFocus = permissionMenu?.contains(document.activeElement)
      permissionPresence?.set(false)
      if (returnFocus) els.chipPermission.focus()
      return
    }

    if (!permissionMenu) {
      permissionMenu = el('div', 'composer-menu permission-menu')
      permissionMenu.setAttribute('role', 'listbox')
      permissionMenu.setAttribute('aria-label', '权限模式')
      permissionItems = view.options.map((option) => {
        const item = button('composer-menu-item', option.label, option.label, () => {
          permissionMenuOpen = false
          renderPermission()
          actions.onSelectPermissionMode(option.mode)
          els.input.focus()
        })
        item.setAttribute('role', 'option')
        return item
      })
      reconcile(permissionMenu, permissionItems)
      els.permissionShell.appendChild(permissionMenu)
      permissionPresence = createPresence(permissionMenu)
    }
    view.options.forEach((option, index) => {
      const item = permissionItems[index]!
      item.classList.toggle('active', option.current)
      item.setAttribute('aria-selected', option.current ? 'true' : 'false')
    })
    permissionPresence!.set(true)
  }

  // --- the chip's popover ------------------------------------------------------

  // Closed the same three ways the permission menu is. Escape unwinds one level
  // at a time — an open flyout first — because a flyout opened by hover would
  // otherwise take the whole popover with it; a press *outside* the chip is not
  // that kind of unwinding and takes the popover whole.
  onPressOutside([els.chipRuntime, '.chip-menu'], () => {
    if (!runtimeMenu) return
    closeRuntimeMenu()
  })
  els.chipShell.addEventListener('focusout', (event) => {
    const next = (event as FocusEvent).relatedTarget
    if (next === null) return
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
  let runtimePresence: Presence | undefined
  let flyoutNode: HTMLElement | undefined
  const flyouts = new Map<RuntimeMenuKey, { node: HTMLElement; presence: Presence; signature: string }>()
  const entryShells = new Map<RuntimeMenuKey, HTMLElement>()
  const entryRows = new Map<RuntimeMenuKey, HTMLButtonElement>()
  let pointer: PointerPoint | undefined
  let flyoutIntent: ReturnType<typeof setTimeout> | undefined

  function closeRuntimeMenu(): void {
    clearTimeout(flyoutIntent)
    runtimeMenuPending = false
    if (!runtimeMenu) return
    const returnFocus = runtimeMenuNode?.contains(document.activeElement)
    runtimeMenu = undefined
    openEntry = undefined
    for (const entry of flyouts.values()) entry.presence.set(false)
    flyoutNode = undefined
    runtimePresence?.set(false)
    els.chipRuntime.setAttribute('aria-expanded', 'false')
    els.chipRuntime.classList.remove('open')
    if (returnFocus) els.chipRuntime.focus()
  }

  function openFlyout(key: RuntimeMenuKey): void {
    clearTimeout(flyoutIntent)
    // The guard is what breaks the hover loop described above, and it also makes
    // a second `mouseenter` on the same row a no-op rather than a rebuild that
    // drops the keyboard position inside the flyout.
    if (openEntry === key) return
    openEntry = key
    renderFlyout()
  }

  function hoverFlyout(key: RuntimeMenuKey, point: PointerPoint): void {
    clearTimeout(flyoutIntent)
    const delay = openEntry && openEntry !== key && flyoutNode
      ? submenuIntentDelay(pointer, point, flyoutNode.getBoundingClientRect()) : 0
    if (delay === 0) openFlyout(key)
    else flyoutIntent = setTimeout(() => openFlyout(key), delay)
  }

  function renderFlyout(): void {
    flyoutNode = undefined
    for (const [key, entry] of flyouts) entry.presence.set(!!runtimeMenu && key === openEntry)
    for (const [key, row] of entryRows) {
      row.classList.toggle('open', key === openEntry)
      row.setAttribute('aria-expanded', key === openEntry ? 'true' : 'false')
    }
    if (!runtimeMenu || !openEntry) return
    const entry = runtimeMenu.entries.find((candidate) => candidate.key === openEntry)
    const shell = entryShells.get(openEntry)
    if (!entry || !shell) return

    let kept = flyouts.get(openEntry)
    if (!kept) {
      const node = el('div', 'chip-flyout')
      node.setAttribute('role', 'listbox')
      node.addEventListener('mouseenter', () => clearTimeout(flyoutIntent))
      shell.appendChild(node)
      kept = { node, presence: createPresence(node, { direction: 'slide' }), signature: '' }
      flyouts.set(openEntry, kept)
    }
    const signature = JSON.stringify(entry)
    if (signature !== kept.signature) {
      kept.signature = signature
      kept.node.setAttribute('aria-label', entry.title)
      replace(kept.node, el('div', 'chip-flyout-title', entry.title), ...entry.rows.map(flyoutItem))
    }
    kept.presence.set(true)
    flyoutNode = kept.node
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
  const contextRing = el('span', 'context-gauge')
  contextRing.setAttribute('aria-hidden', 'true')
  const contextTooltip = el('div', 'context-tooltip')
  contextTooltip.setAttribute('role', 'tooltip')
  contextTooltip.setAttribute('aria-hidden', 'true')
  const contextPercent = el('strong', 'context-tooltip-percent')
  const contextRows = el('dl', 'context-tooltip-rows')
  const contextValues = new Map<string, { row: HTMLElement; value: HTMLElement }>()
  reconcile(contextTooltip, [
    el('div', 'context-tooltip-header', el('span', 'context-tooltip-title', '上下文'), contextPercent),
    contextRows,
    el('p', 'context-tooltip-note', '可用上限已预留自动压缩空间'),
  ])
  const contextPresence = createPresence(contextTooltip, { decorative: true })
  let contextHovered = false
  let contextFocused = false
  const syncContext = (): void => contextPresence.set(contextGauge.visible && (contextHovered || contextFocused))
  els.contextIndicator.tabIndex = 0
  els.contextIndicator.addEventListener('mouseenter', () => { contextHovered = true; syncContext() })
  els.contextIndicator.addEventListener('mouseleave', () => { contextHovered = false; syncContext() })
  els.contextIndicator.addEventListener('focusin', () => { contextFocused = true; syncContext() })
  els.contextIndicator.addEventListener('focusout', (event) => {
    if (event.relatedTarget === null) return
    contextFocused = false
    syncContext()
  })
  const closeContext = (): void => { contextHovered = false; contextFocused = false; syncContext() }
  onPressOutside([els.contextIndicator], closeContext)
  els.contextIndicator.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    closeContext()
  })

  function renderContextGauge(): void {
    const signature = [
      contextGauge.visible ? `${contextGauge.level}:${contextGauge.ratio}:${contextGauge.title}` : '',
    ].join(' ')
    if (signature === contextSignature) return
    contextSignature = signature

    show(els.contextIndicator, contextGauge.visible)
    if (!contextGauge.visible) {
      closeContext()
      contextPresence.finish()
      replace(els.contextIndicator)
      els.contextIndicator.removeAttribute('aria-label')
      return
    }

    contextRing.className = `context-gauge ${contextGauge.level}`
    contextRing.style.setProperty(CONTEXT_RATIO_VARIABLE, String(contextGauge.ratio))
    reconcile(els.contextIndicator, [contextRing, contextTooltipNode(contextGauge)])
    els.contextIndicator.setAttribute('role', 'img')
    els.contextIndicator.setAttribute('aria-label', contextGauge.title.replace(/\n/g, '；'))
  }

  function contextTooltipNode(gauge: ContextGaugeView): HTMLElement {
    const values: Array<[string, string]> = [
      ['已用', gauge.used],
      ['可用上限', gauge.usable],
    ]
    if (gauge.modelWindow) values.push(['模型窗口', gauge.modelWindow])
    const rows = values.map(([label, value]) => {
      let kept = contextValues.get(label)
      if (!kept) {
        const field = el('dd', 'context-tooltip-value')
        kept = { row: el('div', 'context-tooltip-row', el('dt', 'context-tooltip-label', label), field), value: field }
        contextValues.set(label, kept)
      }
      if (kept.value.textContent !== value) kept.value.textContent = value
      return kept.row
    })
    contextPercent.textContent = `${gauge.percent} 已用`
    reconcile(contextRows, rows)
    return contextTooltip
  }

  els.input.addEventListener('input', () => applySubmitState())
  // Paste: an image in the clipboard becomes an attachment rather than text.
  // Only files make that call — a plain-text paste, even of a path, stays the
  // textarea's business (path pastes are the TUI's rule; here the picker, drag
  // and paste cover the image entrances). The event is left alone otherwise,
  // so the browser's own text insert still runs.
  const onPasteImages = actions.onPasteImages
  els.input.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files ?? [])
    if (files.length === 0 || !files.some((file) => file.type.startsWith('image/'))) return
    event.preventDefault()
    onPasteImages(files)
  })
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

      if (!runtimeMenuNode) {
        runtimeMenuNode = el('div', 'chip-menu')
        runtimeMenuNode.setAttribute('role', 'menu')
        runtimeMenuNode.setAttribute('aria-label', '模型与推理强度')
        runtimeMenuNode.addEventListener('mousemove', (event) => { pointer = { x: event.clientX, y: event.clientY } })
        els.chipShell.appendChild(runtimeMenuNode)
        runtimePresence = createPresence(runtimeMenuNode)
      }
      const menu = runtimeMenuNode
      const shells = view.entries.map((entry) => {
        let shell = entryShells.get(entry.key)
        let row = entryRows.get(entry.key)
        if (shell && row) {
          row.title = `${entry.label}：${entry.value}`
          row.setAttribute('aria-label', row.title)
          row.querySelector('.chip-menu-value')!.textContent = entry.value
          return shell
        }
        shell = el('div', 'chip-menu-shell')
        row = button(
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
        row.addEventListener('mouseenter', (event) => hoverFlyout(entry.key, { x: event.clientX, y: event.clientY }))
        row.addEventListener('keydown', (event) => {
          if ((event as KeyboardEvent).key !== 'ArrowRight') return
          event.preventDefault()
          event.stopPropagation()
          openFlyout(entry.key)
        })
        shell.appendChild(row)
        entryShells.set(entry.key, shell)
        entryRows.set(entry.key, row)
        return shell
      })
      reconcile(menu, shells)
      runtimePresence!.set(true)
      els.chipRuntime.setAttribute('aria-expanded', 'true')
      els.chipRuntime.classList.add('open')
      // Focused, not flown out: the popover opens as its two rows, and the
      // keyboard still has somewhere to be.
      entryRows.get(view.entries[0]?.key ?? 'model')?.focus()
    },
    refreshSubmit: applySubmitState,
    renderAttachments,
    setSendBlockNote,
    attachStripEl: () => els.attachStrip,
    closeMenus() {
      closeRuntimeMenu()
      closeAttachMenu()
      closeContext()
      contextPresence.finish()
      if (permissionMenuOpen) {
        permissionMenuOpen = false
        renderPermission()
      }
      // Called on pane switches: no outgoing visual may overlay the next pane.
      finishPresenceWithin(els.chipShell)
      finishPresenceWithin(els.permissionShell)
      finishPresenceWithin(attachShell)
    },
    autosize,
  }
}
