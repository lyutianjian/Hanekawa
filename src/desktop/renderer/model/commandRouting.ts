import {
  applyCommandSuggestion,
  generateCommandSuggestions,
  hasCommandArgs,
  isCommandInput,
  type CommandSuggestion,
} from '../../../runtime/suggestions/commandSuggestions.js'
import type { CommandView } from '../../../commands/types.js'
import type { CommandEffect, CommandSurface, WireCommandInfo } from '../../../runtime/protocol/wire.js'

/**
 * Where a line of composer text goes, and what a slash command's effects mean.
 *
 * The shipped renderer sent everything to `client.submit`, so typing `/model`
 * put the literal string in front of the model — a typo cost a request. Routing
 * is the fix; the completion dropdown below is what makes the commands
 * discoverable at all, since `/help` arrives as prose and cannot drive a listbox.
 *
 * Ranking is `runtime/suggestions/commandSuggestions.ts`, the same module the TUI
 * uses, driven over `WireCommandInfo` — which is why that module takes a widened
 * source type rather than `CommandDefinition`.
 *
 * DOM-free on purpose; see `diffRows.ts`.
 */

export type InputClass =
  | { kind: 'empty' }
  | { kind: 'command'; line: string }
  | { kind: 'prompt'; text: string }

export function classifyInput(raw: string): InputClass {
  const text = raw.trim()
  if (text.length === 0) return { kind: 'empty' }
  // The host decides what a slash command means, including that an unknown one
  // is still "handled" with an explanation. All the renderer decides is that a
  // leading slash is never prose.
  if (isCommandInput(text)) return { kind: 'command', line: text }
  return { kind: 'prompt', text }
}

export interface CompletionState {
  readonly suggestions: readonly CommandSuggestion<WireCommandInfo>[]
  readonly selectedIndex: number
}

export const NO_COMPLETIONS: CompletionState = { suggestions: [], selectedIndex: 0 }

/**
 * Completions for the current composer text.
 *
 * Suppressed once arguments have been typed (`hasCommandArgs`), matching the
 * terminal: `/model sonnet` is a command being written, not a name being looked
 * up.
 */
export function completionsFor(raw: string, commands: readonly WireCommandInfo[]): CompletionState {
  const text = raw.trimStart()
  if (!isCommandInput(text) || hasCommandArgs(text)) return NO_COMPLETIONS
  const suggestions = generateCommandSuggestions(text, [...commands])
  return suggestions.length === 0 ? NO_COMPLETIONS : { suggestions, selectedIndex: 0 }
}

export function moveCompletion(state: CompletionState, direction: 'up' | 'down'): CompletionState {
  const total = state.suggestions.length
  if (total === 0) return state
  const step = direction === 'up' ? -1 : 1
  // Wraps, because a dropdown of five is a ring rather than a list with ends.
  return { ...state, selectedIndex: ((state.selectedIndex + step) % total + total) % total }
}

/** The composer text after accepting a completion, plus where the caret goes. */
export function acceptCompletion(state: CompletionState): { text: string; cursorPos: number } | undefined {
  const suggestion = state.suggestions[state.selectedIndex]
  if (!suggestion) return undefined
  return applyCommandSuggestion(suggestion)
}

// --- effects ----------------------------------------------------------------

export type CommandIntent =
  | { kind: 'write-line'; text: string }
  | { kind: 'show-view'; view: CommandView; rows: readonly CommandViewRow[] }
  | { kind: 'open-surface'; surface: CommandSurface }

/**
 * A `CommandEffect` to something the view can do.
 *
 * Exhaustive with an `assertNever` tail: a fourth effect kind must be a compile
 * error here, because the shipped renderer handled one of the three and dropped
 * the other two in silence.
 */
export function commandEffectToIntent(effect: CommandEffect): CommandIntent {
  switch (effect.kind) {
    case 'write-line':
      return { kind: 'write-line', text: effect.text }
    case 'open-command-view':
      return { kind: 'show-view', view: effect.view, rows: commandViewRows(effect.view) }
    case 'open-surface':
      return { kind: 'open-surface', surface: effect.surface }
  }

  return assertNever(effect)
}

export interface CommandViewRow {
  readonly label: string
  readonly value: string
  readonly tone: 'normal' | 'success' | 'warning' | 'error'
  /** A section heading rather than a row of data. */
  readonly heading?: boolean
}

/** Both `CommandView` shapes flattened to one row list a table can paint. */
export function commandViewRows(view: CommandView): CommandViewRow[] {
  if (view.kind === 'list') {
    return view.items.map((item) => ({
      label: item.label,
      value: item.description ?? '',
      tone: 'normal' as const,
    }))
  }

  return view.sections.flatMap((section) => [
    ...(section.title ? [{ label: section.title, value: '', tone: 'normal' as const, heading: true }] : []),
    ...section.rows.map((row) => ({
      label: row.label,
      value: row.value,
      tone: row.tone ?? ('normal' as const),
    })),
  ])
}

function assertNever(value: never): never {
  throw new Error(`Unhandled command effect: ${JSON.stringify(value)}`)
}
