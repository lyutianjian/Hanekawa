import { isMounted, nextPhase, phaseClass, PRESENCE_FALLBACK_MS, type Phase, type PresenceKind } from '../model/presence.js'

export interface Presence {
  readonly phase: Phase
  set(open: boolean, immediate?: boolean): void
  finish(): void
  dispose(): void
}

const controllers = new WeakMap<HTMLElement, Presence>()

/** CSS transitions retarget the current visual value, including during reversal. */
export function createPresence(node: HTMLElement, options: {
  kind?: PresenceKind
  direction?: 'rise' | 'drop' | 'slide' | 'none'
  property?: string
  onClosed?: () => void
  onPhase?: (phase: Phase) => void
  decorative?: boolean
} = {}): Presence {
  const kind = options.kind ?? 'popover'
  let phase: Phase = 'closed'
  let want = false
  let epoch = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  node.classList.add('presence', `presence-${options.direction ?? 'rise'}`)
  node.setAttribute('data-presence', kind)

  function paint(next: Phase): void {
    const previous = phase
    node.classList.remove(phaseClass(phase))
    phase = next
    node.classList.add(phaseClass(phase))
    node.hidden = !isMounted(phase)
    if (want) node.removeAttribute('inert')
    else node.setAttribute('inert', '')
    if (!options.decorative) node.setAttribute('aria-hidden', String(!want))
    options.onPhase?.(phase)
    if (phase === 'closed' && previous !== 'closed') options.onClosed?.()
  }

  function finish(): void {
    epoch += 1
    clearTimeout(timer)
    timer = undefined
    paint(nextPhase(phase, want, 'settled'))
  }

  function ended(event: TransitionEvent): void {
    if (event.target !== node || event.propertyName !== (options.property ?? 'opacity')) return
    if (phase === 'entering' || phase === 'closing') finish()
  }
  node.addEventListener('transitionend', ended)
  paint('closed')

  const handle: Presence = {
    get phase() { return phase },
    set(open, immediate = false) {
      if (open === want && !immediate) return
      want = open
      const version = ++epoch
      clearTimeout(timer)
      if (open && phase === 'closed' && !immediate) {
        // Commit the start geometry once. Subsequent intents keep the node in
        // place and let CSS reverse from the currently interpolated value.
        node.hidden = false
        node.getBoundingClientRect()
      }
      paint(nextPhase(phase, want, 'intent'))
      if (immediate) { finish(); return }
      if (phase !== 'entering' && phase !== 'closing') return
      timer = setTimeout(() => {
        if (version === epoch) finish()
      }, PRESENCE_FALLBACK_MS[kind])
      ;(timer as unknown as { unref?: () => void }).unref?.()
    },
    finish,
    dispose() {
      want = false
      paint(nextPhase(phase, false, 'intent'))
      finish()
      node.removeEventListener('transitionend', ended)
      controllers.delete(node)
    },
  }
  controllers.set(node, handle)
  return handle
}

/** Pane/window hiding finishes visual work without touching business state. */
export function finishPresenceWithin(root: ParentNode): void {
  if (root instanceof HTMLElement) controllers.get(root)?.finish()
  for (const node of root.querySelectorAll<HTMLElement>('[data-presence]')) controllers.get(node)?.finish()
}

/** One lifecycle, two visual tracks. The scrim stays mounted until the panel
 * settles; its shorter fade ends with the panel's exit. Business settlement is
 * the caller's immediate intent, never this controller's onClosed callback. */
export function createModalPresence(container: HTMLElement, panel: HTMLElement, onClosed: () => void): Presence {
  container.classList.add('modal-layer')
  let previous: Phase = 'closed'
  const presence = createPresence(panel, {
    kind: 'panel',
    onClosed,
    onPhase(phase) {
      container.classList.remove(phaseClass(previous))
      container.classList.add(phaseClass(phase))
      previous = phase
      container.hidden = !isMounted(phase)
      const interactive = phase === 'entering' || phase === 'open'
      container.setAttribute('aria-hidden', String(!interactive))
      if (interactive) container.removeAttribute('inert')
      else container.setAttribute('inert', '')
    },
  })
  return {
    get phase() { return presence.phase },
    set(open, immediate) {
      if (open) container.hidden = false
      presence.set(open, immediate)
    },
    finish: () => presence.finish(),
    dispose: () => presence.dispose(),
  }
}
