/**
 * The two languages the shared presentation layer speaks.
 *
 * Stage-4 decision 5: the desktop shell is Chinese and the TUI stays English,
 * but neither may fork the presentation modules — `test/rewindPresentation.test.ts`
 * asserts *function identity* through `RestoreMode.tsx`'s re-export, so a second
 * copy is not merely discouraged, it fails the build.
 *
 * Hence a parameter, and hence an **optional** one defaulting to `'en'`. Making
 * it required would mean editing some twenty-five TUI call sites for no
 * behavioural gain, and every one of those is a chance to type `'zh'` into a
 * terminal by accident. The three presentation tests each pin the default, so a
 * later flip fails loudly here rather than quietly in someone's shell.
 */

export type Locale = 'zh' | 'en'

export const DEFAULT_LOCALE: Locale = 'en'
