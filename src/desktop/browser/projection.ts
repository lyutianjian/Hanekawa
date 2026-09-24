/**
 * A page, projected: scan → cache → encode → page.
 *
 * This is the assembly point, and it is deliberately Electron-free. It takes an
 * evaluator rather than a tab, so the whole pipeline — the options a request
 * turns into, the rows a scan turns into, the pages a cursor walks — is testable
 * against a stub that returns a canned scan result.
 *
 * The rendering is done once, at scan time, and the *lines* are what the cache
 * holds. Paging is then pure string arithmetic over an immutable reading of one
 * document: a second page can never be a second scan, because a second scan
 * would be a different page than the first half described.
 */

import { clampMaxChars, elementsHeader, paginateLines, renderElementRow, renderTextBlock, textHeader } from './encode.js'
import type { ElementScanOptions, ElementScanResult, TextScanOptions, TextScanResult } from './inject/bundle.js'
import { elementsScript, textScript, unwrap } from './inject/bundle.js'
import {
  DEFAULT_LIMIT,
  FIELD_MAX_NAME,
  FIELD_MAX_TEXT,
  INTERACTIVE_SELECTOR,
  MAX_CHARS_ELEMENTS,
  MAX_CHARS_TEXT,
  SCAN_BUDGET_MS,
  SCAN_MAX_NODES,
  SCAN_MAX_RESULTS,
  SENSITIVE_AUTOCOMPLETE,
} from './limits.js'
import { SnapshotCache, type SnapshotOwner } from './snapshotCache.js'
import { randomUUID } from 'node:crypto'

export type PageEvaluator = (script: string) => Promise<unknown>

export interface ElementsRequest {
  scope?: string
  role?: string
  text?: string
  interactiveOnly?: boolean
  visibleOnly?: boolean
  limit?: number
  maxChars?: number
}

export interface TextRequest {
  scope?: string
  visibleOnly?: boolean
  limit?: number
  maxChars?: number
}

export interface ProjectionPage {
  text: string
  snapshotId: string
  /** Present only while there is more to read. Feed it back verbatim. */
  cursor?: string
  /** A page budget cut the scan short. Paging cannot recover what it dropped. */
  scanTruncated: boolean
  total: number
}

export class BrowserProjection {
  constructor(private readonly cache = new SnapshotCache()) {}

  async elements(owner: SnapshotOwner, evaluate: PageEvaluator, request: ElementsRequest): Promise<ProjectionPage> {
    const options: ElementScanOptions = {
      snapshotId: randomUUID(),
      interactiveOnly: request.interactiveOnly ?? true,
      visibleOnly: request.visibleOnly ?? true,
      // `limit` is a page size, not a scan bound: a scan cut at it would claim
      // the page was not read to the end, and the rows past it could never be
      // paged to. Only the hard cap truncates.
      maxResults: SCAN_MAX_RESULTS,
      maxNodes: SCAN_MAX_NODES,
      budgetMs: SCAN_BUDGET_MS,
      nameMax: FIELD_MAX_NAME,
      textMax: FIELD_MAX_TEXT,
      sensitiveWords: SENSITIVE_AUTOCOMPLETE,
      interactiveSelector: INTERACTIVE_SELECTOR,
    }
    if (request.scope !== undefined) options.scope = request.scope
    if (request.role !== undefined) options.role = request.role.toLowerCase()
    if (request.text !== undefined) options.text = request.text

    const scan = unwrap<ElementScanResult>(await evaluate(elementsScript(options)))
    const head = { url: scan.url, title: scan.title, scanTruncated: scan.truncated }
    const lines = scan.rows.map(renderElementRow)
    const header = elementsHeader(head, lines.length)
    return this.store(owner, 'elements', header, lines, scan.truncated, request.maxChars, clampLimit(request.limit))
  }

  async text(owner: SnapshotOwner, evaluate: PageEvaluator, request: TextRequest): Promise<ProjectionPage> {
    const options: TextScanOptions = {
      visibleOnly: request.visibleOnly ?? true,
      maxResults: SCAN_MAX_RESULTS,
      maxNodes: SCAN_MAX_NODES,
      budgetMs: SCAN_BUDGET_MS,
      segmentMax: FIELD_MAX_TEXT,
      sensitiveWords: SENSITIVE_AUTOCOMPLETE,
    }
    if (request.scope !== undefined) options.scope = request.scope

    const scan = unwrap<TextScanResult>(await evaluate(textScript(options)))
    const head = { url: scan.url, title: scan.title, scanTruncated: scan.truncated }
    const lines = scan.blocks.map(renderTextBlock)
    const pageRows = clampLimit(request.limit, SCAN_MAX_RESULTS)
    return this.store(owner, 'text', textHeader(head, lines.length), lines, scan.truncated, request.maxChars, pageRows)
  }

  /**
   * The next page of a snapshot already taken. No round trip to the page, and no
   * way to reach a document other than the one the cursor was issued against —
   * the owner triple is re-checked here, not at issue time.
   */
  read(owner: SnapshotOwner, cursor: string, maxChars?: number): ProjectionPage {
    const { snapshotId, snapshot, offset } = this.cache.read(owner, cursor)
    const budget = clampMaxChars(maxChars, snapshot.kind === 'text' ? MAX_CHARS_TEXT : MAX_CHARS_ELEMENTS)
    const slice = paginateLines(
      snapshot.header,
      snapshot.lines,
      offset,
      budget,
      (next) => `${snapshotId}:${next}`,
      snapshot.pageRows,
    )
    return page(snapshotId, slice, snapshot.lines.length, false)
  }

  dropTab(tabId: string): void {
    this.cache.dropTab(tabId)
  }

  private store(
    owner: SnapshotOwner,
    kind: 'elements' | 'text',
    header: string,
    lines: string[],
    scanTruncated: boolean,
    maxChars: number | undefined,
    pageRows: number,
  ): ProjectionPage {
    const snapshotId = this.cache.put(owner, { kind, header, lines, pageRows })
    const budget = clampMaxChars(maxChars, kind === 'text' ? MAX_CHARS_TEXT : MAX_CHARS_ELEMENTS)
    const slice = paginateLines(header, lines, 0, budget, (next) => `${snapshotId}:${next}`, pageRows)
    return page(snapshotId, slice, lines.length, scanTruncated)
  }
}

function page(
  snapshotId: string,
  slice: { text: string; nextOffset?: number },
  total: number,
  scanTruncated: boolean,
): ProjectionPage {
  const result: ProjectionPage = { text: slice.text, snapshotId, scanTruncated, total }
  if (slice.nextOffset !== undefined) result.cursor = `${snapshotId}:${slice.nextOffset}`
  return result
}

function clampLimit(limit: number | undefined, fallback = DEFAULT_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback
  return Math.min(SCAN_MAX_RESULTS, Math.max(1, Math.floor(limit)))
}
