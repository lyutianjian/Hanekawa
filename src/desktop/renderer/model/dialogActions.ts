/**
 * The button bar every modal dialog ends with, as data.
 *
 * The four blocking dialogs and the rewind panel used to end in a transcribed
 * terminal hint line (`[↑↓] 移动　[Y/N] 快选　[Enter] 确定`). On the desktop the
 * keys live on the buttons instead, as a badge, and the line is gone: a key with
 * no button is not printed at all.
 *
 * A `slot` is what keeps the mouse honest. A button carrying one *is* option
 * `slot` of the dialog's own list, so it answers through the same
 * `*IndexToIntent` function the number key uses; a button without one is a
 * dialog-level action (submit, cancel) and maps to the key it is labelled with.
 * Neither path can answer something the keyboard would not — see `paneSession.ts`.
 *
 * DOM-free on purpose; see `diffRows.ts`.
 */

export type DialogRole = 'primary' | 'secondary'

/** `danger` is an outline and a text colour, never a fill (design_guidance 七.4). */
export type DialogTone = 'neutral' | 'danger'

export interface DialogAction {
  readonly label: string
  /** The badge: `Y`, `Enter`, `Esc`, `1`. Absent when the action has no key. */
  readonly shortcut?: string
  readonly role: DialogRole
  readonly tone?: DialogTone
  /** Present when this button is one of the dialog's options, by index. */
  readonly slot?: number
}

/** What a click in a dialog reports: a slot, or the dialog-level action. */
export type OverlayAction =
  | { kind: 'slot'; index: number }
  | { kind: 'primary' }
  | { kind: 'secondary' }
