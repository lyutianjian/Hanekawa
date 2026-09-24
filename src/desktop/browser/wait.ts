/**
 * Waiting for the page to say something.
 *
 * `tab.wait_for_load` answers "is the navigation over"; this answers "is the
 * thing I need there yet", which is the question a single-page app actually
 * makes you ask — the load finished long before the list rendered.
 *
 * Electron-free, like `input.ts`, and for the same reason: everything
 * interesting here is the loop's behaviour at the edges, which needs a stub
 * evaluator and an injectable clock, not a window.
 *
 * Two decisions worth keeping:
 *
 * - **A timeout reports what it saw.** The last observation travels with the
 *   error, so "the button never appeared" can be told apart from "the page was
 *   still showing a spinner" without a second round trip. Before the first
 *   observation lands it says so in as many words.
 * - **A navigation mid-wait is evidence, not a failure.** The condition is about
 *   the document the tab ends up on; a document swap is noted in the answer and
 *   the wait continues, because refusing would leave the model with nothing.
 */

import type { ConditionOptions, ConditionResult } from './inject/bundle.js'
import { conditionScript, unwrap } from './inject/bundle.js'
import { BrowserHostError } from './errors.js'
import {
  FIELD_MAX_TEXT,
  SCAN_BUDGET_MS,
  SCAN_MAX_NODES,
  SENSITIVE_AUTOCOMPLETE,
  WAIT_POLL_INTERVAL_MS,
} from './limits.js'

export interface WaitCondition {
  selector?: string
  text?: string
  state?: 'visible' | 'hidden'
}

export interface WaitDeps {
  evaluate: (script: string) => Promise<unknown>
  /** The tab's navigation generation, or `undefined` once its page is gone. */
  generation: () => number | undefined
  check: () => void
  timeoutMs: number
  signal?: AbortSignal
  /** Monotonic. A clock adjustment must not end a wait early or hang it. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface WaitOutcome {
  text: string
}

const NOT_OBSERVED = 'Not observed yet.'

export async function waitForCondition(deps: WaitDeps, condition: WaitCondition): Promise<WaitOutcome> {
  if ((condition.selector ?? '') === '' && (condition.text ?? '') === '') {
    throw new BrowserHostError('INVALID_REQUEST', 'page.wait_for needs a "selector", a "text", or both.')
  }
  const options: ConditionOptions = {
    state: condition.state ?? 'visible',
    maxNodes: SCAN_MAX_NODES,
    budgetMs: SCAN_BUDGET_MS,
    segmentMax: FIELD_MAX_TEXT,
    sensitiveWords: SENSITIVE_AUTOCOMPLETE,
  }
  if (condition.selector !== undefined) options.selector = condition.selector
  if (condition.text !== undefined) options.text = condition.text

  const now = deps.now ?? (() => performance.now())
  const sleep = deps.sleep ?? defaultSleep
  const script = conditionScript(options)
  const startGeneration = deps.generation()
  const deadline = now() + deps.timeoutMs
  let lastObserved = NOT_OBSERVED
  let documentChanged = false

  for (;;) {
    deps.check()
    if (deps.signal?.aborted === true) {
      throw new BrowserHostError('OPERATION_ABORTED', 'The wait was cancelled.')
    }

    let result: ConditionResult | undefined
    try {
      result = unwrap<ConditionResult>(await deps.evaluate(script))
    } catch (error) {
      // `retryable` is the whole distinction: a page that is navigating cannot
      // answer yet and will, while a bad selector or a closed tab never will.
      if (!isRetryable(error)) throw error
      lastObserved = error instanceof Error ? error.message : String(error)
    }
    deps.check()
    if (deps.generation() !== startGeneration) documentChanged = true

    if (result !== undefined) {
      lastObserved = result.observed
      if (result.matched) {
        const note = documentChanged ? ' (the document changed while waiting)' : ''
        return { text: `${result.observed}${note}. url=${result.url} title=${result.title}` }
      }
    }

    if (now() >= deadline) {
      throw Object.assign(
        new BrowserHostError(
          'WAIT_TIMEOUT',
          `The condition was not met within ${deps.timeoutMs}ms. Last seen: ${lastObserved}`,
        ),
        { lastObserved },
      )
    }
    await sleep(Math.min(WAIT_POLL_INTERVAL_MS, deps.timeoutMs))
  }
}

function isRetryable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { retryable?: unknown }).retryable === true
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
