/**
 * The agent's half of the browser: one tool, twelve operations, no Electron.
 *
 * Everything that touches a real tab is behind {@link BrowserHost}, which is a
 * type and nothing else — the TUI never constructs one, so the tool simply does
 * not exist there (`main.ts` injects it through `extraTools`). What is left in
 * this file is dispatch, error translation, and the image hand-off.
 *
 * Failures from the host carry a `code`, read structurally rather than by
 * importing the error class from the desktop half. The mapping to
 * `ToolErrorCode` is deliberately coarse: the model acts on the message, and
 * the code only has to tell the runner whether this was the model's fault.
 */

import type { Tool, ToolContext, ToolResult } from '../../harness/types.js'
import type {
  BrowserActionResult,
  BrowserCaller,
  BrowserHost,
  BrowserSnapshot,
  BrowserTabState,
} from '../../runtime/protocol/browserHost.js'
import { formatImageCaption } from '../imageFile.js'
import {
  BROWSER_TOOL_NAME,
  READ_ONLY_OPERATIONS,
  WAIT_FOR_DEFAULT_MS,
  WAIT_FOR_LOAD_DEFAULT_MS,
} from './constants.js'
import { describeTab, hostOf, renderTabs, summarizeTabs } from './encode.js'
import { DESCRIPTION } from './prompt.js'
import { browserApiInputSchema, browserInputSchema, type BrowserInput } from './schema.js'
import { validateBrowserInput } from './validate.js'

/** A `BrowserHostError` as seen from here: a code, a message, maybe retryable. */
interface HostFailure {
  code: string
  message: string
  retryable: boolean
}

function hostFailure(error: unknown): HostFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return undefined
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: (error as { retryable?: unknown }).retryable === true,
  }
}

function errorCodeFor(failure: HostFailure): ToolResult['errorCode'] {
  switch (failure.code) {
    case 'TAB_NOT_FOUND':
    case 'SNAPSHOT_EXPIRED':
      return 'not_found'
    case 'INVALID_REQUEST':
    case 'OUTPUT_LIMIT':
      return 'invalid_input'
    case 'PAGE_NOT_READY':
    case 'BROWSER_UNAVAILABLE':
    case 'BROWSER_USER_TAKEOVER':
      return 'precondition_failed'
    case 'WAIT_TIMEOUT':
      return 'timeout'
    case 'OPERATION_ABORTED':
      return 'aborted'
    default:
      return 'execution_failed'
  }
}

function snapshotResult(operation: string, snapshot: BrowserSnapshot): ToolResult {
  const more = snapshot.cursor === undefined ? '' : ' (more available)'
  return {
    ok: true,
    content: snapshot.text,
    metadata: {
      display: {
        summary: `${operation === 'page.text.snapshot' ? 'Read' : 'Scanned'} ${snapshot.total}${more}`,
      },
    },
  }
}

function tabResult(tab: BrowserTabState, summary: string): ToolResult {
  return { ok: true, content: describeTab(tab), metadata: { display: { summary } } }
}

/** An action's evidence line, verbatim. It never carries what was typed. */
function actionResult(result: BrowserActionResult, summary: string): ToolResult {
  return { ok: true, content: result.text, metadata: { display: { summary } } }
}

export function createBrowserTool(host: BrowserHost): Tool {
  return {
    name: BROWSER_TOOL_NAME,
    description: DESCRIPTION,
    searchHint: 'browse web pages click read rendered page logged in',
    inputSchema: browserInputSchema,
    apiInputSchema: browserApiInputSchema,
    validateInput: validateBrowserInput,
    // Not `safe`, for `WebFetch`'s reason and one more: a navigation carries the
    // user's real cookies to whatever host the model picked.
    riskLevel: 'confirm',
    shouldDefer: true,
    maxResultSizeChars: 32_000,
    isConcurrencySafeInput(input) {
      const operation = (input as { operation?: unknown })?.operation
      return typeof operation === 'string' && READ_ONLY_OPERATIONS.has(operation)
    },
    userFacingName: () => 'Browser',
    getToolUseSummary(input) {
      const parsed = asInput(input)
      if (!parsed) return null
      if (parsed.operation === 'tab.navigate' || (parsed.operation === 'browser.create_tab' && parsed.url)) {
        return hostOf(parsed.url as string)
      }
      return parsed.operation
    },
    getActivityDescription(input) {
      const parsed = asInput(input)
      if (!parsed) return 'Using the browser'
      switch (parsed.operation) {
        case 'tab.navigate':
          return `Opening ${hostOf(parsed.url)}`
        case 'browser.create_tab':
          return parsed.url === undefined ? 'Opening a browser tab' : `Opening ${hostOf(parsed.url)}`
        case 'page.screenshot':
          return 'Taking a screenshot'
        case 'tab.wait_for_load':
          return 'Waiting for the page to load'
        case 'page.click':
          return 'Clicking the page'
        case 'page.type':
          return 'Typing into the page'
        case 'page.scroll':
          return 'Scrolling the page'
        case 'page.wait_for':
          return 'Waiting for the page'
        default:
          return 'Reading the page'
      }
    },
    shouldDisplayResult: () => true,
    async execute(rawInput, context) {
      // Validation first, and not only as a schema check: the cross-field rules
      // ("a ref or a selector") live there, and `execute` is reachable without
      // the runner's own `validateInput` pass.
      const validation = validateBrowserInput(rawInput)
      if (!validation.ok) {
        return {
          ok: false,
          content: validation.errors.map((error) => error.message).join('\n'),
          errorCode: 'invalid_input',
        }
      }
      const parsed = browserInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return {
          ok: false,
          content: parsed.error.issues.map((issue) => issue.message).join('\n'),
          errorCode: 'invalid_input',
        }
      }

      try {
        return await run(host, parsed.data, context)
      } catch (error) {
        const failure = hostFailure(error)
        if (!failure) {
          return {
            ok: false,
            content: `Browser operation failed: ${error instanceof Error ? error.message : String(error)}`,
            errorCode: 'execution_failed',
          }
        }
        return {
          ok: false,
          content: failure.retryable ? `${failure.message} (retryable)` : failure.message,
          errorCode: errorCodeFor(failure),
          errorDetails: { code: failure.code, retryable: failure.retryable },
        }
      }
    },
  }
}

function asInput(input: unknown): BrowserInput | undefined {
  const parsed = browserInputSchema.safeParse(input)
  return parsed.success ? parsed.data : undefined
}

async function run(host: BrowserHost, input: BrowserInput, context: ToolContext): Promise<ToolResult> {
  // Session *and* turn: the host blocks a session that the user took the browser
  // from, and only a new turn lifts that, so the turn has to travel with the call.
  const session: BrowserCaller = {
    sessionId: context.sessionId,
    ...(context.currentTurnId === undefined ? {} : { turnId: context.currentTurnId }),
  }
  switch (input.operation) {
    case 'browser.get_state': {
      const tabs = await host.listTabs(session)
      return { ok: true, content: renderTabs(tabs), metadata: { display: { summary: summarizeTabs(tabs) } } }
    }
    case 'browser.create_tab': {
      const tab = await host.createTab(session, input.url)
      return tabResult(tab, input.url === undefined ? 'Opened a tab' : `Opened ${hostOf(input.url)}`)
    }
    case 'browser.close_tab': {
      await host.closeTab(session, input.tabId)
      return { ok: true, content: `Closed tab ${input.tabId}.`, metadata: { display: { summary: 'Closed the tab' } } }
    }
    case 'tab.navigate': {
      const tab = await host.navigate(session, input.tabId, input.url)
      return tabResult(tab, `Navigating to ${hostOf(input.url)}`)
    }
    case 'tab.wait_for_load': {
      const options: { timeoutMs: number; signal?: AbortSignal } = {
        timeoutMs: input.timeoutMs ?? WAIT_FOR_LOAD_DEFAULT_MS,
      }
      if (context.abortSignal) options.signal = context.abortSignal
      const tab = await host.waitForLoad(session, input.tabId, options)
      return tabResult(tab, tab.error === undefined ? 'Page loaded' : 'Load failed')
    }
    case 'page.elements.snapshot': {
      const snapshot = input.cursor === undefined
        ? await host.elements(session, input.tabId, stripUndefined({
          scope: input.scope,
          role: input.role,
          text: input.text,
          interactiveOnly: input.interactiveOnly,
          visibleOnly: input.visibleOnly,
          limit: input.limit,
          maxChars: input.maxChars,
        }))
        : await host.readSnapshot(session, input.tabId, input.cursor, input.maxChars)
      return snapshotResult(input.operation, snapshot)
    }
    case 'page.text.snapshot': {
      const snapshot = input.cursor === undefined
        ? await host.text(session, input.tabId, stripUndefined({
          scope: input.scope,
          visibleOnly: input.visibleOnly,
          limit: input.limit,
          maxChars: input.maxChars,
        }))
        : await host.readSnapshot(session, input.tabId, input.cursor, input.maxChars)
      return snapshotResult(input.operation, snapshot)
    }
    case 'page.screenshot':
      return screenshot(host, session, input.tabId, context)
    case 'page.click': {
      const result = await host.click(session, input.tabId, action({
        ref: input.ref,
        selector: input.selector,
        button: input.button,
        clickCount: input.clickCount,
      }, context))
      return actionResult(result, 'Clicked')
    }
    case 'page.type': {
      const result = await host.type(session, input.tabId, action({
        ref: input.ref,
        selector: input.selector,
        text: input.text,
        clear: input.clear,
        submit: input.submit,
      }, context))
      return actionResult(result, 'Typed')
    }
    case 'page.scroll': {
      const result = await host.scroll(session, input.tabId, action({
        ref: input.ref,
        selector: input.selector,
        direction: input.direction,
        amount: input.amount,
      }, context))
      return actionResult(result, 'Scrolled')
    }
    case 'page.wait_for': {
      const result = await host.waitFor(session, input.tabId, action({
        selector: input.selector,
        text: input.text,
        state: input.state,
        timeoutMs: input.timeoutMs ?? WAIT_FOR_DEFAULT_MS,
      }, context))
      return actionResult(result, 'Waited for the page')
    }
  }
}

/** A request with its absent fields dropped and the turn's abort signal added. */
function action<T extends object>(value: T, context: ToolContext): T & { signal?: AbortSignal } {
  const request = stripUndefined(value) as T & { signal?: AbortSignal }
  if (context.abortSignal) request.signal = context.abortSignal
  return request
}

/**
 * The capability checks first, in `Read`'s order and for its reason: the most
 * useful error is the one that changes the model's strategy, and image bytes
 * never come back as text no matter what went wrong.
 */
async function screenshot(
  host: BrowserHost,
  caller: BrowserCaller,
  tabId: string,
  context: ToolContext,
): Promise<ToolResult> {
  if (context.getSupportsImageInput?.() !== true) {
    return {
      ok: false,
      content:
        'Cannot take a screenshot: the current model does not accept image input. Use page.text.snapshot or page.elements.snapshot instead, or switch to an image-capable model.',
      errorCode: 'precondition_failed',
      errorDetails: { reason: 'model-not-capable' },
    }
  }
  const store = context.imageAttachments
  if (!store) {
    return {
      ok: false,
      content: 'Cannot take a screenshot: no attachment store is available in this context.',
      errorCode: 'precondition_failed',
      errorDetails: { reason: 'attachment-store-unavailable' },
    }
  }

  const shot = await host.screenshot(caller, tabId)
  const imported = await store.importImage(context.sessionId, shot.bytes, shot.name)
  if (!imported.ok) {
    return {
      ok: false,
      content: `Cannot attach the screenshot: ${imported.message}`,
      errorCode: imported.reason === 'store-write-failed' ? 'execution_failed' : 'invalid_input',
      errorDetails: { reason: imported.reason },
    }
  }

  const { ref, metadata } = imported.value
  const caption = formatImageCaption(
    {
      name: ref.name,
      animated: false,
      orientedOriginalWidth: metadata.originalWidth,
      orientedOriginalHeight: metadata.originalHeight,
      width: ref.width,
      height: ref.height,
      scaleX: metadata.originalWidth / ref.width,
      scaleY: metadata.originalHeight / ref.height,
    },
    { index: 1, localPath: metadata.localPath },
  )

  return {
    ok: true,
    content: [
      `Screenshot of the visible area of tab ${tabId}.`,
      caption,
      'The picture is attached as pixels; no text was extracted from it.',
    ].join('\n'),
    images: [ref],
    metadata: { display: { summary: `Screenshot ${shot.width}x${shot.height}` } },
  }
}

/** Optional fields the host must see as absent, not as `undefined` keys. */
function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out as T
}

export { BROWSER_TOOL_NAME }
