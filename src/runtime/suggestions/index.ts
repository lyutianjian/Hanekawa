/**
 * Input completion sources. Pure functions over a cwd and a command list with
 * no view attached — a terminal, a desktop shell and a test drive them the
 * same way. Nothing here imports React, Ink or anything under `src/tui/`.
 */
export {
  applyCommandSuggestion,
  createCommandSuggestion,
  generateCommandSuggestions,
  hasCommandArgs,
  isCommandInput,
} from './commandSuggestions.js'
export type { CommandSuggestion } from './commandSuggestions.js'
export { applyFileSuggestion, extractAtCompletionToken, generateFileSuggestions } from './fileSuggestions.js'
export type { FileSuggestion, FileSuggestionMetadata } from './fileSuggestions.js'
export type { SuggestionItem, SuggestionType } from './types.js'
