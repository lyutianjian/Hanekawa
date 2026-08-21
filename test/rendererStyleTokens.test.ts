import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The renderer's stylesheet, asserted at source level.
 *
 * Same reasoning as `test/tuiTheme.test.ts`: a view asks for a *name*, never for
 * a colour, so the two shells can be re-skinned independently. The TUI can be
 * checked by importing its frozen `theme` object; CSS has no such handle, so
 * this file parses the sheet instead.
 *
 * CSS is worth this trouble because it fails **silently**. A typo'd
 * `var(--text-primry)` is not an error anywhere — the property just inherits,
 * and the only report is that something looks slightly wrong on a screen nobody
 * is looking at. Neither typecheck pass opens this file and no bundler validates
 * it.
 */

const rendererRoot = fileURLToPath(new URL('../src/desktop/renderer/', import.meta.url))
const stylesheetPath = path.join(rendererRoot, 'styles.css')
const htmlPath = path.join(rendererRoot, 'index.html')

/**
 * Inline style properties the renderer is allowed to set from TypeScript.
 *
 * A closed set rather than a list of forbidden ones: the point is that painting
 * belongs in the stylesheet, and every exception should be a decision on the
 * record. `height` is here because the composer's autosize measures
 * `scrollHeight` and clamps it — a number no stylesheet can know.
 */
const ALLOWED_INLINE_STYLE_PROPS = ['height']

interface Declaration {
  readonly selector: string
  readonly prop: string
  readonly value: string
}

interface Block {
  readonly selector: string
  readonly decls: readonly Declaration[]
}

/**
 * A deliberately small CSS parser: strip comments, then take every
 * `selector { … }` block. Exact only while the sheet has no nested at-rule,
 * which `the stylesheet parses exactly` below is what pins.
 *
 * Values are whitespace-collapsed so a declaration that wraps across lines (the
 * font stacks do) compares as the one string it means.
 */
function parseCss(css: string): Block[] {
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

function rendererFiles(dir = rendererRoot): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) return rendererFiles(full)
    return full.endsWith('.ts') ? [full] : []
  })
}

/** Comments may legitimately name a colour; code may not. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

const css = readFileSync(stylesheetPath, 'utf8')
const html = readFileSync(htmlPath, 'utf8')
const blocks = parseCss(css)
const declarations = blocks.flatMap((block) => block.decls)
const tokens = new Map(
  declarations.filter((d) => d.selector === ':root' && d.prop.startsWith('--')).map((d) => [d.prop, d.value]),
)

const COLOUR_LITERAL = /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b|\brgba?\(|\bhsla?\(/

test('the stylesheet parses exactly, so nothing below can pass vacuously', () => {
  // The failure this guards against is a parser that silently returns nothing:
  // every loop in this file iterates what it produced, so an empty result makes
  // the whole suite green. Same device as `rendererImports.test.ts`'s
  // "the renderer has files to check".
  assert.ok(blocks.length >= 100, `expected the renderer stylesheet, parsed ${blocks.length} blocks`)
  assert.ok(declarations.length >= 300, `parsed only ${declarations.length} declarations`)
  assert.ok(tokens.size >= 15, `expected the token block, found ${tokens.size} custom properties`)

  // The parser takes `selector { … }` with no nesting. An `@media` or `@layer`
  // block would put a `{` inside a `{`, and the regex would mis-split rather
  // than fail — so forbid them until someone teaches it.
  assert.doesNotMatch(
    css.replace(/\/\*[\s\S]*?\*\//g, ''),
    /@(?:media|supports|container|layer|scope)\b[^;{]*\{/,
    'a nested at-rule needs a real parser here first',
  )

  const files = rendererFiles()
  assert.ok(files.length >= 10, `expected the renderer tree, found ${files.length} files`)
  assert.ok(files.some((file) => file.endsWith('app.ts')))
})

test('the page links the stylesheet and carries no CSS of its own', () => {
  // Extracting the sheet is only worth anything if the page cannot grow a second
  // copy. `<style>` and `style="` are the two ways it would.
  assert.match(html, /<link\s+rel="stylesheet"\s+href="\.\/styles\.css"\s*\/?>/)
  assert.doesNotMatch(html, /<style[\s>]/, 'CSS belongs in styles.css')
  assert.doesNotMatch(html, /\sstyle="/, 'no inline style attribute; add a rule instead')
})

test('every token is used and every use is declared', () => {
  const used = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1]!))

  for (const name of tokens.keys()) {
    assert.ok(used.has(name), `${name} is declared but nothing uses it`)
  }

  // The direction CSS itself will never report. A misspelled custom property
  // resolves to nothing and the declaration is simply dropped.
  for (const name of used) {
    assert.ok(tokens.has(name), `var(${name}) has no declaration in :root`)
  }
})

test('colours live in the token block, not in the rules', () => {
  for (const { selector, prop, value } of declarations) {
    if (selector === ':root') continue
    assert.doesNotMatch(
      value,
      COLOUR_LITERAL,
      `${selector} { ${prop}: ${value} } hard-codes a colour; add a token instead`,
    )
  }
})

test('no renderer view paints from TypeScript', () => {
  // Painting is the stylesheet's job. A view that reaches for `.style.color`
  // is a colour no token can re-skin and no assertion above can see.
  for (const file of rendererFiles()) {
    const shown = path.relative(rendererRoot, file)
    const code = stripComments(readFileSync(file, 'utf8'))

    assert.doesNotMatch(code, COLOUR_LITERAL, `${shown} contains a colour literal`)
    assert.doesNotMatch(
      code,
      /setAttribute\(\s*['"]style['"]/,
      `${shown} sets a style attribute; add a class and a rule`,
    )

    for (const match of code.matchAll(/\.style\.([A-Za-z]+)/g)) {
      const prop = match[1]!
      assert.ok(
        ALLOWED_INLINE_STYLE_PROPS.includes(prop),
        `${shown} sets .style.${prop} inline; only ${ALLOWED_INLINE_STYLE_PROPS.join(', ')} are allowed`,
      )
    }
  }
})

// --- the palette ------------------------------------------------------------

function parseHex(value: string): [number, number, number] {
  const match = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(value)
  assert.ok(match, `unsupported colour format: ${value}`)
  return [
    Number.parseInt(match[1]!, 16),
    Number.parseInt(match[2]!, 16),
    Number.parseInt(match[3]!, 16),
  ]
}

/** How far a colour is from grey. Zero for any `#xyxyxy`. */
function saturation(value: string): number {
  const channels = parseHex(value)
  return Math.max(...channels) - Math.min(...channels)
}

function luminance(value: string): number {
  const [red, green, blue] = parseHex(value)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function tokenValue(name: string): string {
  const value = tokens.get(name)
  assert.ok(value, `${name} is not declared`)
  return value
}

test('the palette is the one that was agreed, value for value', () => {
  // Pinned the way `test/tuiTheme.test.ts` pins the terminal palette: the point
  // of a token is that it is a decision, and a decision that can be edited
  // without anything noticing is a preference.
  assert.deepEqual(
    Object.fromEntries([...tokens].filter(([name]) => !name.startsWith('--diff-'))),
    {
      '--surface-base': '#0f0f11',
      '--surface-canvas': '#17171a',
      '--surface-card': '#1f1f23',
      '--surface-hover': '#25252b',
      '--surface-active': '#2a2a30',
      '--surface-scrim': 'rgba(0, 0, 0, 0.55)',
      '--text-primary': '#f2f2f5',
      '--text-secondary': '#9aa0aa',
      '--text-tertiary': '#6b7078',
      '--link': '#6aa8ff',
      '--accent-info': '#5b9dff',
      '--accent-tool': '#a97bff',
      '--accent-review': '#4cc38a',
      '--accent-warn': '#e0a355',
      '--accent-danger': '#f0616e',
      '--text-danger': 'var(--accent-danger)',
      '--text-warn': 'var(--accent-warn)',
      '--text-success': 'var(--accent-review)',
      '--border-subtle': '#26262b',
      '--border-strong': '#34343b',
      '--focus-ring': '#5b9dff',
      '--caret': '#f2f2f5',
      '--radius-lg': '14px',
      '--radius-md': '9px',
      '--radius-pill': '9999px',
      '--font-ui':
        '"Segoe UI Variable Text", "Segoe UI", -apple-system, system-ui, "PingFang SC", "Microsoft YaHei UI", sans-serif',
      '--font-mono':
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Cascadia Mono", monospace',
    },
  )
})

test('the surface ladder climbs and the text ladder descends', () => {
  // The half that carries meaning rather than values. `design_guidance.md` asks
  // for depth built from base → canvas → card → active, and this shell used to
  // do the opposite (a #232323 sidebar against a #1a1a1a canvas). This is the
  // assertion that reddens if someone "fixes" it back.
  const surfaces = [
    '--surface-base',
    '--surface-canvas',
    '--surface-card',
    '--surface-hover',
    '--surface-active',
  ]
  for (let index = 1; index < surfaces.length; index += 1) {
    const below = surfaces[index - 1]!
    const above = surfaces[index]!
    assert.ok(
      luminance(tokenValue(above)) > luminance(tokenValue(below)),
      `${above} must sit above ${below} in the surface ladder`,
    )
  }

  const texts = ['--text-primary', '--text-secondary', '--text-tertiary']
  for (let index = 1; index < texts.length; index += 1) {
    const brighter = texts[index - 1]!
    const dimmer = texts[index]!
    assert.ok(
      luminance(tokenValue(dimmer)) < luminance(tokenValue(brighter)),
      `${dimmer} must read dimmer than ${brighter}`,
    )
  }
})

test('surfaces and text stay neutral; accents and links do not', () => {
  const NEUTRAL_PREFIXES = ['--surface-', '--text-', '--border-', '--caret']
  const CHROMATIC = ['--accent-', '--link', '--focus-ring']

  let neutrals = 0
  let chromatics = 0
  for (const [name, value] of tokens) {
    if (!value.startsWith('#')) continue // aliases resolve to a token checked below
    if (name.startsWith('--diff-')) continue // content colours, exempt (see the sheet)

    const isNeutral = NEUTRAL_PREFIXES.some((prefix) => name.startsWith(prefix))
    const isChromatic = CHROMATIC.some((prefix) => name.startsWith(prefix))
    // Neither list matching means a new token slipped in unclassified, which is
    // how this test would quietly stop covering the palette.
    assert.notEqual(
      isNeutral,
      isChromatic,
      `${name} is in neither the neutral nor the chromatic group; classify it`,
    )

    if (isNeutral) {
      neutrals += 1
      assert.ok(
        saturation(value) <= 20,
        `${name} (${value}) is a tinted surface; the interface stays neutral`,
      )
    } else {
      chromatics += 1
      assert.ok(
        saturation(value) >= 40,
        `${name} (${value}) is too grey to read as a semantic colour`,
      )
    }
  }
  assert.ok(neutrals >= 8 && chromatics >= 5, `classified ${neutrals} neutral / ${chromatics} chromatic`)
})

test('accents are for icons and state rules, never for fills', () => {
  // `design_guidance.md`'s "95% neutral" rule, made executable. An accent may
  // colour a glyph, a hairline or a 3px tone stripe; the moment one becomes a
  // `background` the interface starts drifting back to being a coloured one.
  const PAINTABLE = [
    'color',
    'fill',
    'stroke',
    'border-color',
    'border-top-color',
    'border-right-color',
    'border-bottom-color',
    'border-left-color',
    'outline-color',
    'caret-color',
    // The three aliases, spelled out rather than allowing every custom property:
    // aliasing an accent into `--surface-x` would otherwise slip past the
    // neutrality check, which only sees literal values.
    '--text-danger',
    '--text-warn',
    '--text-success',
  ]

  let seen = 0
  for (const { selector, prop, value } of declarations) {
    if (!/var\(\s*--accent-/.test(value)) continue
    seen += 1
    assert.ok(
      PAINTABLE.includes(prop),
      `${selector} { ${prop} } paints with an accent; accents are for icons, hairlines and switches`,
    )
  }
  assert.ok(seen >= 8, `expected the accents to be in use, found ${seen} declarations`)
})

// --- type and structure -----------------------------------------------------

/**
 * Selectors that must stay monospaced. Every one of them shows text the user
 * reads character by character — a shell command, a diff, a fenced block, a
 * tool's output. The chrome around them is proportional.
 */
const MONOSPACED = [
  '.md .md-code',
  '.md .md-inline-code',
  '.diff',
  '.diff-row .gutter',
  '#overlay-panel .block',
  '#overlay-panel .plan',
  '#overlay-panel .feedback',
  '.transcript .item.tool',
  '.tool-progress',
]

function blockFor(selector: string): Block {
  const found = blocks.find((block) => block.selector === selector)
  assert.ok(found, `no rule for ${selector}; the selector moved and this list did not`)
  return found
}

function declares(block: Block, prop: string, value: string): boolean {
  return block.decls.some((decl) => decl.prop === prop && decl.value === value)
}

test('everything read character by character stays monospaced', () => {
  for (const selector of MONOSPACED) {
    assert.ok(
      declares(blockFor(selector), 'font-family', 'var(--font-mono)'),
      `${selector} must declare font-family: var(--font-mono) — inheriting it is not enough, ` +
        'because the rule that supplies it is one refactor away from moving',
    )
  }

  // The chrome. `font` shorthand rather than `font-family` because it carries
  // the size and line-height too.
  const body = blockFor('body')
  assert.ok(
    body.decls.some((decl) => decl.prop === 'font' && decl.value.includes('var(--font-ui)')),
    'body must set the chrome font from the token',
  )

  // No stack may be spelled outside the two tokens, or a third font appears and
  // the list above stops meaning anything.
  for (const { selector, prop, value } of declarations) {
    if (prop === 'font-family') {
      assert.ok(
        value === 'var(--font-mono)' || value === 'var(--font-ui)',
        `${selector} { font-family: ${value} } spells a stack instead of naming a token`,
      )
    }
    if (prop === 'font' && selector !== ':root') {
      assert.ok(
        value === 'inherit' || value.includes('var(--font-'),
        `${selector} { font: ${value} } spells a stack instead of naming a token`,
      )
    }
  }
})

test('the canvas is a clipped rounded panel', () => {
  // `overflow: hidden` is load-bearing, not tidiness: the transcript scrolls
  // inside this panel and its scrollbar would otherwise square off the corner
  // the whole layout is built around.
  const canvas = blockFor('#canvas')
  assert.ok(
    declares(canvas, 'border-radius', 'var(--radius-lg)'),
    '#canvas must carry the large radius; it is the panel the design nests everything in',
  )
  assert.ok(declares(canvas, 'overflow', 'hidden'), '#canvas must clip its scrolling contents')
})

test('ch units survive only where the font is monospaced', () => {
  // `ch` is the advance width of a `0`. Under the proportional chrome font it
  // silently narrows and stops being a stable column — which is why every other
  // `ch` in this sheet became a rem when the font changed.
  let seen = 0
  for (const block of blocks) {
    for (const decl of block.decls) {
      if (!/\b[\d.]+ch\b/.test(decl.value)) continue
      seen += 1
      assert.ok(
        declares(block, 'font-family', 'var(--font-mono)'),
        `${block.selector} { ${decl.prop}: ${decl.value} } sizes in ch without declaring the monospace font`,
      )
    }
  }
  assert.ok(seen >= 1, 'expected at least one ch measurement to still exist, or delete this test')
})
