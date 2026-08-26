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
}

/**
 * A deliberately small CSS parser: strip comments, then take every
 * `selector { … }` block. Exact only while the sheet has no nested at-rule,
 * which `rendererStyleTokens.test.ts`'s "the stylesheet parses exactly" is what
 * pins — that test is also the non-vacuity guard for this function.
 *
 * Values are whitespace-collapsed so a declaration that wraps across lines (the
 * font stacks do) compares as the one string it means.
 */
export function parseCss(css: string): Block[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks: Block[] = []
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
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
    blocks.push({ selector, decls })
  }
  return blocks
}

let cached: Block[] | undefined

/** The real stylesheet, parsed on first use. */
export function cssBlocks(): Block[] {
  cached ??= parseCss(readFileSync(stylesheetPath, 'utf8'))
  return cached
}
