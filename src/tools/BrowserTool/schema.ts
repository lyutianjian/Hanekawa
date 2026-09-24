/**
 * The `Browser` input, twice.
 *
 * `inputSchema` is a strict discriminated union — the thing that actually
 * decides whether a call runs, and the thing that knows `tabId` is required for
 * a navigation but meaningless for `browser.get_state`.
 *
 * `apiInputSchema` is the flat JSON Schema the model is shown. A union cannot
 * survive that trip (the API's schema dialect has no discriminator), so the
 * properties are unioned and `required` keeps only what every branch shares,
 * which is `operation` alone. The cost is real: the published schema no longer
 * says which fields a given operation needs. `validate.ts` pays it back by
 * turning a failure into an instruction the next turn can act on.
 */

import { z } from 'zod/v3'
import type { JsonSchema } from '../../harness/toolValidation.js'
import {
  BROWSER_OPERATIONS,
  PRESS_KEYS_MAX,
  TYPE_TEXT_MAX,
  WAIT_FOR_DEFAULT_MS,
  WAIT_FOR_LOAD_DEFAULT_MS,
  WAIT_FOR_LOAD_MAX_MS,
  WAIT_FOR_MAX_MS,
} from './constants.js'

const tabId = z.string().min(1).describe('Tab handle from browser.get_state or browser.create_tab.')
const url = z.string().min(1).describe('Absolute http(s) URL, including the scheme.')
const cursor = z
  .string()
  .min(1)
  .describe('Cursor from a previous snapshot’s "# more:" line. Reads the next page without re-scanning.')
const maxChars = z.number().int().describe('Character budget for this page of output (2048–24000).')
const limit = z.number().int().describe('Rows per page (elements default 100; text defaults to as many as maxChars allows). The rest stay reachable through the cursor.')
const scope = z.string().min(1).describe('CSS selector to restrict the scan to one subtree.')
const visibleOnly = z.boolean().describe('Skip elements that are not rendered. Default true.')

const elementsFields = {
  tabId,
  scope: scope.optional(),
  role: z.string().min(1).optional().describe('Keep only this ARIA role, e.g. "button" or "textbox".'),
  text: z.string().min(1).optional().describe('Keep only rows whose name or text contains this (case-insensitive).'),
  interactiveOnly: z.boolean().optional().describe('Keep only operable elements. Default true.'),
  visibleOnly: visibleOnly.optional(),
  limit: limit.optional(),
  maxChars: maxChars.optional(),
  cursor: cursor.optional(),
}

const textFields = {
  tabId,
  scope: scope.optional(),
  visibleOnly: visibleOnly.optional(),
  limit: limit.optional(),
  maxChars: maxChars.optional(),
  cursor: cursor.optional(),
}

/** What an action points at. Exactly one is needed; `validate.ts` says which. */
const target = {
  ref: z.string().min(1).optional().describe('A ref from the latest page.elements.snapshot, e.g. "e3".'),
  selector: z.string().min(1).optional().describe('A CSS selector, when no snapshot ref addresses the element.'),
}

export const browserInputSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('browser.get_state') }).strict(),
  z.object({ operation: z.literal('browser.create_tab'), url: url.optional() }).strict(),
  z.object({ operation: z.literal('browser.close_tab'), tabId }).strict(),
  z.object({ operation: z.literal('tab.navigate'), tabId, url }).strict(),
  z.object({ operation: z.literal('tab.go_back'), tabId }).strict(),
  z.object({ operation: z.literal('tab.go_forward'), tabId }).strict(),
  z.object({ operation: z.literal('tab.reload'), tabId }).strict(),
  z
    .object({
      operation: z.literal('tab.wait_for_load'),
      tabId,
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(WAIT_FOR_LOAD_MAX_MS)
        .optional()
        .describe(`How long to wait (default ${WAIT_FOR_LOAD_DEFAULT_MS}, max ${WAIT_FOR_LOAD_MAX_MS}).`),
    })
    .strict(),
  z.object({ operation: z.literal('page.elements.snapshot'), ...elementsFields }).strict(),
  z.object({ operation: z.literal('page.text.snapshot'), ...textFields }).strict(),
  z.object({ operation: z.literal('page.screenshot'), tabId }).strict(),
  z
    .object({
      operation: z.literal('page.click'),
      tabId,
      ...target,
      button: z.enum(['left', 'right', 'middle']).optional().describe('Default left.'),
      clickCount: z.number().int().min(1).max(3).optional().describe('2 for a double click.'),
    })
    .strict(),
  z
    .object({
      operation: z.literal('page.type'),
      tabId,
      ...target,
      text: z.string().max(TYPE_TEXT_MAX).describe('The text to type. Pass "" with clear to empty a field.'),
      clear: z.boolean().optional().describe('Select the field’s contents and delete them first.'),
      submit: z.boolean().optional().describe('Press Enter afterwards.'),
    })
    .strict(),
  z
    .object({
      operation: z.literal('page.press_key'),
      tabId,
      ...target,
      keys: z
        .array(z.string().min(1))
        .min(1)
        .max(PRESS_KEYS_MAX)
        .describe('One chord, pressed in order and released in reverse: ["Enter"], ["Control", "a"], ["Shift", "Tab"].'),
    })
    .strict(),
  z
    .object({
      operation: z.literal('page.select_option'),
      tabId,
      ...target,
      value: z.string().optional().describe('Pick the option whose value attribute is exactly this.'),
      label: z.string().min(1).optional().describe('Pick the option whose visible label is this (surrounding spaces ignored).'),
      index: z.number().int().min(0).optional().describe('Pick the option at this 0-based position.'),
    })
    .strict(),
  z
    .object({
      operation: z.literal('page.set_checked'),
      tabId,
      ...target,
      checked: z.boolean().describe('true to check it, false to uncheck it.'),
    })
    .strict(),
  z
    .object({
      operation: z.literal('page.scroll'),
      tabId,
      ...target,
      direction: z
        .enum(['up', 'down', 'top', 'bottom'])
        .optional()
        .describe('Default down. Ignored when a ref or selector is given.'),
      amount: z.number().int().positive().optional().describe('Pixels for up/down. Default most of a viewport.'),
    })
    .strict(),
  z
    .object({
      operation: z.literal('page.wait_for'),
      tabId,
      selector: z.string().min(1).optional().describe('Wait for this CSS selector.'),
      text: z.string().min(1).optional().describe('Wait for this text. With a selector, waits for it inside that.'),
      state: z.enum(['visible', 'hidden']).optional().describe('Default visible. Applies to selector and text, not url.'),
      url: z.string().min(1).optional().describe('Wait until the tab’s committed URL matches this.'),
      urlMatch: z
        .enum(['exact', 'prefix', 'contains'])
        .optional()
        .describe('How url is compared. Default prefix.'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(WAIT_FOR_MAX_MS)
        .optional()
        .describe(`How long to wait (default ${WAIT_FOR_DEFAULT_MS}, max ${WAIT_FOR_MAX_MS}).`),
    })
    .strict(),
])

export type BrowserInput = z.infer<typeof browserInputSchema>

export const browserApiInputSchema: JsonSchema = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      enum: [...BROWSER_OPERATIONS],
      description: 'Which browser action to run. See the tool description for the fields each one takes.',
    },
    tabId: { type: 'string', description: 'Tab handle. Required by every operation except get_state and create_tab.' },
    url: {
      type: 'string',
      description:
        'Absolute http(s) URL. Required by tab.navigate, optional on create_tab. page.wait_for: wait until the tab’s committed URL matches this (see urlMatch).',
    },
    urlMatch: {
      type: 'string',
      enum: ['exact', 'prefix', 'contains'],
      description: 'page.wait_for only: how url is compared. Default prefix.',
    },
    timeoutMs: {
      type: 'number',
      description: `tab.wait_for_load (default ${WAIT_FOR_LOAD_DEFAULT_MS}, max ${WAIT_FOR_LOAD_MAX_MS}) and page.wait_for (default ${WAIT_FOR_DEFAULT_MS}, max ${WAIT_FOR_MAX_MS}).`,
    },
    scope: { type: 'string', description: 'Snapshots only: CSS selector to restrict the scan to one subtree.' },
    role: { type: 'string', description: 'page.elements.snapshot only: keep one ARIA role.' },
    text: {
      type: 'string',
      description:
        'page.elements.snapshot: substring filter over name and text. page.type: the text to type. page.wait_for: the text to wait for.',
    },
    ref: {
      type: 'string',
      description: 'page.click/type/press_key/select_option/set_checked/scroll: a ref from the latest page.elements.snapshot.',
    },
    selector: {
      type: 'string',
      description:
        'page.click/type/press_key/select_option/set_checked/scroll: a CSS selector for the element. page.wait_for: the selector to wait for.',
    },
    keys: {
      type: 'array',
      items: { type: 'string' },
      description: `page.press_key only: 1–${PRESS_KEYS_MAX} key names forming one chord, e.g. ["Escape"] or ["ControlOrMeta", "a"].`,
    },
    value: {
      type: 'string',
      description: 'page.select_option only: the option\'s value attribute. (page.type takes "text", not "value".)',
    },
    label: { type: 'string', description: 'page.select_option only: the option\'s visible label.' },
    index: { type: 'number', description: 'page.select_option only: the option\'s 0-based position.' },
    checked: { type: 'boolean', description: 'page.set_checked only: the state to leave the control in.' },
    button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'page.click only. Default left.' },
    clickCount: { type: 'number', description: 'page.click only: 2 for a double click.' },
    clear: { type: 'boolean', description: 'page.type only: empty the field before typing.' },
    submit: { type: 'boolean', description: 'page.type only: press Enter afterwards.' },
    direction: {
      type: 'string',
      enum: ['up', 'down', 'top', 'bottom'],
      description: 'page.scroll only. Default down.',
    },
    amount: { type: 'number', description: 'page.scroll only: pixels for up/down.' },
    state: { type: 'string', enum: ['visible', 'hidden'], description: 'page.wait_for only. Default visible.' },
    interactiveOnly: { type: 'boolean', description: 'page.elements.snapshot only. Default true.' },
    visibleOnly: { type: 'boolean', description: 'Snapshots only. Default true.' },
    limit: { type: 'number', description: 'Snapshots only: rows per page, the rest reachable through the cursor. Elements default 100.' },
    maxChars: { type: 'number', description: 'Snapshots only: output budget, 2048–24000.' },
    cursor: { type: 'string', description: 'Snapshots only: page through the previous snapshot instead of rescanning.' },
  },
  required: ['operation'],
  additionalProperties: false,
}
