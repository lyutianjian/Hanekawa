import { z } from 'zod/v3'
import type { Tool, ToolResult } from '../harness/types.js'

// --- Constants ---
const MAX_URL_LENGTH = 2000
const FETCH_TIMEOUT_MS = 30_000
const MAX_MARKDOWN_LENGTH = 100_000
const CACHE_TTL_MS = 15 * 60 * 1000 // 15 minutes
const MAX_CACHE_ENTRIES = 50

// --- Simple in-memory cache (Map + manual TTL, no external dependency) ---
interface CacheEntry {
  content: string
  bytes: number
  code: number
  contentType: string
  fetchedAt: number
}

const urlCache = new Map<string, CacheEntry>()

function getCached(url: string): CacheEntry | undefined {
  const entry = urlCache.get(url)
  if (!entry) return undefined
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    urlCache.delete(url)
    return undefined
  }
  return entry
}

function setCache(url: string, entry: CacheEntry): void {
  if (urlCache.size >= MAX_CACHE_ENTRIES) {
    let oldestKey: string | undefined
    let oldestTime = Infinity
    for (const [k, v] of urlCache) {
      if (v.fetchedAt < oldestTime) {
        oldestTime = v.fetchedAt
        oldestKey = k
      }
    }
    if (oldestKey) urlCache.delete(oldestKey)
  }
  urlCache.set(url, entry)
}

// --- Turndown (lazy singleton to avoid import cost when tool isn't used) ---
type TurndownCtor = typeof import('turndown')
let turndownInstance: InstanceType<TurndownCtor> | undefined
async function getTurndown(): Promise<InstanceType<TurndownCtor>> {
  if (!turndownInstance) {
    const mod = await import('turndown')
    const Turndown = (mod as unknown as { default: TurndownCtor }).default
    turndownInstance = new Turndown({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    })
  }
  return turndownInstance
}

// --- URL validation ---
function validateURL(url: string): { valid: false; error: string } | { valid: true; parsed: URL } {
  if (url.length > MAX_URL_LENGTH) {
    return { valid: false, error: `URL exceeds ${MAX_URL_LENGTH} characters` }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { valid: false, error: `Invalid URL format: "${url}"` }
  }
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'URLs with embedded credentials are not allowed' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: `Unsupported protocol: ${parsed.protocol}. Only http: and https: are supported.` }
  }
  return { valid: true, parsed }
}

// --- HTML content detection ---
function isHtmlContent(contentType: string): boolean {
  return contentType.includes('text/html') || contentType.includes('application/xhtml+xml')
}

// --- Main tool ---
export const webFetchTool: Tool = {
  name: 'WebFetch',
  description: 'Fetch content from a URL and convert it to markdown. Useful for reading documentation, articles, and web pages.',
  searchHint: 'fetch url web page content markdown',
  inputSchema: z.object({
    url: z.string().describe('The URL to fetch content from'),
  }).strict(),
  // Not `safe`: only the preapproved documentation hosts are auto-approved
  // (`utils/permissions/webFetchDomains.ts`); every other host prompts, and
  // "don't ask again" writes a `WebFetch(domain:...)` rule.
  riskLevel: 'confirm',
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  userFacingName: () => 'Fetch',
  getToolUseSummary(input) {
    if (typeof input !== 'object' || input === null) return null
    const url = (input as { url?: unknown }).url
    if (typeof url !== 'string') return null
    try {
      return new URL(url).hostname
    } catch {
      return url
    }
  },
  getActivityDescription(input) {
    const url = (typeof input === 'object' && input !== null)
      ? (input as { url?: string }).url
      : undefined
    if (!url) return 'Fetching URL'
    try {
      return `Fetching ${new URL(url).hostname}`
    } catch {
      return `Fetching ${url}`
    }
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const { url } = input as { url: string }

    // Validate URL
    const validation = validateURL(url)
    if (!validation.valid) {
      return { ok: false, content: validation.error, errorCode: 'invalid_input' }
    }
    const { parsed } = validation

    // Check cache
    const cached = getCached(url)
    if (cached) {
      return {
        ok: true,
        content: cached.content,
        metadata: {
          display: { summary: `Fetched ${parsed.hostname} (cached, ${formatBytes(cached.bytes)})` },
        },
      }
    }

    // Upgrade http to https
    const fetchUrl = parsed.protocol === 'http:'
      ? `https://${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`
      : url

    // Fetch
    let response: Response
    try {
      const signal = context.abortSignal
        ? AbortSignal.any([context.abortSignal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
        : AbortSignal.timeout(FETCH_TIMEOUT_MS)
      response = await fetch(fetchUrl, {
        signal,
        headers: {
          'Accept': 'text/html, text/markdown, text/plain, */*',
          'User-Agent': 'Hanekawa/0.1 (AI coding assistant)',
        },
        redirect: 'follow',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        content: `Failed to fetch URL: ${message}`,
        errorCode: 'execution_failed',
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        content: `HTTP ${response.status}: ${response.statusText || 'Request failed'}`,
        errorCode: 'execution_failed',
      }
    }

    // Read response body
    const text = await response.text()
    const contentType = response.headers.get('content-type') ?? ''
    const bytes = text.length

    // Convert HTML to markdown, or use raw text
    let markdown: string
    if (isHtmlContent(contentType)) {
      try {
        const turndown = await getTurndown()
        markdown = turndown.turndown(text)
      } catch {
        // If turndown fails, return raw text
        markdown = text
      }
    } else {
      markdown = text
    }

    // Truncate if needed
    let truncated = false
    if (markdown.length > MAX_MARKDOWN_LENGTH) {
      markdown = markdown.slice(0, MAX_MARKDOWN_LENGTH)
      truncated = true
    }

    // Cache the result
    setCache(url, { content: markdown, bytes, code: response.status, contentType, fetchedAt: Date.now() })

    const suffix = truncated ? `\n\n[Content truncated at ${MAX_MARKDOWN_LENGTH} characters]` : ''
    return {
      ok: true,
      content: markdown + suffix,
      metadata: {
        display: { summary: `Fetched ${parsed.hostname} (${formatBytes(bytes)})` },
      },
    }
  },
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
