import { extractAtMentions } from '../../../runtime/suggestions/atToken.js'

/**
 * A user message, split into the text and the files it mentions.
 *
 * `design_guidance.md` 三.3① draws referenced files as compact pills. It puts them at
 * the head of the bubble, which this does **not**: a mention here is part of a
 * sentence the user typed (「把 @a.ts 的逻辑搬到 @b.ts」), and hoisting it would edit
 * their words and leave the sentence with a hole. So the pill is drawn where the
 * mention is — the radius table's own name for it, 「行内文件代码胶囊」.
 *
 * The invariant that makes that safe is testable: concatenating every segment's
 * `text` reproduces the input exactly. Nothing is dropped, reordered or normalised.
 */

export type UserMessageSegment =
  | { readonly kind: 'text'; readonly text: string }
  /** `text` is the source substring; `label` is what the pill shows. */
  | { readonly kind: 'file'; readonly text: string; readonly label: string }

export function splitFileMentions(input: string): UserMessageSegment[] {
  const segments: UserMessageSegment[] = []
  let at = 0
  for (const span of extractAtMentions(input)) {
    if (span.start > at) segments.push({ kind: 'text', text: input.slice(at, span.start) })
    // The label drops the `@` and the quotes: the file icon says what they said, and
    // a pill reading `@"a b.ts"` is punctuation the user does not need to re-read.
    segments.push({ kind: 'file', text: span.text, label: span.mention })
    at = span.end
  }
  if (at < input.length) segments.push({ kind: 'text', text: input.slice(at) })
  return segments
}
