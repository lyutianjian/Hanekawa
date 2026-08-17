import type { SuggestionItem } from './types.js'

/**
 * The half of `@` file completion that a browser can run.
 *
 * `fileSuggestions.ts` needs `node:fs`, `node:path`, `fuse.js` and the gitignore
 * reader to *find* candidates, none of which a renderer bundle can carry. But
 * deciding **where the `@` token starts** and **what the text looks like after
 * accepting one** is pure string work, and both shells need exactly that: the
 * host searches, the view splices.
 *
 * So the split is by dependency, not by convenience. Everything here has no
 * imports beyond the type above, which is what lets this module sit on
 * `test/rendererImports.test.ts`'s allowlist — that test opens every allowlisted
 * file and fails on any `node:` value import other than `node:crypto`.
 * `fileSuggestions.ts` re-exports all four names, so no existing caller moved.
 */

export interface FileSuggestionMetadata {
  replacementText: string
  path: string
  kind: 'directory' | 'file'
}

export type FileSuggestion = SuggestionItem<FileSuggestionMetadata> & {
  metadata: FileSuggestionMetadata
}

/**
 * The `@…` token the caret currently sits in, or null.
 *
 * Two forms: a bare `@path/to/file` that ends at the first space, and a quoted
 * `@"path with spaces` that stays open until its closing quote. Both must start
 * at a word boundary, so an email address or a `foo@bar` never opens a picker.
 */
export function extractAtCompletionToken(text: string, cursorPos: number): {
  token: string
  startPos: number
} | null {
  const before = text.slice(0, cursorPos)
  const quotedIndex = before.lastIndexOf('@"')
  if (quotedIndex >= 0 && (quotedIndex === 0 || /\s/.test(before[quotedIndex - 1]!))) {
    const token = before.slice(quotedIndex)
    if (!token.slice(2).includes('"')) {
      return { token, startPos: quotedIndex }
    }
  }

  const atIndex = before.lastIndexOf('@')
  if (atIndex < 0 || (atIndex > 0 && !/\s/.test(before[atIndex - 1]!))) return null
  const token = before.slice(atIndex)
  if (/\s/.test(token) || token.startsWith('@"')) return null
  return { token, startPos: atIndex }
}

/**
 * The text after accepting a suggestion, plus where the caret goes.
 *
 * A directory gets no trailing space: accepting `@src/` is a step *into* it, and
 * the next keystroke should keep completing. A file gets one, because it is done.
 */
export function applyFileSuggestion(
  input: string,
  cursorPos: number,
  suggestion: FileSuggestion,
): { text: string; cursorPos: number } {
  const token = extractAtCompletionToken(input, cursorPos)
  if (!token) return { text: input, cursorPos }

  const replacement = suggestion.metadata.kind === 'directory'
    ? suggestion.metadata.replacementText
    : `${suggestion.metadata.replacementText} `
  const text = input.slice(0, token.startPos) + replacement + input.slice(cursorPos)
  return {
    text,
    cursorPos: token.startPos + replacement.length,
  }
}
