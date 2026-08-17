/**
 * The one global key handler's decision table.
 *
 * The load-bearing rule is the priority order, and specifically that **an open
 * dialog outranks interrupting the turn**. `ToolRunner.run` does not pass its
 * abort signal into `PermissionGate.approve`, so a turn parked on a permission
 * prompt is not released by `interrupt()` — if Escape interrupted instead of
 * answering, the prompt would stay open, the loop would stay parked, and the only
 * way out would be killing the window. `test/rendererKeymap.test.ts` pins this,
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
  readonly hasCompletions: boolean
  readonly isStreaming: boolean
  readonly inputEmpty: boolean
}

export type KeyAction =
  /** Hand the chord to the dialog's own key map. */
  | 'overlay'
  | 'close-surface'
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
  if (state.hasCompletions) {
    if (chord.key === 'Tab') return 'accept-completion'
    if (chord.key === 'ArrowUp') return 'move-completion-up'
    if (chord.key === 'ArrowDown') return 'move-completion-down'
    if (chord.key === 'Escape') return 'close-completions'
    // Enter accepts *and runs*, matching the terminal
    // (`useKeyboardShortcuts.ts:286-291` submits rather than filling in). Tab is
    // the accept-only affordance; requiring two Enters for `/model` would be a
    // gratuitous difference between the two shells.
    if (chord.key === 'Enter' && chord.shiftKey !== true) {
      return state.isStreaming ? 'accept-completion' : 'submit-completion'
    }
  }

  // 3. A dismissible panel.
  if (state.hasSurface && chord.key === 'Escape') return 'close-surface'

  if (chord.key === 'Escape') {
    // 4. Only now does Escape mean "stop the turn".
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
