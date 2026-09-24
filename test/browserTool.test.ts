import assert from 'node:assert/strict'
import test from 'node:test'

import { createBrowserTool } from '../src/tools/BrowserTool/BrowserTool.js'
import { BROWSER_OPERATIONS } from '../src/tools/BrowserTool/constants.js'
import { NO_TABS } from '../src/tools/BrowserTool/encode.js'
import { browserApiInputSchema, browserInputSchema } from '../src/tools/BrowserTool/schema.js'
import { fieldsFor, validateBrowserInput } from '../src/tools/BrowserTool/validate.js'
import { normalizeToolInput } from '../src/tools/inputAliases.js'
import type {
  BrowserHost,
  BrowserSnapshot,
  BrowserTabState,
} from '../src/runtime/protocol/browserHost.js'
import type { ImageAttachmentImporter, Tool, ToolContext } from '../src/harness/types.js'
import { assertNoImageBytes, makeImageAttachmentRef } from './helpers/imageFixtures.js'

/**
 * The tool with the browser replaced by a record of what it was asked.
 *
 * Everything worth testing at this layer is a decision the tool makes on its
 * own: which host call an operation means, what a rejection teaches, and
 * whether a screenshot can reach the transcript as text. None of it needs a
 * window, so none of these tests opens one.
 */

interface Call {
  method: string
  args: unknown[]
}

function stubHost(overrides: Partial<BrowserHost> = {}): { host: BrowserHost; calls: Call[] } {
  const calls: Call[] = []
  const record = <T>(method: string, value: T) => async (...args: unknown[]): Promise<T> => {
    calls.push({ method, args })
    return value
  }
  const tab: BrowserTabState = { tabId: 'tab-1', url: 'https://x.test/', title: 'X', loading: false }
  const snapshot: BrowserSnapshot = { text: '# elements', snapshotId: 's1', scanTruncated: false, total: 0 }
  const host: BrowserHost = {
    listTabs: record('listTabs', [tab]),
    createTab: record('createTab', tab),
    closeTab: record('closeTab', undefined),
    navigate: record('navigate', tab),
    history: record('history', tab),
    waitForLoad: record('waitForLoad', tab),
    elements: record('elements', snapshot),
    text: record('text', snapshot),
    readSnapshot: record('readSnapshot', snapshot),
    screenshot: record('screenshot', {
      bytes: Buffer.from([1, 2, 3]),
      name: 'screenshot-x.test-abcd1234.png',
      width: 800,
      height: 600,
    }),
    click: record('click', { text: 'clicked e3 (button "Sign in") at (120, 240).' }),
    type: record('type', { text: 'typed 7 characters into e4 (textbox).' }),
    pressKey: record('pressKey', { text: 'pressed Escape on the focused element.' }),
    selectOption: record('selectOption', { text: 'selected option 1 "France" in e5 (combobox "Country").' }),
    setChecked: record('setChecked', { text: 'e6 (checkbox "Remember me") is already checked; nothing was clicked.' }),
    scroll: record('scroll', { text: 'scrolled down 648px: y=648 of 4000.' }),
    waitFor: record('waitFor', { text: '#done is visible.' }),
    ...overrides,
  }
  return { host, calls }
}

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: '/tmp/project', sessionId: 'session-1', readFiles: new Set<string>(), ...overrides }
}

function run(tool: Tool, input: unknown, ctx: ToolContext = context()) {
  return tool.execute(input, ctx)
}

test('get_state renders a tab table, and says so when there are none', async () => {
  const empty = createBrowserTool(stubHost({ listTabs: async () => [] }).host)
  const none = await run(empty, { operation: 'browser.get_state' })
  assert.equal(none.content, NO_TABS)

  const { host } = stubHost()
  const listed = await run(createBrowserTool(host), { operation: 'browser.get_state' })
  assert.match(listed.content, /^tabId\turl\ttitle\tflags\n/)
  assert.match(listed.content, /tab-1\thttps:\/\/x\.test\/\tX/)
})

test('each operation reaches its own host call', async () => {
  const { host, calls } = stubHost()
  const tool = createBrowserTool(host)

  await run(tool, { operation: 'browser.create_tab', url: 'https://x.test/' })
  await run(tool, { operation: 'tab.navigate', tabId: 'tab-1', url: 'https://y.test/' })
  await run(tool, { operation: 'browser.close_tab', tabId: 'tab-1' })
  await run(tool, { operation: 'tab.wait_for_load', tabId: 'tab-1' })
  await run(tool, { operation: 'page.text.snapshot', tabId: 'tab-1' })

  assert.deepEqual(calls.map((call) => call.method), [
    'createTab',
    'navigate',
    'closeTab',
    'waitForLoad',
    'text',
  ])
  assert.deepEqual(calls[3]?.args[2], { timeoutMs: 15_000 })
})

test('back, forward and reload reach the host as one history call', async () => {
  const { host, calls } = stubHost()
  const tool = createBrowserTool(host)

  const back = await run(tool, { operation: 'tab.go_back', tabId: 'tab-1' })
  await run(tool, { operation: 'tab.go_forward', tabId: 'tab-1' })
  await run(tool, { operation: 'tab.reload', tabId: 'tab-1' })

  assert.deepEqual(
    calls.map((call) => [call.method, call.args[1], call.args[2]]),
    [
      ['history', 'tab-1', 'back'],
      ['history', 'tab-1', 'forward'],
      ['history', 'tab-1', 'reload'],
    ],
  )
  assert.equal(back.ok, true)
  assert.match(back.content, /tab-1/)
  assert.equal(tool.isConcurrencySafeInput?.({ operation: 'tab.reload', tabId: 'tab-1' }), false)

  const missing = validateBrowserInput({ operation: 'tab.go_back' })
  assert.equal(missing.ok, false)
  assert.match(missing.errors[0]?.message ?? '', /tab\.go_back requires "tabId"/)
})

test('a back with nowhere to go comes back as the host’s refusal', async () => {
  const refusal = Object.assign(new Error('This tab has no page to go back to.'), { code: 'INVALID_REQUEST' })
  const tool = createBrowserTool(stubHost({ history: async () => { throw refusal } }).host)
  const result = await run(tool, { operation: 'tab.go_back', tabId: 'tab-1' })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'invalid_input')
  assert.match(result.content, /no page to go back to/)
})

test('the input operations pass their own fields through, and carry the abort signal', async () => {
  const { host, calls } = stubHost()
  const tool = createBrowserTool(host)
  const controller = new AbortController()
  const ctx = context({ abortSignal: controller.signal })

  const clicked = await run(tool, { operation: 'page.click', tabId: 'tab-1', ref: 'e3', clickCount: 2 }, ctx)
  await run(tool, { operation: 'page.type', tabId: 'tab-1', selector: '#q', text: 'hello', submit: true }, ctx)
  await run(tool, { operation: 'page.scroll', tabId: 'tab-1', direction: 'bottom' }, ctx)
  await run(tool, { operation: 'page.wait_for', tabId: 'tab-1', text: 'Done' }, ctx)

  assert.deepEqual(calls.map((call) => call.method), ['click', 'type', 'scroll', 'waitFor'])
  assert.deepEqual(calls[0]?.args[2], { ref: 'e3', clickCount: 2, signal: controller.signal })
  assert.deepEqual(calls[1]?.args[2], { selector: '#q', text: 'hello', submit: true, signal: controller.signal })
  assert.deepEqual(calls[2]?.args[2], { direction: 'bottom', signal: controller.signal })
  // The wait's own default, not `tab.wait_for_load`'s: a widget appearing is a
  // shorter question than a document arriving.
  assert.deepEqual(calls[3]?.args[2], { text: 'Done', timeoutMs: 10_000, signal: controller.signal })
  assert.equal(clicked.content, 'clicked e3 (button "Sign in") at (120, 240).')
})

test('press_key passes its chord through, and takes a single key or a snake-cased alias', async () => {
  const { host, calls } = stubHost()
  const tool = createBrowserTool(host)

  const pressed = await run(tool, { operation: 'page.press_key', tabId: 'tab-1', keys: ['Escape'] })
  await run(tool, { operation: 'page.press_key', tabId: 'tab-1', ref: 'e4', keys: ['Control', 'a'] })
  assert.equal(pressed.ok, true)
  assert.deepEqual(calls.map((call) => call.args[2]), [{ keys: ['Escape'] }, { ref: 'e4', keys: ['Control', 'a'] }])

  assert.deepEqual(normalizeToolInput('Browser', { operation: 'page.press_key', tab_id: 't', key: 'Enter' }), {
    operation: 'page.press_key',
    tabId: 't',
    keys: ['Enter'],
  })
  assert.equal(validateBrowserInput({ operation: 'page.press_key', tabId: 't', keys: [] }).ok, false)
  assert.equal(validateBrowserInput({ operation: 'page.press_key', tabId: 't' }).ok, false)
})

test('operation names from other browser tools map onto the tab history operations', () => {
  for (const [alias, operation] of [
    ['back', 'tab.go_back'],
    ['go_back', 'tab.go_back'],
    ['forward', 'tab.go_forward'],
    ['refresh', 'tab.reload'],
    ['reload', 'tab.reload'],
  ]) {
    assert.deepEqual(normalizeToolInput('Browser', { action: alias, tab_id: 't' }), { operation, tabId: 't' }, alias)
  }
  // A real operation name is left as it is.
  const canonical = { operation: 'tab.go_back', tabId: 't' }
  assert.equal(normalizeToolInput('Browser', canonical), canonical)
})

test('select_option takes exactly one pick, and set_checked passes its state through', async () => {
  const { host, calls } = stubHost()
  const tool = createBrowserTool(host)

  const none = await run(tool, { operation: 'page.select_option', tabId: 'tab-1', ref: 'e5' })
  assert.equal(none.ok, false)
  assert.match(none.content, /exactly one of "value", "label" or "index"; this call had none/)
  const two = await run(tool, { operation: 'page.select_option', tabId: 'tab-1', ref: 'e5', value: 'fr', index: 1 })
  assert.match(two.content, /had "value" and "index"/)
  const noTarget = await run(tool, { operation: 'page.set_checked', tabId: 'tab-1', checked: true })
  assert.match(noTarget.content, /page\.set_checked needs an element/)
  assert.deepEqual(calls, [])

  await run(tool, { operation: 'page.select_option', tabId: 'tab-1', ref: 'e5', value: '' })
  await run(tool, { operation: 'page.set_checked', tabId: 'tab-1', selector: '#tos', checked: false })
  assert.deepEqual((calls as Call[]).map((call) => [call.method, call.args[2]]), [
    ['selectOption', { ref: 'e5', value: '' }],
    ['setChecked', { selector: '#tos', checked: false }],
  ])
  assert.deepEqual(normalizeToolInput('Browser', { operation: 'page.set_checked', checked: 'true', index: '2' }), {
    operation: 'page.set_checked',
    checked: true,
    index: 2,
  })
})

test('an action with no element, and a wait with no condition, are refused before the host', async () => {
  const { host, calls } = stubHost()
  const tool = createBrowserTool(host)

  const noTarget = await run(tool, { operation: 'page.click', tabId: 'tab-1' })
  assert.equal(noTarget.ok, false)
  assert.equal(noTarget.errorCode, 'invalid_input')
  assert.match(noTarget.content, /page\.click needs an element/)
  assert.match(noTarget.content, /page\.elements\.snapshot/)

  const noCondition = await run(tool, { operation: 'page.wait_for', tabId: 'tab-1' })
  assert.equal(noCondition.ok, false)
  assert.match(noCondition.content, /page\.wait_for needs something to wait for/)

  assert.deepEqual(calls, [], 'a call the model can fix must not reach the browser')
  assert.equal(validateBrowserInput({ operation: 'page.click', tabId: 't', selector: '#a' }).ok, true)
  assert.equal(validateBrowserInput({ operation: 'page.wait_for', tabId: 't', selector: '#a' }).ok, true)
  assert.equal(validateBrowserInput({ operation: 'page.wait_for', tabId: 't', url: 'https://a.test/' }).ok, true)
  assert.equal(
    validateBrowserInput({ operation: 'page.wait_for', tabId: 't', url: 'https://a.test/', urlMatch: 'glob' }).ok,
    false,
  )
})

test('a cursor reads the snapshot already taken instead of scanning again', async () => {
  const { host, calls } = stubHost()
  const tool = createBrowserTool(host)

  await run(tool, { operation: 'page.elements.snapshot', tabId: 'tab-1', role: 'button' })
  await run(tool, { operation: 'page.elements.snapshot', tabId: 'tab-1', cursor: 'abc:20' })

  assert.deepEqual(calls.map((call) => call.method), ['elements', 'readSnapshot'])
  // Absent options must not cross as `undefined` keys: the projection treats a
  // present key as a choice.
  assert.deepEqual(calls[0]?.args[2], { role: 'button' })
})

test('a rejection names the operation, the field, and where the value comes from', () => {
  const missing = validateBrowserInput({ operation: 'tab.navigate', url: 'https://x.test/' })
  assert.equal(missing.ok, false)
  const message = missing.errors[0]?.message ?? ''
  assert.match(message, /tab\.navigate requires "tabId"/)
  assert.match(message, /browser\.get_state or browser\.create_tab/)

  const targetless = validateBrowserInput({ operation: 'page.click', tabId: 'tab-1' })
  assert.equal(targetless.ok, false)
  assert.match(targetless.errors[0]?.message ?? '', /page\.click needs an element/)

  const unknown = validateBrowserInput({ operation: 'page.dance', tabId: 'tab-1' })
  assert.equal(unknown.ok, false)
  assert.match(unknown.errors[0]?.message ?? '', /Unknown Browser operation "page\.dance"/)
  for (const operation of BROWSER_OPERATIONS) {
    assert.ok((unknown.errors[0]?.message ?? '').includes(operation), `${operation} is not offered`)
  }

  const extra = validateBrowserInput({ operation: 'browser.get_state', tabId: 'tab-1' })
  assert.equal(extra.ok, false)
  assert.match(extra.errors[0]?.message ?? '', /browser\.get_state does not take "tabId"/)

  assert.equal(validateBrowserInput({ operation: 'browser.get_state' }).ok, true)
})

test('the flat API schema covers every branch and requires only the discriminator', () => {
  assert.deepEqual(browserApiInputSchema.required, ['operation'])
  const published = new Set(Object.keys(browserApiInputSchema.properties ?? {}))
  for (const operation of BROWSER_OPERATIONS) {
    const fields = fieldsFor(operation)
    assert.ok(fields, `${operation} is missing from the union`)
    for (const name of [...fields.required, ...fields.optional]) {
      assert.ok(published.has(name), `${operation}.${name} is not in the published schema`)
    }
  }
  assert.deepEqual(browserApiInputSchema.properties?.operation?.enum, [...BROWSER_OPERATIONS])
  assert.deepEqual(browserApiInputSchema.properties?.state?.enum, ['visible', 'hidden'])
  assert.match(browserApiInputSchema.properties?.text?.description ?? '', /page\.type: The text to type/)
  // The union is what actually decides, so it must still refuse a mixed call.
  assert.equal(browserInputSchema.safeParse({ operation: 'browser.get_state', url: 'x' }).success, false)
})

test('a cursor read refuses the filters it would silently ignore', () => {
  const paged = validateBrowserInput({ operation: 'page.elements.snapshot', tabId: 't', cursor: 'c1', maxChars: 4096 })
  assert.equal(paged.ok, true)
  const filtered = validateBrowserInput({ operation: 'page.elements.snapshot', tabId: 't', cursor: 'c1', role: 'button', scope: 'main' })
  assert.equal(filtered.ok, false)
  assert.match(filtered.errors[0]?.message ?? '', /"role", "scope" would be ignored.*drop "cursor"/)
  assert.equal(validateBrowserInput({ operation: 'page.text.snapshot', tabId: 't', cursor: 'c1', limit: 5 }).ok, false)
})

test('only the read-only operations are concurrency safe', () => {
  const tool = createBrowserTool(stubHost().host)
  assert.equal(tool.isConcurrencySafeInput?.({ operation: 'page.text.snapshot', tabId: 't' }), true)
  assert.equal(tool.isConcurrencySafeInput?.({ operation: 'tab.navigate', tabId: 't', url: 'u' }), false)
  assert.equal(tool.isConcurrencySafeInput?.({}), false)
})

test('a host failure keeps its code and says whether waiting would help', async () => {
  const { host } = stubHost({
    elements: async () => {
      throw Object.assign(new Error('The page has not finished loading.'), {
        code: 'PAGE_NOT_READY',
        retryable: true,
      })
    },
  })
  const result = await run(createBrowserTool(host), { operation: 'page.elements.snapshot', tabId: 'tab-1' })
  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'precondition_failed')
  assert.match(result.content, /retryable/)
  assert.deepEqual(result.errorDetails, { code: 'PAGE_NOT_READY', retryable: true })
})

test('a screenshot never becomes text, whether it succeeds or not', async () => {
  const { host, calls } = stubHost()
  const tool = createBrowserTool(host)

  const textOnly = await run(tool, { operation: 'page.screenshot', tabId: 'tab-1' })
  assert.equal(textOnly.ok, false)
  assert.equal(textOnly.errorCode, 'precondition_failed')
  assert.equal(textOnly.images, undefined)
  assert.equal(calls.length, 0, 'a text-only model must not make the browser capture anything')
  assertNoImageBytes(textOnly)

  const ref = makeImageAttachmentRef({ name: 'screenshot-x.test-abcd1234.png' })
  const store: ImageAttachmentImporter = {
    importImage: async () => ({
      ok: true,
      value: {
        ref,
        metadata: {
          originalWidth: 800,
          originalHeight: 600,
          sentWidth: ref.width,
          sentHeight: ref.height,
          localPath: '/tmp/shot.png',
        },
        animated: false,
      },
    }),
  }
  const ok = await run(tool, { operation: 'page.screenshot', tabId: 'tab-1' }, context({
    imageAttachments: store,
    getSupportsImageInput: () => true,
  }))
  assert.equal(ok.ok, true, ok.content)
  assert.deepEqual(ok.images, [ref])
  assert.match(ok.content, /attached as pixels/)
  assertNoImageBytes(ok)
})
