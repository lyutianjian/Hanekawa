/**
 * Turns the collectors into the string that crosses into the page.
 *
 * There is no build step and no bundled asset. `Function.prototype.toString`
 * returns the compiled source of a function, so the "bundle" is that source for
 * each function the entry point calls, concatenated, followed by one call. The
 * whole thing is an IIFE because `executeJavaScriptInIsolatedWorld` resolves to
 * the completion value of the script, and an expression is the only shape that
 * reliably has one.
 *
 * Why this rather than a real bundler: the collectors keep their types, share
 * the limits table with the encoder, and are checked by the same `tsc` run as
 * everything else. The cost is the discipline in `semantics.ts`'s header — no
 * imports survive, so every function a collector calls has to be listed here.
 * Forgetting one is a `ReferenceError` on the first run against a real page,
 * which is why `test/browserInject.test.ts` runs the built script in `node:vm`.
 *
 * The entry's name is read from the function object rather than written out, so
 * a minifier or transform that renames the declaration renames the call with it.
 */

import {
  hkCheckCondition,
  hkCheckState,
  hkContains,
  hkDeepActive,
  hkDeepHit,
  hkDescribe,
  hkFindTarget,
  hkGuardTarget,
  hkQuery,
  hkResolveTarget,
  hkScrollPage,
  hkSelectOption,
  type CheckStateOptions,
  type CheckStateResult,
  type ConditionOptions,
  type ConditionResult,
  type ConditionState,
  type GuardOptions,
  type ScrollOptions,
  type ScrollResult,
  type SelectOptions,
  type SelectResult,
  type TargetOptions,
  type TargetResult,
} from './actions.js'
import {
  hkCollectElements,
  hkFlag,
  hkForgetRefs,
  hkValue,
  type ElementScanOptions,
  type ElementScanResult,
} from './elements.js'
import {
  hkInputRole,
  hkInteractive,
  hkName,
  hkOffscreen,
  hkParent,
  hkProp,
  hkRole,
  hkSensitive,
  hkString,
  hkTag,
  hkText,
  hkTrim,
  hkVisible,
  hkWalk,
} from './semantics.js'
import { hkBlockOf, hkCollectText, hkTextBlocks, type TextScanOptions, type TextScanResult } from './text.js'
import { BrowserHostError } from '../errors.js'

const SHARED = [
  hkProp,
  hkString,
  hkTag,
  hkTrim,
  hkParent,
  hkVisible,
  hkInputRole,
  hkRole,
  hkSensitive,
  hkText,
  hkName,
  hkInteractive,
  hkWalk,
]

/** Text grouped by block, shared by the text snapshot and `wait_for`'s text match. */
const TEXT = [hkBlockOf, hkTextBlocks]

/** Hit testing and focus, through shadow roots. */
const AIM = [hkDeepHit, hkContains, hkDeepActive, hkDescribe]

export function elementsScript(options: ElementScanOptions): string {
  const call = `${hkCollectElements.name}(document, window, globalThis, ${literal(options)})`
  return wrap([...SHARED, hkFlag, hkValue, hkOffscreen, hkCollectElements], call)
}

/** Forgets every ref this page was handed; see `hkForgetRefs`. */
export function forgetRefsScript(): string {
  return wrap([hkForgetRefs], `${hkForgetRefs.name}(globalThis)`)
}

export function textScript(options: TextScanOptions): string {
  const call = `${hkCollectText.name}(document, window, ${literal(options)})`
  return wrap([...SHARED, ...TEXT, hkCollectText], call)
}

/** Where an element is, and whether it can be acted on at all. */
export function resolveScript(options: TargetOptions): string {
  const call = `${hkResolveTarget.name}(document, window, globalThis, ${literal(options)})`
  return wrap([...SHARED, ...AIM, hkFlag, hkQuery, hkFindTarget, hkResolveTarget], call)
}

/** Re-checks the resolved element right before an input command goes out. */
export function guardScript(options: GuardOptions): string {
  const call = `${hkGuardTarget.name}(document, globalThis, ${literal(options)})`
  return wrap([...SHARED, ...AIM, hkGuardTarget], call)
}

export function selectScript(options: SelectOptions): string {
  const call = `${hkSelectOption.name}(document, window, globalThis, ${literal(options)})`
  return wrap([...SHARED, hkFlag, hkQuery, hkFindTarget, hkSelectOption], call)
}

export function checkStateScript(options: CheckStateOptions): string {
  const call = `${hkCheckState.name}(document, globalThis, ${literal(options)})`
  return wrap([...SHARED, hkFlag, hkQuery, hkFindTarget, hkCheckState], call)
}

export function scrollScript(options: ScrollOptions): string {
  const call = `${hkScrollPage.name}(document, window, globalThis, ${literal(options)})`
  return wrap([...SHARED, hkQuery, hkFindTarget, hkScrollPage], call)
}

export function conditionScript(options: ConditionOptions): string {
  const call = `${hkCheckCondition.name}(document, window, ${literal(options)})`
  return wrap([...SHARED, ...TEXT, hkFlag, hkQuery, hkCheckCondition], call)
}

/**
 * Unpacks the page's answer.
 *
 * The collectors throw `CODE: message` so a failure that the model can act on —
 * a scope selector that matches nothing — arrives as `INVALID_REQUEST` rather
 * than as an opaque page error. Anything without that prefix is the page
 * misbehaving, not the request, and comes back as `PAGE_NOT_READY`.
 */
export function unwrap<T>(raw: unknown): T {
  const envelope = raw as { ok?: unknown; value?: unknown; message?: unknown } | null | undefined
  if (envelope === null || envelope === undefined || typeof envelope !== 'object') {
    throw new BrowserHostError('PAGE_NOT_READY', 'The page returned nothing. It may still be loading.', true)
  }
  if (envelope.ok === true) return envelope.value as T
  const message = typeof envelope.message === 'string' ? envelope.message : 'The page could not be read.'
  const coded = /^([A-Z][A-Z_]{2,40}):\s*(.*)$/.exec(message)
  if (coded === null) throw new BrowserHostError('PAGE_NOT_READY', message, true)
  return neverReturns(coded[1] as string, coded[2] as string)
}

function neverReturns(code: string, message: string): never {
  throw new BrowserHostError(code, message)
}

function wrap(fns: readonly Function[], call: string): string {
  const sources = fns.map((fn) => fn.toString()).join('\n')
  return [
    '(function () {',
    // What we stringify is *compiled* source, and a compiler that keeps function
    // names (esbuild's `--keep-names`, which is how this runs under tsx) rewrites
    // an inner `const f = () => …` into a call to its own `__name` helper. That
    // helper lives at the top of the emitted module, outside the function body,
    // so it does not come along — and the page sees a `ReferenceError` for a name
    // nothing in this repository ever wrote. The identity shim is what the real
    // helper amounts to once the page has the function: it only sets `.name`.
    'var __name = function (fn) { return fn };',
    sources,
    'try {',
    `  return { ok: true, value: ${call} }`,
    '} catch (error) {',
    '  return { ok: false, message: String(error && error.message ? error.message : error) }',
    '}',
    '})()',
  ].join('\n')
}

/**
 * JSON, minus the two characters that are line terminators in a script but not
 * in a JSON document. Everything else `JSON.stringify` escapes already.
 */
function literal(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u2028\u2029]/g,
    (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'),
  )
}

export type {
  CheckStateOptions,
  CheckStateResult,
  ConditionOptions,
  ConditionResult,
  ConditionState,
  ElementScanOptions,
  ElementScanResult,
  GuardOptions,
  ScrollOptions,
  ScrollResult,
  SelectOptions,
  SelectResult,
  TargetOptions,
  TargetResult,
  TextScanOptions,
  TextScanResult,
}
