/**
 * The one global key handler's decision table.
 *
 * The load-bearing rule is the priority order, and specifically that **an open
 * dialog outranks interrupting the turn**. `ToolRunner.run` does not pass its
 * abort signal into `PermissionGate.approve`, so a turn parked on a permission
 * prompt is not released by `interrupt()` — if Escape interrupted instead of
 * answering, the prompt would stay open, the loop would stay parked, and the only
 * way out would be killing the window. `test/rendererShellModel.test.ts` pins this,
 * and swapping the two branches is a mutation that test catches.
 *
 * DOM-free on purpose: this module is imported by a test, which compiles it in
 * the base tsconfig program where there is no DOM lib — hence the structural key
 * shape rather than `KeyboardEvent`.
 */

export interface KeyChord {
  readonly key: string
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
}

export interface ShellState {
  /** A blocking UI request is being drawn. It owns the keyboard outright. */
  readonly hasOverlay: boolean
  /**
   * The `/rewind` panel is open. Modal — it owns the keyboard the way the
   * terminal's restore mode blocks input — but it ranks *below* `hasOverlay`,
   * because nothing in the agent loop is waiting on it.
   */
  readonly hasRewind: boolean
  /** A picker or command view is open. Dismissible, and blocks nothing. */
  readonly hasSurface: boolean
  /**
   * Which source is filling the dropdown, if any.
   *
   * A bare boolean used to be enough. It stopped being enough when file mentions
   * arrived: Enter on a command suggestion accepts *and runs*, but Enter on a
   * file suggestion must only accept — `@src/foo.ts` is a fragment of a sentence
   * still being written, and submitting there sends half a prompt.
   */
  readonly completions: 'none' | 'command' | 'file'
  readonly isStreaming: boolean
  readonly inputEmpty: boolean
}

export type KeyAction =
  /** Hand the chord to the dialog's own key map. */
  | 'overlay'
  /** Hand the chord to the rewind panel's own key map. */
  | 'rewind'
  | 'close-surface'
  | 'move-surface-up'
  | 'move-surface-down'
  | 'activate-surface'
  | 'accept-completion'
  | 'submit-completion'
  | 'move-completion-up'
  | 'move-completion-down'
  | 'close-completions'
  | 'interrupt'
  | 'submit'
  /** A turn is in flight: hand the text to the host's message queue instead. */
  | 'enqueue'
  | 'newline'
  | 'none'

/**
 * Whether accepting a completion should also send it.
 *
 * Shared by Enter and by a click on the row, so the mouse cannot end up
 * submitting where the keyboard only fills in. Both exceptions are the same:
 * a file mention is a fragment of a sentence, and mid-turn there is nothing to
 * submit into.
 */
export function completionAcceptMode(state: ShellState): 'accept' | 'submit' {
  return state.isStreaming || state.completions === 'file' ? 'accept' : 'submit'
}

export function resolveKey(chord: KeyChord, state: ShellState): KeyAction {
  // 1. A blocking request first, always. See the note above.
  if (state.hasOverlay) return 'overlay'

  // 2. The rewind panel, which is modal but not blocking. It sits here rather
  //    than first because a permission prompt is holding the agent loop and this
  //    is only holding the user — and it sits above everything below because
  //    every one of its options is destructive, so a keystroke must not fall
  //    through to the composer while a confirm screen is up.
  if (state.hasRewind) return 'rewind'

  // 3. The completion dropdown, which owns Tab/arrows/Enter while it is open.
  if (state.completions !== 'none') {
    if (chord.key === 'Tab') return 'accept-completion'
    if (chord.key === 'ArrowUp') return 'move-completion-up'
    if (chord.key === 'ArrowDown') return 'move-completion-down'
    if (chord.key === 'Escape') return 'close-completions'
    // Enter accepts *and runs*, matching the terminal
    // (`useKeyboardShortcuts.ts:286-291` submits rather than filling in). Tab is
    // the accept-only affordance; requiring two Enters for `/model` would be a
    // gratuitous difference between the two shells.
    //
    // A file mention is the exception, and mid-turn there is nothing to submit
    // into, so both degrade to accepting.
    if (chord.key === 'Enter' && chord.shiftKey !== true) {
      return completionAcceptMode(state) === 'accept' ? 'accept-completion' : 'submit-completion'
    }
  }

  // 4. A dismissible panel.
  if (state.hasSurface && chord.key === 'Escape') return 'close-surface'

  // 5. Picking a row out of that panel — but only while the composer is empty.
  //
  // The panel does not block, so a user may open `/model`, start typing, and hit
  // Enter meaning "send my message". Taking Enter unconditionally would silently
  // switch models instead. Note this can never contend with the dropdown above:
  // completions require a typed `/` or `@`, so the two are mutually exclusive by
  // construction.
  if (state.hasSurface && state.inputEmpty) {
    if (chord.key === 'ArrowUp') return 'move-surface-up'
    if (chord.key === 'ArrowDown') return 'move-surface-down'
    if (chord.key === 'Enter' && chord.shiftKey !== true) return 'activate-surface'
  }

  if (chord.key === 'Escape') {
    // 6. Only now does Escape mean "stop the turn".
    if (state.isStreaming) return 'interrupt'
    return 'none'
  }

  if (chord.key === 'Enter') {
    if (chord.shiftKey === true) return 'newline'
    if (state.inputEmpty) return 'none'
    // A turn in flight queues the message rather than sending it, matching the
    // terminal (`App.tsx`'s `handleSubmit` enqueues whenever a turn is running).
    // It used to be dropped instead, because `SessionController.submit` had no
    // in-flight guard and a second call would overwrite the live
    // `AbortController`, leaving the first turn impossible to interrupt. The
    // guard is now in the kernel, so the message has somewhere to go.
    if (state.isStreaming) return 'enqueue'
    return 'submit'
  }

  return 'none'
}
