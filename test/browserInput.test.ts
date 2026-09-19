import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserHostError } from '../src/desktop/browser/errors.js'
import {
  clickTarget,
  enqueueInput,
  isInputActive,
  scrollPage,
  typeText,
  type InputDeps,
} from '../src/desktop/browser/input.js'
import { TYPE_TEXT_MAX } from '../src/desktop/browser/limits.js'

/**
 * The input layer with the page and the debugger replaced by records.
 *
 * Everything worth pinning here is a sequence, not a pixel: which CDP commands
 * a click is and in what order, where cancellation is observed, and what the
 * evidence line is allowed to say. None of it needs a window, so none of these
 * tests opens one — the real script running against a real DOM is
 * `browserInject.test.ts`'s job.
 */

interface Sent {
  method: string
  params: Record<string, unknown>
}

interface Harness {
  deps: InputDeps
  sent: Sent[]
  scripts: string[]
}

interface TargetOverrides {
  ref?: string
  selector?: string
  role?: string
  name?: string
  sensitive?: boolean
  x?: number
  y?: number
}

function harness(options: {
  platform?: string
  target?: TargetOverrides
  scroll?: { scrollY?: number; maxScrollY?: number; atBottom?: boolean; target?: string }
  /** Throws on the n-th `check()`, counting from 1. Stands in for a cancel. */
  cancelAt?: number
} = {}): Harness {
  const sent: Sent[] = []
  const scripts: string[] = []
  let checks = 0

  const target = {
    ref: 'e1',
    role: 'button',
    name: 'Sign in',
    sensitive: false,
    x: 120.4,
    y: 240.6,
    width: 80,
    height: 24,
    focused: true,
    url: 'https://x.test/',
    title: 'X',
    ...options.target,
  }
  const scroll = {
    scrollY: 900,
    maxScrollY: 4000,
    viewport: 720,
    atBottom: false,
    target: 'down 648px',
    url: 'https://x.test/',
    title: 'X',
    ...options.scroll,
  }

  const deps: InputDeps = {
    key: {},
    platform: options.platform ?? 'linux',
    send: async (method, params) => {
      sent.push({ method, params: params ?? {} })
      return undefined
    },
    evaluate: async (script) => {
      scripts.push(script)
      return { ok: true, value: script.includes('hkScrollPage(') ? scroll : target }
    },
    check: () => {
      checks += 1
      if (options.cancelAt !== undefined && checks >= options.cancelAt) {
        throw new BrowserHostError('OPERATION_ABORTED', 'The browser action was cancelled.')
      }
    },
  }
  return { deps, sent, scripts }
}

function methods(sent: Sent[]): string[] {
  return sent.map((entry) => `${entry.method}:${String(entry.params['type'] ?? '')}`)
}

test('a click hovers before it presses, and lands on the rounded centre', async () => {
  const { deps, sent, scripts } = harness()
  const result = await clickTarget(deps, { ref: 'e1' })

  assert.deepEqual(methods(sent), [
    'Input.dispatchMouseEvent:mouseMoved',
    'Input.dispatchMouseEvent:mousePressed',
    'Input.dispatchMouseEvent:mouseReleased',
  ])
  assert.equal(scripts.length, 1)
  assert.match(scripts[0] ?? '', /hkResolveTarget\(document, window, globalThis/)
  for (const entry of sent) {
    assert.equal(entry.params['x'], 120)
    assert.equal(entry.params['y'], 241)
  }
  assert.equal(sent[1]?.params['button'], 'left')
  assert.equal(sent[1]?.params['clickCount'], 1)
  // The hover carries no button, or a page that watches `buttons` sees a drag.
  assert.equal(sent[0]?.params['buttons'], 0)
  assert.match(result.text, /clicked e1 \(button "Sign in"\) at \(120, 241\)/)
  assert.match(result.text, /url=https:\/\/x\.test\//)
})

test('a right or double click says so, in the event and in the evidence', async () => {
  const right = harness()
  const rightResult = await clickTarget(right.deps, { selector: '#menu', button: 'right' })
  assert.equal(right.sent[1]?.params['button'], 'right')
  assert.equal(right.sent[1]?.params['buttons'], 2)
  assert.match(rightResult.text, /right-clicked/)

  const double = harness()
  const doubleResult = await clickTarget(double.deps, { ref: 'e2', clickCount: 2 })
  assert.equal(double.sent[1]?.params['clickCount'], 2)
  assert.match(doubleResult.text, /2× left-clicked/)
})

test('an action with neither ref nor selector never reaches the page', async () => {
  const { deps, scripts, sent } = harness()
  await assert.rejects(
    () => clickTarget(deps, {}),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'INVALID_REQUEST',
  )
  assert.deepEqual(scripts, [])
  assert.deepEqual(sent, [])
})

test('a ref wins over a selector, because it names what was read', async () => {
  const { deps, scripts } = harness()
  await clickTarget(deps, { ref: 'e7', selector: '#other' })
  const script = scripts[0] ?? ''
  assert.match(script, /"ref":"e7"/)
  assert.doesNotMatch(script, /"selector"/)
})

test('clearing a field uses the platform’s own select-all', async () => {
  const mac = harness({ platform: 'darwin' })
  await typeText(mac.deps, { ref: 'e1', text: 'hi', clear: true })
  const macSelect = mac.sent[0]
  assert.equal(macSelect?.method, 'Input.dispatchKeyEvent')
  assert.deepEqual(macSelect?.params['commands'], ['selectAll'])
  assert.equal(macSelect?.params['modifiers'], 4)
  assert.deepEqual(mac.sent[2]?.params['commands'], ['deleteBackward'])

  const linux = harness({ platform: 'linux' })
  await typeText(linux.deps, { ref: 'e1', text: 'hi', clear: true })
  assert.equal(linux.sent[0]?.params['modifiers'], 2)
  assert.equal(linux.sent[0]?.params['commands'], undefined)
  assert.equal(linux.sent[2]?.params['commands'], undefined)
})

test('typing inserts the text once and never echoes it back', async () => {
  const { deps, sent } = harness({ target: { ref: 'e3', role: 'textbox', name: 'Password', sensitive: true } })
  const result = await typeText(deps, { ref: 'e3', text: 'hunter2', submit: true })

  const insert = sent.filter((entry) => entry.method === 'Input.insertText')
  assert.equal(insert.length, 1)
  assert.equal(insert[0]?.params['text'], 'hunter2')
  assert.equal(sent.at(-2)?.params['key'], 'Enter')
  assert.match(result.text, /typed 7 characters into e3 \(textbox\)/)
  assert.match(result.text, /then pressed Enter/)
  // Neither the secret nor the field's name: a sensitive field's name is part of
  // what the projection refuses to carry.
  assert.doesNotMatch(result.text, /hunter2/)
  assert.doesNotMatch(result.text, /Password/)
})

test('an oversized paste is refused before anything is focused', () => {
  const { deps, scripts } = harness()
  assert.throws(
    () => typeText(deps, { ref: 'e1', text: 'x'.repeat(TYPE_TEXT_MAX + 1) }),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'INVALID_REQUEST',
  )
  assert.deepEqual(scripts, [])
})

test('scrolling happens in the page, and reports where it stopped', async () => {
  const { deps, sent, scripts } = harness({ scroll: { scrollY: 4000, atBottom: true, target: 'bottom' } })
  const result = await scrollPage(deps, { direction: 'bottom' })

  assert.deepEqual(sent, [], 'a scroll needs no synthetic input at all')
  assert.match(scripts[0] ?? '', /"direction":"bottom"/)
  assert.match(result.text, /scrolled bottom: y=4000 of 4000 \(bottom of the page\)/)
})

test('a cancel is observed at the next boundary, not after the burst', async () => {
  // The first check runs before the page is even asked; the third is between
  // the resolve and the press.
  const { deps, sent } = harness({ cancelAt: 3 })
  await assert.rejects(
    () => clickTarget(deps, { ref: 'e1' }),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'OPERATION_ABORTED',
  )
  assert.deepEqual(sent, [], 'no input may be dispatched once the action is cancelled')
})

test('actions on one tab serialize, and one failure does not poison the queue', async () => {
  const key = {}
  const order: string[] = []
  const slow = enqueueInput(key, async () => {
    order.push('first:start')
    await new Promise((resolve) => setTimeout(resolve, 10))
    order.push('first:end')
    throw new Error('boom')
  })
  const next = enqueueInput(key, async () => {
    order.push('second')
    return 'ok'
  })

  await assert.rejects(() => slow)
  assert.equal(await next, 'ok')
  assert.deepEqual(order, ['first:start', 'first:end', 'second'])
})

test('the active flag is set for the length of an action and cleared after it', async () => {
  const { deps } = harness()
  assert.equal(isInputActive(deps.key), false)
  const inFlight: boolean[] = []
  const observed = enqueueInput(deps.key, async () => {
    inFlight.push(isInputActive(deps.key))
    return undefined
  })
  const click = clickTarget(deps, { ref: 'e1' })
  await click
  await observed
  assert.equal(isInputActive(deps.key), false)
})
