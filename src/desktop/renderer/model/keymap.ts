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
  | 'newline'
  | 'none'

export function resolveKey(chord: KeyChord, state: ShellState): KeyAction {
  // 1. A blocking request first, always. See the note above.
  if (state.hasOverlay) return 'overlay'

  // 2. The completion dropdown, which owns Tab/arrows/Enter while it is open.
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
      return state.isStreaming || state.completions === 'file'
        ? 'accept-completion'
        : 'submit-completion'
    }
  }

  // 3. A dismissible panel.
  if (state.hasSurface && chord.key === 'Escape') return 'close-surface'

  // 4. Picking a row out of that panel — but only while the composer is empty.
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
    // 5. Only now does Escape mean "stop the turn".
    if (state.isStreaming) return 'interrupt'
    return 'none'
  }

  if (chord.key === 'Enter') {
    if (chord.shiftKey === true) return 'newline'
    // A turn in flight blocks submission rather than queueing behind it:
    // `SessionController.submit` has no in-flight guard and would overwrite the
    // live `AbortController`, leaving the first turn impossible to interrupt.
    if (state.isStreaming || state.inputEmpty) return 'none'
    return 'submit'
  }

  return 'none'
}
