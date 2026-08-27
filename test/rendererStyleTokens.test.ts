import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { parseCss, rendererRoot, stylesheetPath, type Block } from './helpers/rendererCss.js'

/**
 * The renderer's stylesheet, asserted at source level.
 *
 * Same reasoning as `test/tuiTheme.test.ts`: a view asks for a *name*, never for
 * a colour, so the two shells can be re-skinned independently. The TUI can be
 * checked by importing its frozen `theme` object; CSS has no such handle, so
 * this file parses the sheet instead — through `helpers/rendererCss.ts`, shared
 * with the settings view's clipping assertion so there is one notion of "a rule".
 *
 * CSS is worth this trouble because it fails **silently**. A typo'd
 * `var(--text-primry)` is not an error anywhere — the property just inherits,
 * and the only report is that something looks slightly wrong on a screen nobody
 * is looking at. Neither typecheck pass opens this file and no bundler validates
 * it.
 */

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

/**
 * The two token blocks. Dark is the bare `:root` (the primary palette); light
 * overrides a subset under an attribute selector. `app.ts` resolves the
 * preference and writes `[data-theme]`, so there is no `@media` — the parser
 * stays flat and the nested-at-rule prohibition below still holds.
 */
const LIGHT_SELECTOR = ':root[data-theme="light"]'
const TOKEN_SELECTORS = new Set([':root', LIGHT_SELECTOR])

function tokensForSelector(selector: string): Map<string, string> {
  return new Map(
    declarations.filter((d) => d.selector === selector && d.prop.startsWith('--')).map((d) => [d.prop, d.value]),
  )
}

const tokens = tokensForSelector(':root') // the dark palette
const lightOverrides = tokensForSelector(LIGHT_SELECTOR)
/** The effective light palette: dark defaults with the light block layered on. */
const lightTokens = new Map([...tokens, ...lightOverrides])

/** Both themes, with the direction their foreground brightness runs (see the ladder test). */
const THEMES = [
  { name: 'dark', tokens, sign: 1 },
  { name: 'light', tokens: lightTokens, sign: -1 },
] as const

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

  // The light theme is a second token block, not an at-rule. If it stops parsing
  // (or someone reintroduces it as `@media`), the per-theme assertions below would
  // quietly run against an empty override map.
  assert.ok(
    blocks.some((block) => block.selector === LIGHT_SELECTOR),
    `expected a ${LIGHT_SELECTOR} block; the light palette is missing or nested`,
  )
  assert.ok(lightOverrides.size >= 18, `parsed only ${lightOverrides.size} light overrides`)
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
    if (TOKEN_SELECTORS.has(selector)) continue
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

function tokenValue(name: string, from: Map<string, string> = tokens): string {
  const value = from.get(name)
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
      '--surface-base': '#1c2125',
      '--surface-canvas': '#1a1918',
      '--surface-card': '#222120',
      '--surface-hover': '#2a2927',
      '--surface-active': '#323130',
      '--surface-wash-warm': '#25211a',
      '--surface-wash-mint': '#1d2121',
      '--surface-knob': '#ffffff',
      '--surface-scrim': 'rgba(0, 0, 0, 0.55)',
      '--text-primary': '#f4f3f1',
      '--text-secondary': '#9b9992',
      '--text-tertiary': '#6d6b66',
      '--link': '#78b0ff',
      '--accent-info': '#6ba6ff',
      '--accent-tool': '#a97bff',
      '--accent-review': '#4cc38a',
      '--accent-warn': '#e0a355',
      '--accent-danger': '#f0616e',
      '--text-danger': 'var(--accent-danger)',
      '--text-warn': 'var(--accent-warn)',
      '--text-success': 'var(--accent-review)',
      '--border-subtle': '#2b2a28',
      '--border-strong': '#3a3835',
      '--focus-ring': '#6ba6ff',
      '--caret': '#f4f3f1',
      '--shadow-float': '0 2px 10px rgba(0, 0, 0, 0.45)',
      '--radius-lg': '14px',
      '--radius-md': '9px',
      '--radius-pill': '9999px',
      '--font-ui':
        '"Segoe UI Variable Text", "Segoe UI", -apple-system, system-ui, "PingFang SC", "Microsoft YaHei UI", sans-serif',
      '--font-mono':
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Cascadia Mono", monospace',
    },
  )

  // The light palette, pinned the same way. It is the dark palette with the light
  // block layered on: scrim, the three `--text-*` aliases, radii and fonts are
  // theme-independent and carry through from `:root`.
  assert.deepEqual(
    Object.fromEntries([...lightTokens].filter(([name]) => !name.startsWith('--diff-'))),
    {
      '--surface-base': '#edf4f9',
      '--surface-canvas': '#ffffff',
      '--surface-card': '#faf9f7',
      '--surface-hover': '#ebeced',
      '--surface-active': '#e1e2e4',
      '--surface-wash-warm': '#f9f2e6',
      '--surface-wash-mint': '#e9f6f8',
      // Carried through from `:root`, deliberately: the knob sits on the blue
      // track in both themes, so it is white in both.
      '--surface-knob': '#ffffff',
      '--surface-scrim': 'rgba(0, 0, 0, 0.55)',
      '--text-primary': '#171614',
      '--text-secondary': '#73716b',
      '--text-tertiary': '#a5a39d',
      '--link': '#3b7ae4',
      '--accent-info': '#3b7ae4',
      '--accent-tool': '#9333ea',
      '--accent-review': '#16a34a',
      '--accent-warn': '#d97706',
      '--accent-danger': '#dc2626',
      '--text-danger': 'var(--accent-danger)',
      '--text-warn': 'var(--accent-warn)',
      '--text-success': 'var(--accent-review)',
      '--border-subtle': '#e8e7e4',
      '--border-strong': '#d6d4d0',
      '--focus-ring': '#3b7ae4',
      '--caret': '#171614',
      '--shadow-float': '0 4px 14px rgba(0, 0, 0, 0.14)',
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

test('the light block overrides only colours, and adds no token the dark palette lacks', () => {
  // Every override must shadow a real dark token — a light-only token would be a
  // colour the dark theme silently drops to nothing. And the theme-independent
  // tokens (shape, type, the aliases that follow their accent) must NOT be
  // redeclared, or the two themes could drift on something that is not a colour.
  for (const name of lightOverrides.keys()) {
    assert.ok(tokens.has(name), `${LIGHT_SELECTOR} declares ${name}, which has no dark default`)
  }
  const THEME_INDEPENDENT = [
    '--surface-scrim',
    '--text-danger',
    '--text-warn',
    '--text-success',
    '--radius-lg',
    '--radius-md',
    '--radius-pill',
    '--font-ui',
    '--font-mono',
  ]
  for (const name of THEME_INDEPENDENT) {
    assert.ok(
      !lightOverrides.has(name),
      `${name} is theme-independent; the light block must not redeclare it`,
    )
  }
})

test('the surface ladder climbs and the text ladder descends, in both themes', () => {
  // The half that carries meaning rather than values. `design_guidance.md` asks
  // for depth built from canvas → card → active. The `sign` captures that light
  // inverts it: dark reads brightest-forward, light darkest-forward.
  //
  // `--surface-base` is asserted separately because it is not the bottom of that
  // ladder — it is a rung *on* it, between the canvas and hover. The canvas is
  // the extreme of the theme (deepest in dark, pure white in light) and the
  // window frame steps one rung away from it, so in dark the frame is lighter
  // than the canvas and in light it is darker. Naming it "darkest first" was
  // what made that read as a contradiction; it is one rule under `sign`.
  for (const { name, tokens: palette, sign } of THEMES) {
    const base = luminance(tokenValue('--surface-base', palette))
    assert.ok(
      sign * (base - luminance(tokenValue('--surface-canvas', palette))) > 0,
      `${name}: the window frame must step off the canvas, away from it`,
    )
    assert.ok(
      sign * (luminance(tokenValue('--surface-hover', palette)) - base) > 0,
      `${name}: the frame must stay below hover, or a hovered row vanishes into it`,
    )

    const surfaces = ['--surface-canvas', '--surface-card', '--surface-hover', '--surface-active']
    for (let index = 1; index < surfaces.length; index += 1) {
      const below = surfaces[index - 1]!
      const above = surfaces[index]!
      assert.ok(
        sign * (luminance(tokenValue(above, palette)) - luminance(tokenValue(below, palette))) > 0,
        `${name}: ${above} must step past ${below} in the surface ladder`,
      )
    }

    const texts = ['--text-primary', '--text-secondary', '--text-tertiary']
    for (let index = 1; index < texts.length; index += 1) {
      const stronger = texts[index - 1]!
      const weaker = texts[index]!
      assert.ok(
        sign * (luminance(tokenValue(weaker, palette)) - luminance(tokenValue(stronger, palette))) < 0,
        `${name}: ${weaker} must read fainter than ${stronger}`,
      )
    }
  }
})

test('surfaces and text stay neutral; accents and links do not, in both themes', () => {
  const NEUTRAL_PREFIXES = ['--surface-', '--text-', '--border-', '--caret']
  const CHROMATIC = ['--accent-', '--link', '--focus-ring']

  for (const { name: themeName, tokens: palette } of THEMES) {
    let neutrals = 0
    let chromatics = 0
    for (const [name, value] of palette) {
      if (!value.startsWith('#')) continue // aliases resolve to a token checked below
      if (name.startsWith('--diff-')) continue // content colours, exempt (see the sheet)

      const isNeutral = NEUTRAL_PREFIXES.some((prefix) => name.startsWith(prefix))
      const isChromatic = CHROMATIC.some((prefix) => name.startsWith(prefix))
      // Neither list matching means a new token slipped in unclassified, which is
      // how this test would quietly stop covering the palette.
      assert.notEqual(
        isNeutral,
        isChromatic,
        `${themeName}: ${name} is in neither the neutral nor the chromatic group; classify it`,
      )

      if (isNeutral) {
        neutrals += 1
        assert.ok(
          saturation(value) <= 20,
          `${themeName}: ${name} (${value}) is a tinted surface; the interface stays neutral`,
        )
      } else {
        chromatics += 1
        assert.ok(
          saturation(value) >= 40,
          `${themeName}: ${name} (${value}) is too grey to read as a semantic colour`,
        )
      }
    }
    assert.ok(
      neutrals >= 8 && chromatics >= 5,
      `${themeName}: classified ${neutrals} neutral / ${chromatics} chromatic`,
    )
  }
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

  /**
   * The one fill the rule allows, named rather than inferred.
   *
   * A switch carries no label: the coloured track *is* the state, which is what
   * the neutral version could not say — it read as "disabled" at a glance
   * (design_guidance 六 and 七.4). Written as an exact selector/property pair so
   * widening it is an edit to this list rather than a side effect: `.settings-toggle`
   * at rest, and every other control, stays under the rule.
   */
  const ACCENT_FILL_EXCEPTIONS: readonly { selector: string; prop: string }[] = [
    { selector: '.settings-toggle.on', prop: 'background' },
  ]

  let seen = 0
  let exceptionsSeen = 0
  for (const { selector, prop, value } of declarations) {
    if (!/var\(\s*--accent-/.test(value)) continue
    seen += 1
    if (ACCENT_FILL_EXCEPTIONS.some((one) => one.selector === selector && one.prop === prop)) {
      exceptionsSeen += 1
      continue
    }
    assert.ok(
      PAINTABLE.includes(prop),
      `${selector} { ${prop} } paints with an accent; accents are for icons, hairlines and switches`,
    )
  }
  // Non-vacuity: an exception that no longer matches anything is a hole left
  // open for a rule that has since moved.
  assert.equal(
    exceptionsSeen,
    ACCENT_FILL_EXCEPTIONS.length,
    'an accent-fill exception matches no declaration; drop it or fix the selector',
  )
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
  '.file-chip-label',
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

  // The hairline that makes it float (todo V1), and the reason it is an outline.
  // `#overlay`/`#rewind` are `absolute; inset: 0` since S6 — positioned against
  // the padding box — and smoke S2 asserts the scrim matches `#canvas` edge for
  // edge. A border would inset the scrim by 1px on all four sides, and D7 already
  // decided that judgement stays exact rather than being loosened. An outline
  // takes no layout at all, so this assertion *is* that decision.
  const outline = canvas.decls.find((decl) => decl.prop === 'outline')
  assert.ok(outline, '#canvas must carry a hairline; in dark it is otherwise flush with the base')
  assert.match(outline.value, /var\(--border-subtle\)/)
  assert.ok(
    declares(canvas, 'outline-offset', '-1px'),
    '#canvas draws its hairline inside itself, or the panel grows past its margin',
  )
  assert.ok(
    !canvas.decls.some((decl) => decl.prop === 'border' || decl.prop.startsWith('border-width')),
    '#canvas must not use a border: it would move the modal scrim off the canvas edge',
  )
})

test('the settings screen scrolls full width and reads in a column', () => {
  // todo V7: two nodes, two jobs. Merging them back into one gives the reading
  // measure a scrollbar of its own, floating mid-canvas.
  const column = blockFor('.settings-column')
  assert.ok(
    column.decls.some((decl) => decl.prop === 'max-width'),
    '.settings-column is the reading measure and must bound its width',
  )
  assert.ok(declares(column, 'margin', '0 auto'), '.settings-column must be centred in its scroller')
  assert.ok(
    !column.decls.some((decl) => decl.prop.startsWith('overflow')),
    '.settings-column is on an open dropdown’s ancestor chain and must not clip',
  )
  assert.ok(
    declares(blockFor('.settings-body'), 'overflow-y', 'auto'),
    '.settings-body stays the scroller, so its scrollbar keeps to the canvas edge',
  )
})

test('a short conversation sits against the composer, and a long one still scrolls from the top', () => {
  // todo V2: a session with a short history used to hang one bubble under the
  // canvas header with 900px of nothing below it. Only a brand-new draft had an
  // empty state; a two-message session had neither that nor a conversation to
  // fill the canvas.
  //
  // The fix is one auto margin, and both halves of this test are the reasons it
  // is an auto margin rather than the obvious alternatives.
  const scroller = blockFor('.transcript')
  assert.ok(declares(scroller, 'display', 'flex'), '.transcript must be a flex column for the column below to claim its free space')
  assert.ok(declares(scroller, 'flex-direction', 'column'), '.transcript stacks one reading column; the axis has to say so')
  assert.ok(declares(scroller, 'overflow-y', 'auto'), '.transcript stays the scroller')
  // The alternative that looks equivalent and is not: in a scroll container,
  // `justify-content: flex-end` puts the *top* of overflowing content out of
  // reach, so a long session could never be scrolled back to its first message.
  assert.ok(
    !scroller.decls.some((decl) => decl.prop.startsWith('justify-content')),
    '.transcript must not bottom-align with justify-content: it makes overflowing content unreachable at the top',
  )

  const column = blockFor('.transcript-column')
  const margin = column.decls.find((decl) => decl.prop === 'margin')
  assert.ok(margin, '.transcript-column must set a margin: the top one is what pushes a short conversation down')
  assert.match(
    margin.value,
    /^auto\b/,
    '.transcript-column needs margin-top: auto — it eats the free space when short and resolves to 0 when long',
  )
  assert.ok(
    column.decls.some((decl) => decl.prop === 'max-width'),
    '.transcript-column is the reading measure and must bound its width',
  )
  // The horizontal `auto` margins that centre it also cancel the flex item's
  // default cross-axis stretch, so the width has to be stated: otherwise a short
  // conversation shrink-to-fits into a narrow strip against the right edge.
  assert.ok(
    declares(column, 'width', '100%'),
    '.transcript-column needs width: 100% — auto side margins turn off the flex stretch that used to size it',
  )
  // Without this the column is squeezed to the scroller's height and its content
  // spills out of a box nothing scrolls — the long-session half of the bargain.
  assert.ok(
    declares(column, 'flex-shrink', '0'),
    '.transcript-column must not shrink: as a flex item it would otherwise be capped at the scroller height',
  )

  // The empty state is a different layout and must stay one: it takes the
  // scroller out of the stretch, so there is no free space to push anything into
  // and the Hero keeps the canvas.
  assert.ok(
    declares(blockFor('.pane.empty .transcript'), 'flex', '0 0 auto'),
    '.pane.empty keeps the welcome screen centred; it does not take part in the bottom alignment',
  )
})

test('the session the window is showing is not the same thing as the keyboard cursor', () => {
  // Two axes that used to share one paint: `--surface-active` was given to
  // `.selected` (the cursor), so the row actually on screen had nothing but a
  // text colour every *open* row already had — five bright rows and no way to
  // tell which one you were looking at (todo D5, design_guidance 三.2).
  //
  // Verified by mutation: dropping the capsule from `.active`, or putting it back
  // on `.selected`, reds this and nothing else.
  const active = blockFor('.session-row.active')
  assert.ok(
    declares(active, 'background', 'var(--surface-active)'),
    '.session-row.active must carry the capsule; it is the only row on screen',
  )
  assert.ok(
    declares(blockFor('.session-row.active .session-open'), 'color', 'var(--text-primary)'),
    '.session-row.active must lift its title to the primary text colour',
  )
  const selected = blockFor('.session-row.selected')
  assert.ok(
    !declares(selected, 'background', 'var(--surface-active)'),
    '.session-row.selected must not wear the active capsule; the two states would read alike',
  )

  // Ordering, which no specificity rule saves here: `.active`, `.selected` and
  // `.confirming` are all one class on `.session-row`, so the *last* one in the
  // sheet wins the fill. Confirming has to be able to override the capsule, or
  // the row asking the question is the one row that does not look like it is.
  const order = (selector: string): number => {
    const index = blocks.findIndex((block) => block.selector === selector)
    assert.notEqual(index, -1, `no rule for ${selector}`)
    return index
  }
  assert.ok(
    order('.session-row.selected') < order('.session-row.active'),
    '.session-row.active must come after .selected, or the cursor paints over the visible row',
  )
  assert.ok(
    order('.session-row.active') < order('.session-row.confirming'),
    '.session-row.confirming must come after .active, or the capsule hides the question',
  )
})

test('a collapsed sidebar is gone, and the canvas grows the margin it borrowed', () => {
  // The 44px rail existed so `.sidebar-collapse` stayed clickable; that control
  // moved to the title bar, so collapsing now means zero width (todo D8). The
  // canvas is `margin: 8px 8px 8px 0` — it uses the sidebar as its left inset, so
  // without this it would end up glued to the window frame.
  // Verified by mutation: restoring `44px` reds the first assertion, deleting the
  // sibling rule reds the second.
  assert.ok(
    declares(blockFor('#sidebar.collapsed'), 'flex-basis', '0'),
    'a collapsed sidebar must take no width; the rail it used to keep is now in the title bar',
  )
  assert.ok(
    declares(blockFor('#sidebar.collapsed + #canvas'), 'margin-left', '8px'),
    '#canvas must replace the inset the sidebar was providing',
  )
})

test('the composer raises its three panels, and they no longer span the canvas', () => {
  // todo V3: `#surface`, `#suggestions` and `#queue` were full-bleed blocks in
  // the canvas's flex column — `margin: 0 8px 8px`, square-ish corners, no edge —
  // opened by a chip in the composer's bottom right and drawn a screen away from
  // it, pushing the transcript around on the way. S9 makes them one stack
  // anchored to the composer's upper edge, on the reading column's axis.
  //
  // Verified by mutation: `position: static` on the shell, dropping its
  // `pointer-events`, or giving `.composer-column` an `overflow` each red this
  // test and nothing else.
  const shell = blockFor('#composer-popovers')
  assert.ok(declares(shell, 'position', 'absolute'), 'the stack floats; it must not take flow space')
  assert.ok(declares(shell, 'bottom', '100%'), 'the stack sits on the composer’s upper edge')
  // The shell outlives every panel it holds: with all three hidden it is still a
  // box over the transcript, and the `gap` between two open ones is its own area.
  assert.ok(
    declares(shell, 'pointer-events', 'none'),
    '#composer-popovers must not eat clicks meant for the transcript underneath',
  )

  const column = blockFor('.composer-column')
  assert.ok(declares(column, 'position', 'relative'), '.composer-column is the containing block')
  assert.ok(
    !column.decls.some((decl) => decl.prop.startsWith('overflow')),
    '.composer-column is on the stack’s ancestor chain and must not clip it — same rule as .settings-column',
  )

  for (const selector of ['#surface', '#suggestions', '#queue']) {
    const panel = blockFor(selector)
    assert.ok(
      declares(panel, 'border-radius', 'var(--radius-lg)'),
      `${selector} is a floating panel now, not a strip ruled off the canvas`,
    )
    assert.ok(
      declares(panel, 'border', '1px solid var(--border-subtle)'),
      `${selector} needs the hairline that separates it from the transcript behind it`,
    )
    assert.ok(
      declares(panel, 'box-shadow', 'var(--shadow-float)'),
      `${selector} floats over other content and must carry var(--shadow-float)`,
    )
    assert.ok(
      declares(panel, 'pointer-events', 'auto'),
      `${selector} has to opt back in; its shell is pointer-events: none`,
    )
    // The shell owns the spacing now. A leftover margin would offset the panel
    // from the reading column the composer sits on.
    assert.ok(
      !panel.decls.some((decl) => decl.prop.startsWith('margin')),
      `${selector} must not keep a margin of its own; #composer-popovers spaces the stack`,
    )
  }

  // The three used to be listed as direct children of `#canvas.settings-open`.
  // They hang off the composer now, so hiding `#input-row` hides them — and a
  // stale rule would still match nothing, silently.
  for (const selector of blocks.map((block) => block.selector)) {
    assert.ok(
      !/#canvas\.settings-open > #(surface|suggestions|queue)\b/.test(selector),
      `${selector} matches nothing: those three are no longer children of #canvas`,
    )
  }
})

test('every floating menu is lifted off the page it covers', () => {
  // The four dropdowns are the same object at four sizes, and a menu without the
  // float shadow does not look wrong so much as *flat*: in light mode
  // `--surface-card` is a hair off the body it covers, and the border alone is
  // not enough to say the panel is above rather than in the text. `.settings-menu`
  // was the one that shipped without it.
  for (const selector of ['.titlebar-menu', '.canvas-menu', '.composer-menu', '.settings-menu']) {
    assert.ok(
      declares(blockFor(selector), 'box-shadow', 'var(--shadow-float)'),
      `${selector} floats over other content and must carry var(--shadow-float)`,
    )
  }
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

test('every button the renderer builds is styled by this sheet', () => {
  // An unstyled `<button>` does not disappear — it falls back to the user agent's
  // own control, which under Chromium is a filled light-grey box with the icon
  // out of line. That is how 4d's settings button became the single
  // highest-contrast fill in a 95%-neutral interface, the one thing `#submit` is
  // supposed to be, and neither typecheck pass nor any other test could see it.
  //
  // `controls.ts`'s `button()` takes the class list first, so the call sites are
  // the complete list of controls this sheet has to cover. A modifier (`selected`,
  // `danger`) may be unstyled on its own; what must exist is a rule for at least
  // one class of every button.
  // A resting-state rule, not merely *a* rule: `.x:hover` and `.x:disabled` say
  // nothing about how the control looks before it is touched, which is exactly
  // the state that fell back to the user agent. The lookahead rejects a class
  // that only ever appears with a pseudo-class attached, and forbidding `-` and
  // word characters as well is what stops the regex backtracking into a shorter
  // name to satisfy itself.
  const styled = new Set<string>()
  for (const block of blocks) {
    for (const match of block.selector.matchAll(/\.([A-Za-z][\w-]*)(?![\w-:])/g)) {
      if (match[1]) styled.add(match[1])
    }
  }

  let seen = 0
  for (const file of rendererFiles()) {
    if (file.endsWith(path.join('dom', 'controls.ts'))) continue
    const code = stripComments(readFileSync(file, 'utf8'))
    for (const match of code.matchAll(/\bbutton\(\s*'([^']+)'/g)) {
      const classes = (match[1] ?? '').split(/\s+/).filter(Boolean)
      seen += 1
      assert.ok(
        classes.some((name) => styled.has(name)),
        `${path.basename(file)} builds button('${match[1]}') and styles.css has no rule for any of its classes`,
      )
    }
  }
  assert.ok(seen >= 5, `expected the renderer to build buttons through button(); found ${seen}`)
})

test('the transcript controls carry a rule of their own, not only a contextual one', () => {
  // The scan above cannot see the difference. Its lookahead rejects a class that
  // only ever appears with a pseudo-class attached, but `.thinking-header .icon`
  // and `.item.thinking.live .thinking-header` both satisfy it while saying nothing
  // about how the control looks at rest — which is the user-agent fallback the whole
  // guard exists to catch. Closing that hole in general needs a notion of "state
  // qualifier" the parser does not have (`todo.md` records it), so the two controls
  // 5d adds are named here and required to own a selector outright.
  // Verified by mutation: deleting either rule reds this test and nothing else.
  for (const selector of ['.thinking-header', '.scroll-bottom']) {
    const block = blocks.find((candidate) => candidate.selector === selector)
    assert.ok(block, `no rule whose whole selector is ${selector}; a descendant rule is not a resting state`)
    assert.ok(block.decls.length >= 3, `${selector} has ${block.decls.length} declarations; that cannot be a control`)
  }
})

test('the 5e chrome controls carry a rule of their own, not only a contextual one', () => {
  // Same hole as the transcript controls above, one stage later: the header's
  // menu items and the composer's mode menu are `button()` call sites, so the
  // general scan sees them — but it would accept `.canvas-menu .canvas-menu-item`
  // or `.canvas-menu-item.danger` alone, neither of which says how the control
  // looks at rest. Named here and required to own a selector outright, with the
  // stricter lookahead 5f introduced (no trailing `.` either).
  // Verified by mutation: deleting any one of these rules reds this test.
  const restingRule = (name: string): boolean =>
    blocks.some((block) => new RegExp(`^\\.${name}(?![\\w\\-:.\\[])`).test(block.selector.trim()))

  for (const name of [
    'canvas-menu-trigger',
    'canvas-menu-item',
    'canvas-open-location',
    'canvas-title-input',
    'composer-menu-item',
  ]) {
    assert.ok(restingRule(name), `styles.css has no resting rule for .${name}`)
  }
})

test('the dialog action buttons carry a rule of their own, not only a contextual one', () => {
  // The fourth named list, and the same hole as the two above: the general scan
  // sees `button('dialog-btn primary', …)` in `overlayView.ts` and would be
  // satisfied by `.dialog-btn.primary` alone — a control whose only rule is one
  // of its variants, which at rest is still the user agent's grey box. The bar
  // and the key badge are not `button()` call sites at all, so nothing else
  // covers them.
  // Verified by mutation: deleting any one of these three rules reds this test.
  //
  // These live under `#overlay-panel` / `#rewind-panel` (the bar is shared by the
  // two modals and belongs to neither), so the shape required is "the selector
  // *ends* in exactly `.name`" — an ancestor is fine, a trailing `.primary`,
  // `.danger` or `:hover` is not.
  const restingRule = (name: string): boolean =>
    blocks.some((block) =>
      block.decls.length >= 3
      && block.selector.split(',').some((one) => new RegExp(`\\.${name}$`).test(one.trim())))

  for (const name of ['dialog-actions', 'dialog-btn', 'kbd']) {
    assert.ok(restingRule(name), `styles.css has no resting rule for .${name}`)
  }
})

test('the controls built inside controls.ts are styled too', () => {
  // The scan above skips `controls.ts`, because that file's own `button()` is the
  // helper being scanned for. Everything it builds internally is therefore
  // invisible to it — including 5f's pill dropdown, which is exactly the shape of
  // control that fell back to the user agent in 4d. Named explicitly instead.
  // A *lone* occurrence of the class, stricter than the scan above: that one's
  // lookahead forbids a trailing pseudo-class but not a trailing `.`, so
  // `.settings-pill.open` alone would satisfy it — and a control whose only rule
  // is its open state is exactly the user-agent fallback this guards against.
  // Verified by mutation: deleting `.settings-pill { … }` reds this test.
  const restingRule = (name: string): boolean =>
    blocks.some((block) => new RegExp(`\\.${name}(?![\\w\\-:.\\[])`).test(block.selector))

  const built = ['settings-toggle', 'settings-pill', 'settings-menu-item', 'settings-menu-shell']
  const source = readFileSync(path.join(rendererRoot, 'dom', 'controls.ts'), 'utf8')
  for (const name of built) {
    // Non-vacuity: the class has to still be built there, or this list is a
    // decoration that outlived the control it was guarding.
    assert.ok(source.includes(`'${name}'`), `controls.ts no longer builds .${name}`)
    assert.ok(restingRule(name), `controls.ts builds .${name} and styles.css has no resting rule for it`)
  }
})
