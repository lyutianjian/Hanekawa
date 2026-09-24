export const BROWSER_TOOL_NAME = 'Browser'

/**
 * Every operation, in the order the description lists them.
 *
 * One tool with an `operation` discriminator rather than one tool each: they
 * share a tab handle and are useless apart, and fifteen entries would cost
 * fifteen schemas in every request's tool list.
 */
export const BROWSER_OPERATIONS = [
  'browser.get_state',
  'browser.create_tab',
  'browser.close_tab',
  'tab.navigate',
  'tab.go_back',
  'tab.go_forward',
  'tab.reload',
  'tab.wait_for_load',
  'tab.emulate',
  'page.elements.snapshot',
  'page.text.snapshot',
  'page.screenshot',
  'page.click',
  'page.click_at',
  'page.type',
  'page.press_key',
  'page.select_option',
  'page.set_checked',
  'page.hover',
  'page.scroll',
  'page.wait_for',
] as const

export type BrowserOperation = (typeof BROWSER_OPERATIONS)[number]

/** Operations that name a tab. The rest either make one or list them all. */
export const OPERATIONS_NEEDING_TAB: ReadonlySet<string> = new Set<BrowserOperation>([
  'browser.close_tab',
  'tab.navigate',
  'tab.go_back',
  'tab.go_forward',
  'tab.reload',
  'tab.wait_for_load',
  'tab.emulate',
  'page.elements.snapshot',
  'page.text.snapshot',
  'page.screenshot',
  'page.click',
  'page.click_at',
  'page.type',
  'page.press_key',
  'page.select_option',
  'page.set_checked',
  'page.hover',
  'page.scroll',
  'page.wait_for',
])

/**
 * Operations that only read the page.
 *
 * Read-only is the concurrency answer too: two snapshots of two tabs cannot
 * disturb each other, while a navigation moves the document a snapshot running
 * beside it is describing.
 */
export const READ_ONLY_OPERATIONS: ReadonlySet<string> = new Set<BrowserOperation>([
  'browser.get_state',
  'page.elements.snapshot',
  'page.text.snapshot',
  'page.screenshot',
])

/**
 * Operations that act on an element and so need one named.
 *
 * The flat schema cannot say "one of `ref` or `selector`", so this table and
 * `validate.ts` say it instead — before the call reaches a page that would
 * refuse it with a less useful sentence.
 */
export const OPERATIONS_NEEDING_TARGET: ReadonlySet<string> = new Set<BrowserOperation>([
  'page.click',
  'page.type',
  'page.select_option',
  'page.set_checked',
  'page.hover',
])

/**
 * Restated from `desktop/browser/limits.ts` rather than imported: `src/tools/`
 * is shared with the TUI and must not reach into the Electron half. Two numbers
 * duplicated, and the schema is the one that has to tell the model the bound.
 */
export const WAIT_FOR_LOAD_DEFAULT_MS = 15_000
export const WAIT_FOR_LOAD_MAX_MS = 120_000
/** `page.wait_for` is about a widget appearing, not a document arriving. */
export const WAIT_FOR_DEFAULT_MS = 10_000
export const WAIT_FOR_MAX_MS = 30_000
export const TYPE_TEXT_MAX = 10_000
export const PRESS_KEYS_MAX = 8
/** Emulated viewport bounds, in CSS pixels, and the pixel ratio's. */
export const EMULATE_SIZE_MIN = 100
export const EMULATE_SIZE_MAX = 4000
export const EMULATE_SCALE_MAX = 4
