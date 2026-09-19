/**
 * Clicking, typing and scrolling: the host's half of acting on a page.
 *
 * Electron-free on purpose. It takes an evaluator, a CDP sender and an identity
 * object, so the whole sequence a click is — resolve in the page, move, press,
 * release — can be asserted against stubs in a plain `node:test` process. The
 * real wiring is two lines in `host.ts`.
 *
 * Three rules shape it:
 *
 * - **One tab, one queue.** Actions on a tab are serialized so a click and the
 *   typing that follows cannot interleave; the chain is broken with a swallowed
 *   rejection so one failure does not poison everything queued behind it.
 * - **`check()` at every boundary.** Cancellation is checked before dispatch and
 *   again after each await, which puts the granularity at one CDP command rather
 *   than at one operation. Phase 5's takeover arbitration hangs off the same
 *   hook — it is the one place a "stop now" can be observed mid-burst.
 * - **Nothing echoes what was typed.** The evidence line counts characters. A
 *   password typed into a field the projection refuses to read must not come
 *   back through the transcript instead.
 */

import type { ScrollOptions, ScrollResult, TargetOptions, TargetResult } from './inject/bundle.js'
import { resolveScript, scrollScript, unwrap } from './inject/bundle.js'
import { BrowserHostError } from './errors.js'
import { FIELD_MAX_NAME, SCROLL_VIEWPORT_FRACTION, SENSITIVE_AUTOCOMPLETE, TYPE_TEXT_MAX } from './limits.js'

export type InputEvaluator = (script: string) => Promise<unknown>
export type InputSender = (method: string, params?: Record<string, unknown>) => Promise<unknown>

export interface InputDeps {
  /** The tab's `WebContents`, used only as the queue's identity. */
  key: object
  send: InputSender
  evaluate: InputEvaluator
  /** Throws when the action must stop. Called before and after every await. */
  check: () => void
  /** `process.platform`, injected so the macOS key path is testable anywhere. */
  platform: string
}

export interface ClickRequest {
  ref?: string
  selector?: string
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
}

export interface TypeRequest {
  ref?: string
  selector?: string
  text: string
  /** Select the field's contents and delete them before typing. */
  clear?: boolean
  /** Press Enter afterwards. */
  submit?: boolean
}

export interface ScrollRequest {
  ref?: string
  selector?: string
  direction?: 'up' | 'down' | 'top' | 'bottom'
  amount?: number
}

export interface ActionResult {
  text: string
}

/** CDP's modifier bitmask. Only the two the editing shortcuts need. */
const MOD_CTRL = 2
const MOD_META = 4

const BUTTON_MASK: Record<string, number> = { left: 1, right: 2, middle: 4 }

const pending = new Map<object, Promise<void>>()
const active = new Set<object>()

/**
 * Whether the agent is mid-burst on this tab.
 *
 * Phase 5 reads it to decide whether a key event in the page is the user taking
 * over or the echo of our own typing: a keystroke that arrives while this is
 * true came from us, and treating it as a takeover would abort every automation
 * sequence halfway through.
 */
export function isInputActive(key: object): boolean {
  return active.has(key)
}

/**
 * Runs `task` after everything already queued for this tab.
 *
 * The bookkeeping compares task identity before deleting: without that check a
 * finishing task removes the entry a *later* task has already installed, and the
 * queue silently stops serializing.
 */
export function enqueueInput<T>(key: object, task: () => Promise<T>): Promise<T> {
  const prior = pending.get(key) ?? Promise.resolve()
  const result = prior.then(task)
  const settled = result.then(
    () => undefined,
    () => undefined,
  )
  pending.set(key, settled)
  void settled.then(() => {
    if (pending.get(key) === settled) pending.delete(key)
  })
  return result
}

function exclusive<T>(deps: InputDeps, task: () => Promise<T>): Promise<T> {
  return enqueueInput(deps.key, async () => {
    active.add(deps.key)
    try {
      return await task()
    } finally {
      active.delete(deps.key)
    }
  })
}

export function clickTarget(deps: InputDeps, request: ClickRequest): Promise<ActionResult> {
  return exclusive(deps, async () => {
    const target = await resolve(deps, request, { focus: false, requireEnabled: true })
    const button = request.button ?? 'left'
    const clickCount = Math.min(3, Math.max(1, Math.floor(request.clickCount ?? 1)))
    const at = { x: Math.round(target.x), y: Math.round(target.y) }

    // The move comes first because half the web only reveals what it is about to
    // be clicked on hover: a menu that opens on `mouseover` is not open yet when
    // the press lands without one.
    deps.check()
    await deps.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'none', buttons: 0 })
    deps.check()
    const buttons = BUTTON_MASK[button] ?? 1
    await deps.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button, buttons, clickCount })
    deps.check()
    await deps.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button, buttons, clickCount })
    deps.check()

    const how = clickCount > 1 ? `${clickCount}× ${button}-clicked` : button === 'left' ? 'clicked' : `${button}-clicked`
    return { text: `${how} ${describe(target)} at (${at.x}, ${at.y}). ${where(target)}` }
  })
}

export function typeText(deps: InputDeps, request: TypeRequest): Promise<ActionResult> {
  if (request.text.length > TYPE_TEXT_MAX) {
    throw new BrowserHostError(
      'INVALID_REQUEST',
      `page.type takes at most ${TYPE_TEXT_MAX} characters at a time; this call had ${request.text.length}.`,
    )
  }
  return exclusive(deps, async () => {
    const target = await resolve(deps, request, { focus: true, requireEnabled: true })

    if (request.clear === true) {
      deps.check()
      await selectAll(deps)
      deps.check()
      await pressKey(deps, BACKSPACE)
      deps.check()
    }
    if (request.text !== '') {
      // `insertText` rather than a key event per character: a hundred round trips
      // is a visible stall, and a page that reacts to `input` — which is all of
      // them — cannot tell the difference. Pages keyed on `keydown` for
      // individual characters are the known gap, and `submit` covers the common
      // one of those.
      await deps.send('Input.insertText', { text: request.text })
      deps.check()
    }
    if (request.submit === true) {
      await pressKey(deps, ENTER)
      deps.check()
    }

    const parts = [`typed ${request.text.length} characters into ${describe(target)}`]
    if (request.clear === true) parts.push('after clearing it')
    if (request.submit === true) parts.push('then pressed Enter')
    return { text: `${parts.join(', ')}. ${where(target)}` }
  })
}

export function scrollPage(deps: InputDeps, request: ScrollRequest): Promise<ActionResult> {
  return exclusive(deps, async () => {
    const options: ScrollOptions = {
      direction: request.direction ?? 'down',
      viewportFraction: SCROLL_VIEWPORT_FRACTION,
    }
    if (request.ref !== undefined) options.ref = request.ref
    if (request.selector !== undefined) options.selector = request.selector
    if (request.amount !== undefined) options.amount = Math.max(1, Math.floor(request.amount))

    deps.check()
    const result = unwrap<ScrollResult>(await deps.evaluate(scrollScript(options)))
    deps.check()

    const position = `y=${Math.round(result.scrollY)} of ${Math.round(result.maxScrollY)}`
    const end = result.atBottom ? ' (bottom of the page)' : ''
    return { text: `scrolled ${result.target}: ${position}${end}. url=${result.url} title=${result.title}` }
  })
}

// --- internals ---------------------------------------------------------------

async function resolve(
  deps: InputDeps,
  request: { ref?: string; selector?: string },
  mode: { focus: boolean; requireEnabled: boolean },
): Promise<TargetResult> {
  if ((request.ref ?? '') === '' && (request.selector ?? '') === '') {
    throw new BrowserHostError(
      'INVALID_REQUEST',
      'Name a "ref" from page.elements.snapshot, or a CSS "selector".',
    )
  }
  const options: TargetOptions = {
    nameMax: FIELD_MAX_NAME,
    sensitiveWords: SENSITIVE_AUTOCOMPLETE,
    scrollIntoView: true,
    focus: mode.focus,
    requireEnabled: mode.requireEnabled,
  }
  // A ref wins: it addresses the element the model actually read, while a
  // selector is re-resolved against whatever matches now.
  if ((request.ref ?? '') !== '') options.ref = request.ref
  else options.selector = request.selector

  deps.check()
  const target = unwrap<TargetResult>(await deps.evaluate(resolveScript(options)))
  deps.check()
  return target
}

/** The element, as the transcript should remember it. Never its value. */
function describe(target: TargetResult): string {
  const handle = target.ref !== undefined ? target.ref : (target.selector ?? 'element')
  const name = target.sensitive || target.name === '' ? '' : ` "${target.name}"`
  return `${handle} (${target.role}${name})`
}

function where(target: TargetResult): string {
  return `url=${target.url} title=${target.title}`
}

interface Key {
  key: string
  code: string
  virtualKeyCode: number
  text?: string
  /** macOS editing commands, which is the only way the system ones fire. */
  command?: string
}

const BACKSPACE: Key = { key: 'Backspace', code: 'Backspace', virtualKeyCode: 8, command: 'deleteBackward' }
const ENTER: Key = { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r' }

async function pressKey(deps: InputDeps, key: Key): Promise<void> {
  const base: Record<string, unknown> = {
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.virtualKeyCode,
    nativeVirtualKeyCode: key.virtualKeyCode,
  }
  if (key.text !== undefined) {
    base['text'] = key.text
    base['unmodifiedText'] = key.text
  }
  const down: Record<string, unknown> = { ...base, type: key.text === undefined ? 'rawKeyDown' : 'keyDown' }
  if (key.command !== undefined && isMac(deps)) down['commands'] = [key.command]
  await deps.send('Input.dispatchKeyEvent', down)
  deps.check()
  await deps.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
}

/**
 * Select everything in the focused field.
 *
 * On macOS the modifier alone does nothing: Chromium maps `Meta+A` to the
 * `selectAll` editing command through the system key bindings, which CDP only
 * reaches through the `commands` field. Elsewhere `Ctrl+A` is the event itself.
 */
async function selectAll(deps: InputDeps): Promise<void> {
  const mac = isMac(deps)
  const event: Record<string, unknown> = {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: mac ? MOD_META : MOD_CTRL,
  }
  if (mac) event['commands'] = ['selectAll']
  await deps.send('Input.dispatchKeyEvent', event)
  deps.check()
  await deps.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: mac ? MOD_META : MOD_CTRL,
  })
}

function isMac(deps: InputDeps): boolean {
  return deps.platform === 'darwin'
}
