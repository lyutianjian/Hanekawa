import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The renderer stylesheet, parsed once, for the tests that assert facts about it.
 *
 * Shared rather than copied: `rendererStyleTokens.test.ts` asserts the palette
 * and `rendererSettingsView.test.ts` asserts that no ancestor of an open dropdown
 * clips — two questions, one sheet, and two parsers would be free to disagree
 * about what a rule even is.
 *
 * No DOM here, on purpose: this file is reached from the base program (through
 * `rendererStyleTokens.test.ts`) as well as from `tsconfig.domtest.json`, and
 * `tsc` type-checks a file it follows an import into whether or not `exclude`
 * names it.
 */

export const rendererRoot = fileURLToPath(new URL('../../src/desktop/renderer/', import.meta.url))
export const stylesheetPath = path.join(rendererRoot, 'styles.css')

export interface Declaration {
  readonly selector: string
  readonly prop: string
  readonly value: string
}

export interface Block {
  readonly selector: string
  readonly decls: readonly Declaration[]
  /** The at-rule prelude this block is nested in, if any — `@container …`, `@media …`. */
  readonly at?: string
}

/**
 * A deliberately small CSS parser: strip comments, then take every
 * `selector { … }` block.
 *
 * One level of nesting is understood rather than flattened: an at-rule body is
 * lifted out first and its rules come back carrying the prelude on `at`, so a
 * rule that only applies inside `@container …` can never be mistaken for the
 * unconditional rule of the same name. `@keyframes` parses the same way, its
 * percentage steps arriving as `at`-tagged blocks.
 * `rendererStyleTokens.test.ts`'s "the stylesheet parses exactly" pins the list
 * of at-rules in the sheet, and is also the non-vacuity guard for this function.
 *
 * Values are whitespace-collapsed so a declaration that wraps across lines (the
 * font stacks do) compares as the one string it means.
 */
export function parseCss(css: string): Block[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks: Block[] = []
  for (let i = 0; i < withoutComments.length;) {
    const start = withoutComments.indexOf('@', i)
    const open = start === -1 ? -1 : withoutComments.indexOf('{', start)
    if (open === -1) {
      blocks.push(...parseRules(withoutComments.slice(i)))
      break
    }
    blocks.push(...parseRules(withoutComments.slice(i, start)))
    let depth = 1
    let end = open + 1
    for (; end < withoutComments.length && depth > 0; end++) {
      if (withoutComments[end] === '{') depth++
      else if (withoutComments[end] === '}') depth--
    }
    const at = withoutComments.slice(start, open + 1).replace(/\s+/g, ' ').trim()
    blocks.push(...parseRules(withoutComments.slice(open + 1, end - 1), at))
    i = end
  }
  return blocks
}

function parseRules(css: string, at?: string): Block[] {
  const blocks: Block[] = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').trim().replace(/\s+/g, ' ')
    const decls: Declaration[] = []
    for (const part of (match[2] ?? '').split(';')) {
      const text = part.trim()
      if (!text) continue
      const colon = text.indexOf(':')
      if (colon === -1) continue
      decls.push({
        selector,
        prop: text.slice(0, colon).trim(),
        value: text.slice(colon + 1).trim().replace(/\s+/g, ' '),
      })
    }
    blocks.push(at === undefined ? { selector, decls } : { selector, decls, at })
  }
  return blocks
}

let cached: Block[] | undefined

/** The real stylesheet, parsed on first use. */
export function cssBlocks(): Block[] {
  cached ??= parseCss(readFileSync(stylesheetPath, 'utf8'))
  return cached
}
