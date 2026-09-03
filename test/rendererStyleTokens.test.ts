import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { parseCss, rendererRoot, stylesheetPath, type Block } from './helpers/rendererCss.js'
import { SIDEBAR_COLLAPSE_FALLBACK_MS } from '../src/desktop/renderer/model/sidebar.js'
import { SIDEBAR_WIDTH_DEFAULT } from '../src/desktop/renderer/model/sidebarWidth.js'

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

/**
 * Identifiers a `setProperty` call may name instead of a `'--literal'`.
 *
 * The scan below cannot follow an import to see what a constant holds, so the
 * few that carry a custom-property name are listed here — one line per
 * exception, which is the point: a `setProperty(SOME_CONST, …)` that is *not*
 * on this list fails, and adding it is a decision on the record.
 */
const ALLOWED_STYLE_PROPERTY_CONSTANTS = ['SIDEBAR_WIDTH_VARIABLE']

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

  // The parser takes `selector { … }` with no nesting: a nested at-rule's
  // prelude is dropped and its inner rules come through as ordinary blocks (the
  // same way `@keyframes` already does — see `helpers/rendererCss.ts`). That is
  // exact enough for one known block and nothing else, so exactly one is allowed
  // through: the reduced-motion override at the foot of the sheet, whose
  // selector (`*, *::before, *::after`) collides with no real rule.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const atRules = [...withoutComments.matchAll(/@(?:media|supports|container|layer|scope)\b[^;{]*\{/g)]
  assert.deepEqual(
    atRules.map((match) => match[0].replace(/\s+/g, ' ').trim()),
    ['@media (prefers-reduced-motion: reduce) {'],
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

    // `setProperty` is not an inline property assignment; it has its own rule
    // below, and matching it here would report it as `.style.setProperty`.
    for (const match of code.matchAll(/\.style\.(?!setProperty\b)([A-Za-z]+)/g)) {
      const prop = match[1]!
      assert.ok(
        ALLOWED_INLINE_STYLE_PROPS.includes(prop),
        `${shown} sets .style.${prop} inline; only ${ALLOWED_INLINE_STYLE_PROPS.join(', ')} are allowed`,
      )
    }

    // `setProperty` is the other door into the style attribute, and the scan
    // above cannot see through it. Only custom properties may go this way: a
    // property the stylesheet *declares* is one it still owns — every rule that
    // reads it, and its fallback, stay in the sheet where the tests can see them.
    for (const match of code.matchAll(/setProperty\(\s*([A-Za-z_$][\w$]*|['"][^'"]*['"])/g)) {
      const argument = match[1]!
      const named = /^['"]/.test(argument) ? argument.slice(1, -1) : undefined
      assert.ok(
        named === undefined
          ? ALLOWED_STYLE_PROPERTY_CONSTANTS.includes(argument)
          : named.startsWith('--'),
        `${shown} sets ${argument} through setProperty; only custom properties may be written from TypeScript`,
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

/**
 * WCAG relative luminance — the gamma-corrected one, not the ordering helper
 * above. Contrast is a threshold business: without the sRGB transfer curve the
 * light theme's 5.6:1 pair measures as 2.5:1, and the assertion below would be
 * pinning the wrong physics while still looking rigorous.
 */
function relativeLuminance(value: string): number {
  const channels = parseHex(value).map((channel) => {
    const scaled = channel / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

/** WCAG contrast ratio — `(L1 + 0.05) / (L2 + 0.05)`, lighter rung over darker. */
function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].sort(
    (a, b) => b - a,
  )
  return (lighter + 0.05) / (darker + 0.05)
}

function tokenValue(name: string, from: Map<string, string> = tokens): string {
  const value = from.get(name)
  assert.ok(value, `${name} is not declared`)
  return value
}

test('the palette is the one that was agreed, value for value', () => {
  // Pinned the way `test/tuiTheme.test.ts` pins the terminal palette: the point
  // of a token is that it is a decision, and a decision that can be edited
  // without anything noticing is a preference. The 2026 redesign's values
  // (design_guidance.md 二.2/二.3): one warm-neutral ladder, a two-rung clay
  // brand, no wash. `--link` and `--focus-ring` are pinned as the aliases they
  // now are — links are brand-coloured *text* (the strong rung), the focus ring
  // is the brand at hairline weight — so these pins are the equality itself,
  // and the tokens they resolve to carry the hexes.
  assert.deepEqual(
    Object.fromEntries([...tokens].filter(([name]) => !name.startsWith('--diff-'))),
    {
      '--surface-base': '#262523',
      '--surface-canvas': '#1c1b19',
      '--surface-card': '#232220',
      '--surface-hover': '#2e2c29',
      '--surface-active': '#383530',
      '--surface-knob': '#ffffff',
      '--surface-scrim': 'rgba(0, 0, 0, 0.55)',
      '--text-primary': '#ede9e3',
      '--text-secondary': '#a19a90',
      '--text-tertiary': '#857e74',
      '--link': 'var(--accent-brand-strong)',
      '--accent-brand': '#d97757',
      '--accent-brand-strong': '#d97757',
      '--on-brand': '#1c1b19',
      '--accent-info': '#4385be',
      '--accent-tool': '#8b7ec8',
      '--accent-review': '#879a39',
      '--accent-warn': '#d0a215',
      '--accent-danger': '#d14d41',
      '--text-danger': 'var(--accent-danger)',
      '--text-warn': 'var(--accent-warn)',
      '--text-success': 'var(--accent-review)',
      '--border-subtle': '#322f2b',
      '--border-strong': '#45413b',
      '--focus-ring': 'var(--accent-brand)',
      '--caret': '#ede9e3',
      '--shadow-float': '0 6px 20px rgba(0, 0, 0, 0.45)',
      '--shadow-modal': '0 16px 48px rgba(0, 0, 0, 0.6)',
      '--space-1': '4px',
      '--space-2': '8px',
      '--space-3': '12px',
      '--space-4': '16px',
      '--space-5': '24px',
      '--space-6': '32px',
      '--space-7': '48px',
      '--radius-lg': '20px',
      '--radius-md': '12px',
      '--radius-sm': '8px',
      '--radius-pill': '9999px',
      '--motion-fast': '140ms',
      '--motion-base': '220ms',
      '--motion-slow': '320ms',
      '--ease-standard': 'cubic-bezier(0.32, 0.72, 0, 1)',
      '--ease-exit': 'cubic-bezier(0.4, 0, 1, 1)',
      '--reading-measure': '980px',
      '--reading-gutter': '40px',
      '--composer-overhang': '16px',
      // The rail's resting width. A layout number, not a colour: `app.ts`
      // re-declares it on the document element when the handle is dragged, and
      // this declaration is the fallback every fresh profile resolves.
      '--sidebar-width': '280px',
      // The task panel's progress, same shape of exception: a number the view
      // writes and the sheet's own rule reads.
      '--task-progress': '0',
      '--font-ui':
        '"Inter Variable", "Segoe UI Variable Text", "Segoe UI", -apple-system, system-ui, "PingFang SC", "Microsoft YaHei UI", sans-serif',
      '--font-mono':
        '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Mono", monospace',
      '--font-serif':
        '"Source Serif 4 Variable", Georgia, "Songti SC", "Noto Serif CJK SC", serif',
      '--type-display': '28px',
      '--type-title': '20px',
      '--type-body': '15px',
      '--type-ui': '14px',
      '--type-meta': '12.5px',
      '--type-micro': '11px',
      '--type-code': '13px',
    },
  )

  // The light palette, pinned the same way. It is the dark palette with the light
  // block layered on: the aliases (`--text-*`, `--link`, `--focus-ring` — they
  // follow the overridden accents), `--surface-knob`, the space/shape/type
  // scales, motion and fonts are theme-independent and carry through from
  // `:root`. The scrim and both
  // shadows no longer are: light dims with a warm cast and shadows with the
  // paper's own pigment (design_guidance.md 二.2).
  assert.deepEqual(
    Object.fromEntries([...lightTokens].filter(([name]) => !name.startsWith('--diff-'))),
    {
      '--surface-base': '#f2efe9',
      '--surface-canvas': '#fdfcf9',
      '--surface-card': '#f7f4ef',
      '--surface-hover': '#ede9e2',
      '--surface-active': '#e3ded5',
      // Carried through from `:root`, deliberately: the knob sits on the
      // accent track in both themes, so it is white in both.
      '--surface-knob': '#ffffff',
      '--surface-scrim': 'rgba(28, 25, 21, 0.32)',
      '--text-primary': '#1a1815',
      '--text-secondary': '#6b655c',
      '--text-tertiary': '#8f887d',
      '--link': 'var(--accent-brand-strong)',
      '--accent-brand': '#c96442',
      '--accent-brand-strong': '#a8492b',
      '--on-brand': '#ffffff',
      '--accent-info': '#205ea6',
      '--accent-tool': '#5e409d',
      '--accent-review': '#66800b',
      '--accent-warn': '#ad8301',
      '--accent-danger': '#af3029',
      '--text-danger': 'var(--accent-danger)',
      '--text-warn': 'var(--accent-warn)',
      '--text-success': 'var(--accent-review)',
      '--border-subtle': '#e6e1d8',
      '--border-strong': '#d5cfc4',
      '--focus-ring': 'var(--accent-brand)',
      '--caret': '#1a1815',
      '--shadow-float': '0 6px 20px rgba(28, 25, 21, 0.08), 0 1px 2px rgba(28, 25, 21, 0.06)',
      '--shadow-modal': '0 16px 48px rgba(28, 25, 21, 0.16)',
      '--space-1': '4px',
      '--space-2': '8px',
      '--space-3': '12px',
      '--space-4': '16px',
      '--space-5': '24px',
      '--space-6': '32px',
      '--space-7': '48px',
      '--radius-lg': '20px',
      '--radius-md': '12px',
      '--radius-sm': '8px',
      '--radius-pill': '9999px',
      '--motion-fast': '140ms',
      '--motion-base': '220ms',
      '--motion-slow': '320ms',
      '--ease-standard': 'cubic-bezier(0.32, 0.72, 0, 1)',
      '--ease-exit': 'cubic-bezier(0.4, 0, 1, 1)',
      '--reading-measure': '980px',
      '--reading-gutter': '40px',
      '--composer-overhang': '16px',
      // The rail's resting width. A layout number, not a colour: `app.ts`
      // re-declares it on the document element when the handle is dragged, and
      // this declaration is the fallback every fresh profile resolves.
      '--sidebar-width': '280px',
      // The task panel's progress, same shape of exception: a number the view
      // writes and the sheet's own rule reads.
      '--task-progress': '0',
      '--font-ui':
        '"Inter Variable", "Segoe UI Variable Text", "Segoe UI", -apple-system, system-ui, "PingFang SC", "Microsoft YaHei UI", sans-serif',
      '--font-mono':
        '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Cascadia Mono", monospace',
      '--font-serif':
        '"Source Serif 4 Variable", Georgia, "Songti SC", "Noto Serif CJK SC", serif',
      '--type-display': '28px',
      '--type-title': '20px',
      '--type-body': '15px',
      '--type-ui': '14px',
      '--type-meta': '12.5px',
      '--type-micro': '11px',
      '--type-code': '13px',
    },
  )
})

test('the light block overrides only colours, and adds no token the dark palette lacks', () => {
  // Every override must shadow a real dark token — a light-only token would be a
  // colour the dark theme silently drops to nothing. And the theme-independent
  // tokens (the knob, space, shape, type, motion, and the aliases that follow
  // their accent)
  // must NOT be redeclared, or the two themes could drift on something that is
  // not a colour. The scrim and both shadows are theme-*dependent* under the
  // redesign, so they are absent from this list on purpose.
  for (const name of lightOverrides.keys()) {
    assert.ok(tokens.has(name), `${LIGHT_SELECTOR} declares ${name}, which has no dark default`)
  }
  const THEME_INDEPENDENT = [
    '--surface-knob',
    '--text-danger',
    '--text-warn',
    '--text-success',
    '--link',
    '--focus-ring',
    '--space-1',
    '--space-2',
    '--space-3',
    '--space-4',
    '--space-5',
    '--space-6',
    '--space-7',
    '--radius-lg',
    '--radius-md',
    '--radius-sm',
    '--radius-pill',
    '--motion-fast',
    '--motion-base',
    '--motion-slow',
    '--ease-standard',
    '--ease-exit',
    '--font-ui',
    '--font-mono',
    '--font-serif',
    '--type-display',
    '--type-title',
    '--type-body',
    '--type-ui',
    '--type-meta',
    '--type-micro',
    '--type-code',
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

test('the brand rungs clear the contrast they are pinned to, in both themes', () => {
  // design_guidance 二.2's promise, made executable. The brand is two tokens
  // precisely because the clay itself is ~3.9:1 on the paper — enough for a
  // glyph, a hairline or an indicator bar, never for text. The *strong* rung is
  // the one cleared for text (links are it: `--link` aliases it) and for fills,
  // and `--on-brand` is the text cleared to sit on that fill (`#submit`). These
  // two margins are the only thing standing between those decisions and an edit
  // that quietly repaints body text in `--accent-brand`: AA asks 4.5:1 for text,
  // and the pinned values hold ~5.6 in light and ~5.5 in dark — real margin,
  // not a rounding accident.
  for (const { name, tokens: palette } of THEMES) {
    const strong = tokenValue('--accent-brand-strong', palette)
    const onPaper = contrast(strong, tokenValue('--surface-canvas', palette))
    assert.ok(
      onPaper >= 4.5,
      `${name}: --accent-brand-strong on --surface-canvas reads ${onPaper.toFixed(2)}:1; brand text must clear the 4.5:1 AA threshold`,
    )
    const onFill = contrast(tokenValue('--on-brand', palette), strong)
    assert.ok(
      onFill >= 4.5,
      `${name}: --on-brand on --accent-brand-strong reads ${onFill.toFixed(2)}:1; a brand fill owes its own label 4.5:1`,
    )
  }
})

test('surfaces and text stay neutral; accents and links do not, in both themes', () => {
  // `--on-brand` is named in full rather than as a prefix: it is the one token
  // outside the surface/text/border families that is still a *surface* — the
  // colour that sits on a brand fill, white on clay in light and the canvas's
  // near-black in dark. It must not fall into the chromatic group just because
  // it is declared beside the brand accents.
  const NEUTRAL_PREFIXES = ['--surface-', '--text-', '--border-', '--caret', '--on-brand']
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
    // The five aliases, spelled out rather than allowing every custom property:
    // aliasing an accent into `--surface-x` would otherwise slip past the
    // neutrality check, which only sees literal values. `--link` and
    // `--focus-ring` joined the aliases with the redesign — both point at the
    // brand, and both are inherently paint roles (a text colour and a ring
    // colour), not surfaces.
    '--text-danger',
    '--text-warn',
    '--text-success',
    '--link',
    '--focus-ring',
  ]

  /**
   * The fills the rule allows, named rather than inferred.
   *
   * A switch carries no label: the coloured track *is* the state, which is what
   * the neutral version could not say — it read as "disabled" at a glance
   * (design_guidance 六 and 七.4). `#submit` is the redesign's one brand solid,
   * the "this app belongs to its brand" signal (六.4) — the strong rung, under
   * `--on-brand`. The session bar is a 3px indicator, not a surface — it is the
   * weak rung's proper shape, and it is listed because the parser sees a
   * `background` either way. All three are exact selector/property pairs so
   * widening the list is an edit here rather than a side effect: every other
   * control stays under the rule.
   */
  const ACCENT_FILL_EXCEPTIONS: readonly { selector: string; prop: string }[] = [
    { selector: '.settings-toggle.on', prop: 'background' },
    { selector: '#submit', prop: 'background' },
    { selector: '.session-row::before', prop: 'background' },
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

test('the weak brand rung never carries text', () => {
  // The other half of the two-rung rule the contrast test pins. `--accent-brand`
  // holds ~3.9:1 on the paper in light — a glyph, a hairline, an indicator bar,
  // not a paragraph. Brand-coloured *text* is the strong rung's job (`--link`,
  // `#submit`), and this is the assertion that keeps the rungs from converging
  // as rules land in later stages. `--focus-ring` is checked alongside it
  // because it is pinned as the weak rung's alias: text painted in it would be
  // brand text by another name, invisible to a check on the token itself.
  const TEXT_PROPS = ['color', 'caret-color']
  const WEAK_RUNG = /var\(\s*(?:--accent-brand|--focus-ring)\s*\)/
  let nonText = 0
  for (const { selector, prop, value } of declarations) {
    if (TOKEN_SELECTORS.has(selector)) continue // the token block's own alias
    if (!WEAK_RUNG.test(value)) continue
    assert.ok(
      !TEXT_PROPS.includes(prop),
      `${selector} { ${prop} } carries the weak brand rung; brand text belongs to --accent-brand-strong`,
    )
    nonText += 1
  }
  // Non-vacuity: the focus ring alone supplies several of these today. Zero
  // means the weak rung fell out of use entirely and this guard went quiet.
  assert.ok(nonText >= 3, `expected the weak brand rung in use, found ${nonText} declarations`)
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

  // No stack may be spelled outside the three tokens, or a fourth font appears
  // and the list above stops meaning anything. `--font-serif` is display-only;
  // which selectors may name it is the serif whitelist's question, not this
  // test's.
  for (const { selector, prop, value } of declarations) {
    if (prop === 'font-family') {
      assert.ok(
        value === 'var(--font-mono)' || value === 'var(--font-ui)' || value === 'var(--font-serif)',
        `${selector} { font-family: ${value} } spells a stack instead of naming a token`,
      )
    }
    if (prop === 'font' && selector !== ':root') {
      assert.ok(
        value === 'inherit' || value.includes('var(--font-'),
        `${selector} { font: ${value} } spells a stack instead of naming a token`,
      )
    }
    // And not through a custom property either: the two checks above read
    // `font-family`/`font`, so a rule declaring `--font-mono: <its own stack>`
    // slips past both and becomes a fourth font the tokens know nothing about.
    // `.settings-input.mono` carried exactly that until the redesign collapsed
    // the sheet to one spelling per stack.
    if (prop.startsWith('--font-')) {
      assert.ok(
        TOKEN_SELECTORS.has(selector),
        `${selector} declares ${prop} outside the token blocks; a font stack belongs to :root`,
      )
    }
  }
})

test('the serif is display-only, and only in the three whitelisted spots', () => {
  // design_guidance 三.4: the serif may carry a short, pure heading and nothing
  // else. Body text in it drops mixed CJK into a Songti — the fallback stack's
  // own next entry — and the run breaks visibly mid-sentence. There is no way to
  // see that in a DOM test, so the discipline lives here as a whitelist: three
  // spots, spelled out, and every other selector naming `--font-serif` fails.
  const SERIF_WHITELIST = [
    '.welcome-title', // the welcome Hero
    '.settings-card-title', // the settings sections
    '#overlay-panel .title', // the two dialog titles, which are one object
    '#rewind-panel .title',
  ]

  const seen = new Set<string>()
  for (const { selector, prop, value } of declarations) {
    if (TOKEN_SELECTORS.has(selector)) continue // the token's own declaration
    if (!/var\(\s*--font-serif\s*\)/.test(value)) continue
    assert.ok(
      SERIF_WHITELIST.includes(selector),
      `${selector} { ${prop} } takes the serif; it is whitelisted to headings only`,
    )
    seen.add(selector)
  }

  // Non-vacuity, per entry: a whitelisted selector that no longer names the
  // serif is a licence left lying around for whatever moves into that name.
  for (const selector of SERIF_WHITELIST) {
    assert.ok(seen.has(selector), `${selector} no longer uses the serif; drop it from the whitelist`)
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
  // the padding box — so a scrim must match `#canvas` edge for edge. A border
  // would inset it by 1px on all four sides, and D7 already decided that
  // judgement stays exact rather than being loosened. An outline takes no layout
  // at all, so this assertion *is* that decision. (Since the permission request
  // moved into the composer no smoke step raises a scrim at all, which is why the
  // claim is pinned here rather than there.)
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

test('the session on screen is painted, and the four row states stack in order', () => {
  // The row the user is *looking at* carries `--surface-active`, the same
  // surface `.settings-nav-item.selected` uses: one way of saying "you are on
  // this one" across the app. Everything else about a row stays unpainted —
  // being open in a background lane is not a state the user asked to see, so
  // `.open` remains data (`aria-selected`, the smoke probes) and styles nothing.
  //
  // Verified by mutation: dropping `.session-row.active`, moving it above
  // `.selected`, or re-adding any of the forbidden tiers below reds this test
  // and nothing else.
  assert.ok(
    declares(blockFor('.session-row.active'), 'background', 'var(--surface-active)'),
    'the session on screen must be the one row that is filled',
  )
  for (const selector of [
    '.session-row.active .session-open',
    '.session-row:not(.open) .session-open',
    '.project-group.own > .project-heading',
  ]) {
    assert.equal(
      blocks.find((block) => block.selector === selector),
      undefined,
      `${selector} must not exist; only the active row's own fill paints`,
    )
  }

  // All four are one class on `.session-row`, so the sheet's order *is* the
  // precedence: hover under the cursor, the cursor under the active fill (a row
  // that is both keeps the fill and gains the hairline), and confirming last —
  // the row asking "delete this?" must be the one row that looks like it is.
  const order = (selector: string): number => {
    const index = blocks.findIndex((block) => block.selector === selector)
    assert.notEqual(index, -1, `no rule for ${selector}`)
    return index
  }
  assert.ok(
    declares(blockFor('.session-row.selected'), 'background', 'var(--surface-hover)'),
    'the keyboard cursor keeps its hover fill and hairline',
  )
  assert.ok(
    order('.session-row:hover') < order('.session-row.selected'),
    '.session-row.selected must come after :hover, or the cursor is invisible under the pointer',
  )
  assert.ok(
    order('.session-row.selected') < order('.session-row.active'),
    '.session-row.active must come after .selected, or the cursor fill hides which session is open',
  )
  assert.ok(
    order('.session-row.active') < order('.session-row.confirming'),
    '.session-row.confirming must come last, or the active paint hides the question',
  )

  // The brand bar beside the fill. It has to exist on the resting row — a
  // pseudo-element created by `.active` would appear at full height with nothing
  // to animate from — so the resting rule carries the paint at `scaleY(0)` and
  // `.active` only reopens it.
  const bar = blockFor('.session-row::before')
  assert.ok(declares(bar, 'transform', 'scaleY(0)'), 'the resting bar must be collapsed, not absent')
  assert.ok(declares(bar, 'transform-origin', 'center'), 'the bar grows from the row’s middle')
  assert.ok(declares(bar, 'width', '3px'), 'the bar is a 3px rule, not a stripe')
  assert.ok(
    declares(blockFor('.session-row.active::before'), 'transform', 'scaleY(1)'),
    'only the session on screen shows the bar',
  )
  assert.ok(
    order('.session-row::before') < order('.session-row.active::before'),
    'the resting bar must come first, or the active row never opens it',
  )
})

test('the search box and the composer chips are grooves at rest, not outlined fields', () => {
  // design_guidance 六.2 / 六.4. Three bordered capsules — the search box on the
  // sidebar's paper, the two chips over the composer's own hairline — read as
  // line noise; the fill alone says "this is a control". The border stays in the
  // box as `transparent` so raising it on hover cannot move anything.
  const search = blockFor('.sidebar-search')
  assert.ok(declares(search, 'background', 'var(--surface-card)'), 'the search box is a card groove')
  assert.ok(declares(search, 'border', '0'), 'the search box carries no border at rest')
  assert.ok(
    declares(blockFor('.sidebar-search:focus'), 'box-shadow', '0 0 0 1px var(--focus-ring)'),
    'focus rings the groove with a shadow, not a border that would resize the box',
  )

  for (const chip of ['#chip-permission', '#chip-runtime']) {
    const rest = blockFor(chip)
    assert.ok(declares(rest, 'background', 'var(--surface-card)'), `${chip} is a card capsule`)
    assert.ok(
      declares(rest, 'border', '1px solid transparent'),
      `${chip} must reserve its border, or hover reflows the composer's bottom row`,
    )
    assert.ok(
      declares(blockFor(`${chip}:hover:enabled`), 'border-color', 'var(--border-subtle)'),
      `${chip} raises a hairline on hover`,
    )
    assert.ok(
      declares(blockFor(`${chip}.open`), 'border-color', 'var(--border-strong)'),
      `${chip} raises a strong hairline while its menu is open`,
    )
  }
})

test('a collapsed sidebar is gone, and the column inside it does not resize with it', () => {
  // The 44px rail existed so `.sidebar-collapse` stayed clickable; that control
  // moved to the title bar, so collapsing now means zero width (todo D8).
  // Verified by mutation: restoring `44px` reds the first assertion, giving the
  // shell a flexible basis reds the second.
  assert.ok(
    declares(blockFor('#sidebar.collapsed'), 'flex-basis', '0'),
    'a collapsed sidebar must take no width; the rail it used to keep is now in the title bar',
  )
  // The regions ride out on opacity and travel instead of being re-laid out at
  // every width between 280 and 0 — a reflow per frame is the collapse reading
  // as the list tearing itself up.
  // One axis, and it is the property the drag handle writes: the shell and the
  // rail must resolve their width from the *same* custom property, or a resized
  // sidebar would crop its own column.
  assert.ok(
    declares(blockFor('.sidebar-shell'), 'width', 'var(--sidebar-width)'),
    'the shell must hold the open width while `#sidebar` animates around it',
  )
  assert.ok(
    declares(blockFor('#sidebar'), 'flex', '0 0 var(--sidebar-width)'),
    'the rail and the shell must read one width',
  )
  // The default lives in the token block, where a first run (and every test that
  // never touches localStorage) resolves it. Pinned against the model's constant
  // so the two cannot drift.
  assert.equal(
    tokens.get('--sidebar-width'),
    `${SIDEBAR_WIDTH_DEFAULT}px`,
    'the stylesheet default and model/sidebarWidth.ts must agree',
  )
  // ...and it holds that width through `width`, not through a flex basis:
  // `#sidebar` is a column, so a basis there is a fixed *height*. `0 0 280px`
  // capped the shell at 280px tall, which left `.sidebar-list` nothing to grow
  // into and stranded `.sidebar-footer` — the settings row — in mid-column.
  assert.ok(
    declares(blockFor('.sidebar-shell'), 'flex', '1 1 auto'),
    'the shell must fill the sidebar on the main axis; a basis here is a height, not a width',
  )
  assert.ok(
    declares(blockFor('#sidebar.collapsed .sidebar-shell'), 'opacity', '0'),
    'the column has to fade, or the crop slices legible text',
  )
  // The canvas owns its margin on all four sides now. The two rules that used to
  // hand it back a left inset (a collapsed sidebar, and the settings screen)
  // animated an inset against a column that was itself animating, and the gap
  // between them pumped.
  assert.equal(
    blocks.find((block) => block.selector === '#sidebar.collapsed + #canvas'),
    undefined,
    '#canvas must not borrow its left inset back from the sidebar',
  )
})

test('the fold falls back on a timer just past the slow token', () => {
  // `transitionend` is not a guarantee — a hidden window runs no transitions and
  // reduced motion cuts them to 1ms — so the view arms a timer beside it. Pinned
  // here because the two live in different files: a token retimed without this
  // would leave the fold unmounting its rows before the animation had finished.
  const slow = Number.parseInt(tokens.get('--motion-slow') ?? '', 10)
  assert.ok(Number.isFinite(slow), '--motion-slow must be a ms duration')
  assert.ok(
    SIDEBAR_COLLAPSE_FALLBACK_MS > slow && SIDEBAR_COLLAPSE_FALLBACK_MS <= slow + 100,
    `the fallback (${SIDEBAR_COLLAPSE_FALLBACK_MS}ms) must sit just past --motion-slow (${slow}ms)`,
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

test('the bead is the tool step\'s whole status vocabulary, and it stays flat', () => {
  // §3: four states, one 7px dot, and the *only* place the transcript says how a
  // tool call went. Each state has to be a rule of its own — a state the sheet
  // never names is one the view can emit and nobody sees — and the two settled
  // ones have to differ by more than a hue, because colour alone is one channel
  // and a red/green pair is the one pair that fails first.
  const bead = blockFor('.step-bead')
  assert.ok(declares(bead, 'width', '7px'), 'the step bead is the 7px dot §3 specifies')
  const named = (state: string): Block => blockFor(`.step-bead.${state}`)
  assert.equal(named('awaiting-approval').decls.find((d) => d.prop === 'color')?.value, 'var(--accent-warn)')
  assert.equal(named('done').decls.find((d) => d.prop === 'color')?.value, 'var(--accent-review)')
  assert.equal(named('failed').decls.find((d) => d.prop === 'color')?.value, 'var(--accent-danger)')
  for (const state of ['awaiting-approval', 'running', 'done', 'failed']) {
    assert.ok(
      named(state).decls.some((decl) => decl.prop === 'animation'),
      `.step-bead.${state} carries no motion; colour alone is one channel`,
    )
  }
  // The two that are over do not loop: a settled step must not keep moving under
  // a reader who has gone back to it.
  for (const state of ['done', 'failed']) {
    assert.ok(
      !named(state).decls.some((decl) => decl.prop === 'animation' && /infinite/.test(decl.value)),
      `.step-bead.${state} loops forever; only the two live states may`,
    )
  }

  // A step is not a card (§9). Depth is the sheet's two steps and a step is
  // neither of them, so the layering inside a group is indentation, whitespace
  // and the group's own hairline — never a third shadow or radius rung.
  for (const block of blocks) {
    if (!/^\.step\b|^\.activity-group\b|^\.group-steps\b/.test(block.selector.trim())) continue
    for (const decl of block.decls) {
      assert.notEqual(decl.prop, 'box-shadow', `${block.selector} gives a step a card's depth`)
    }
  }
})

test('the disclosure folds by height, and only when it opens', () => {
  // `0fr → 1fr` rather than a pixel height: the row opens to whatever its body
  // measures. It is an animation and not a transition because §8 keeps a folded
  // body *absent* — the node is built at open time, and a transition on an
  // element being inserted never runs.
  const from = blocks.find((block) => block.selector === 'from'
    && block.decls.some((decl) => decl.prop === 'grid-template-rows'))
  assert.ok(from, 'no `unfold` keyframe; the disclosure has nothing to open with')
  assert.equal(from.decls.find((decl) => decl.prop === 'grid-template-rows')?.value, 'auto 0fr')

  // Scoped by `:not(.collapsed)`, which is what stops it replaying: the animation
  // is attached and detached by the one class that opens the row, so a step being
  // refilled by its own streaming result stays still.
  const opened = blocks.filter((block) => block.decls.some(
    (decl) => decl.prop === 'animation' && /\bunfold\b/.test(decl.value),
  ))
  assert.ok(opened.length > 0, 'nothing plays `unfold`')
  for (const block of opened) {
    for (const one of block.selector.split(',')) {
      assert.match(one.trim(), /:not\(\.collapsed\)$/, `${one.trim()} would replay the fold on every paint`)
    }
  }
  // The grid item has to be able to reach zero, or `0fr` collapses to the
  // content's height and the fold is a no-op.
  const body = blockFor('.step-body')
  assert.ok(declares(body, 'overflow', 'hidden'), '.step-body must clip while the row folds')
  assert.ok(declares(body, 'min-height', '0'), '.step-body must be allowed under its content')
})

test('every floating menu is lifted off the page it covers', () => {
  // The dropdowns are the same object at several sizes, and a menu without the
  // float shadow does not look wrong so much as *flat*: in light mode
  // `--surface-card` is a hair off the body it covers, and the border alone is
  // not enough to say the panel is above rather than in the text. `.settings-menu`
  // was the one that shipped without it. `.chip-flyout` is the one that floats
  // over another menu rather than over the page, and needs it most.
  for (const selector of [
    '.titlebar-menu',
    '.canvas-menu',
    '.composer-menu',
    '.settings-menu',
    '.chip-menu',
    '.chip-flyout',
  ]) {
    assert.ok(
      declares(blockFor(selector), 'box-shadow', 'var(--shadow-float)'),
      `${selector} floats over other content and must carry var(--shadow-float)`,
    )
  }
})

test('depth is two steps: menus float, modals sit deeper, and the composer joins them on focus', () => {
  // Three surfaces, two shadows. Menus and the focused composer are *over the
  // page*; the two dialog panels are over a dimmed app and carry the heavier
  // `--shadow-modal`. Anything that reaches for a third depth is inventing one.
  for (const selector of ['.titlebar-menu', '.canvas-menu', '.composer-menu', '.settings-menu', '.chip-menu', '.chip-flyout', '.project-menu']) {
    assert.ok(
      declares(blockFor(selector), 'border-radius', 'var(--radius-md)'),
      `${selector} is a menu card and takes the menu radius`,
    )
  }
  for (const selector of ['#overlay-panel', '#rewind-panel']) {
    const panel = blockFor(selector)
    assert.ok(
      declares(panel, 'border-radius', 'var(--radius-lg)'),
      `${selector} is a modal panel, not a menu: it takes --radius-lg`,
    )
    assert.ok(
      declares(panel, 'box-shadow', 'var(--shadow-modal)'),
      `${selector} sits over a dimmed app and must carry var(--shadow-modal)`,
    )
  }

  const focused = blockFor('#composer:focus-within')
  assert.ok(
    declares(focused, 'border-color', 'var(--border-strong)'),
    'the focused composer firms its hairline',
  )
  assert.ok(
    declares(focused, 'box-shadow', 'var(--shadow-float)'),
    'the focused composer lifts off the page instead of only recolouring',
  )
  // A shadow that snaps on is a flicker at every focus change; `#composer`
  // outlives the state, so it is a legal carrier for the transition.
  assert.ok(
    blockFor('#composer').decls.some((decl) => decl.prop === 'transition'),
    '#composer must animate into its focused depth',
  )

  // The layering the popovers were built against: composer stack under every
  // menu, menus under both modal layers, rewind under overlay (a permission
  // prompt has to beat the rewind sheet).
  for (const [selector, z] of [
    ['#composer-popovers', '4'],
    ['.composer-menu', '5'],
    ['.chip-menu', '5'],
    ['.settings-menu', '5'],
    ['.canvas-menu', '5'],
    ['.chip-flyout', '6'],
    ['#rewind', '9'],
    ['#overlay', '10'],
  ] as const) {
    assert.ok(declares(blockFor(selector), 'z-index', z), `${selector} belongs on layer ${z}`)
  }

  // Every popover here is absolute against one of these shells; an `overflow`
  // on any of them clips the card the moment it hangs past the shell's box.
  for (const selector of [
    '.chip-menu-shell',
    '.canvas-menu-shell',
    '.settings-menu-shell',
    '.titlebar-menu-shell',
  ]) {
    assert.ok(
      !blockFor(selector).decls.some((decl) => decl.prop.startsWith('overflow')),
      `${selector} is on a popover's ancestor chain and must not clip it`,
    )
  }
})

test('motion comes from the tokens, and the things that rebuild themselves have none', () => {
  // Same argument as the palette: a duration written beside the control that
  // happens to use it is a duration nobody can compare, and a sheet with a dozen
  // ad-hoc timings reads as several interfaces.
  let transitions = 0
  for (const block of blocks) {
    for (const decl of block.decls) {
      if (decl.prop !== 'transition') continue
      // `none` is the one value that is not a timing: it *suspends* a transition
      // declared elsewhere (the sidebar's collapse, while its edge is being
      // dragged), and there is no duration or curve for it to name.
      if (decl.value.trim() === 'none') continue
      transitions += 1
      assert.match(
        decl.value,
        /var\(--motion-(fast|base|slow)\)/,
        `${block.selector} { transition: ${decl.value} } spells its own duration`,
      )
      assert.match(
        decl.value,
        /var\(--ease-(standard|exit)\)/,
        `${block.selector} { transition: ${decl.value} } spells its own curve`,
      )
    }
  }
  assert.ok(transitions >= 3, `expected the motion rules, found ${transitions} transitions`)

  // The two places an entrance animation would replay itself to death:
  // `dom/transcriptView.ts` rebuilds the whole scroller on every paint (during a
  // stream, every token), and the two dialog panels re-render as the selection
  // moves — their animation belongs on the scrim behind them, which is why
  // `#overlay`/`#rewind` are the ones that carry it.
  // Only the *entrance* animations: `breathe` on the thinking header is a
  // looping state, and re-running it on a rebuild is what it means anyway.
  const ENTRANCES = /\b(fade-in|drop-in|rise-in|slide-in)\b/
  for (const block of blocks) {
    const animated = block.decls.some(
      (decl) => decl.prop === 'animation' && ENTRANCES.test(decl.value),
    )
    if (!animated) continue
    assert.ok(
      !/^(\.transcript \.item|#overlay-panel|#rewind-panel)\b/.test(block.selector),
      `${block.selector} is rebuilt on every render; an entrance animation there replays forever`,
    )
  }

  // The three entrance keyframes travel one distance and arrive from one scale.
  // The parser flattens `@keyframes`, so its `from` steps come through as blocks
  // named `from` — every one of them that moves is one of these three.
  let entranceSteps = 0
  for (const block of blocks) {
    if (block.selector !== 'from') continue
    for (const decl of block.decls) {
      if (decl.prop !== 'transform') continue
      entranceSteps += 1
      assert.match(
        decl.value,
        /^translate[XY]\(-?8px\) scale\(0\.98\)$/,
        `from { transform: ${decl.value} } is not the 8px + 0.98 entrance`,
      )
    }
  }
  assert.equal(entranceSteps, 3, 'expected drop-in, rise-in and slide-in to move')

  // The reduced-motion override, which is the one nested at-rule this sheet is
  // allowed. `1ms` rather than `0s`: a zero-length transition never fires
  // `transitionend`, and no listener should have to know about the setting.
  const reduced = blockFor('*, *::before, *::after')
  assert.ok(declares(reduced, 'transition-duration', '1ms !important'), 'transitions must collapse')
  assert.ok(declares(reduced, 'animation-duration', '1ms !important'), 'animations must collapse')
  assert.ok(
    declares(reduced, 'animation-iteration-count', '1 !important'),
    'the infinite animations (spin, breathe, blink, sheen) must stop as well',
  )
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
  // Verified by mutation: deleting any one rule reds this test and nothing else.
  // The two activity-group heads join the list for the same reason and one of
  // their own: the row *is* the switch (§9 draws no disclosure chevron), so the
  // hover tint is the only affordance either control has, and a contextual rule
  // like `.activity-group.collapsed .group-head` would leave it a bare user-agent
  // button at rest — which on a row with no glyph reads as plain text.
  for (const selector of ['.thinking-header', '.scroll-bottom', '.group-head', '.step-head']) {
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
