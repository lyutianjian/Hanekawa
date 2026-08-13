import { z } from 'zod/v3'
import type { Tool } from '../harness/types.js'
import { USER_AGENT } from '../utils/userAgent.js'

const SEARCH_TIMEOUT_MS = 15_000
const MAX_RESULTS = 10

interface SearchResult {
  title: string
  url: string
  snippet: string
}

// --- DuckDuckGo HTML search (free, no API key required) ---
async function searchDuckDuckGo(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, t: 'h_', ia: 'web' })
  const response = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
    signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Hanekawa/0.1; +https://github.com/myagent)',
    },
  })
  if (!response.ok) {
    throw new Error(`Search returned HTTP ${response.status}`)
  }
  const html = await response.text()
  return parseDuckDuckGoResults(html)
}

function parseDuckDuckGoResults(html: string): SearchResult[] {
  const results: SearchResult[] = []

  // DuckDuckGo HTML results structure:
  // <a class="result__a" href="...">title</a>
  // <a class="result__snippet" ...>snippet</a>
  // The href contains a redirect URL with the actual URL in the `uddg` parameter.
  const linkPattern = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetPattern = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g

  const links: { url: string; title: string }[] = []
  let match: RegExpExecArray | null

  while ((match = linkPattern.exec(html)) !== null && links.length < MAX_RESULTS) {
    // Extract actual URL from DuckDuckGo redirect wrapper
    const href = match[1] ?? ''
    const url = href.includes('uddg=')
      ? decodeURIComponent(href.replace(/.*uddg=/, '').replace(/&.*/, ''))
      : href
    const title = (match[2] ?? '').replace(/<[^>]+>/g, '').trim()
    if (url && title) {
      links.push({ url, title })
    }
  }

  const snippets: string[] = []
  while ((match = snippetPattern.exec(html)) !== null && snippets.length < MAX_RESULTS) {
    snippets.push((match[1] ?? '').replace(/<[^>]+>/g, '').trim())
  }

  for (let i = 0; i < Math.min(links.length, snippets.length); i++) {
    results.push({
      title: links[i]!.title,
      url: links[i]!.url,
      snippet: snippets[i]!,
    })
  }
  return results
}

// --- SearXNG JSON API (configurable via HANEKAWA_SEARCH_URL env var) ---
async function searchSearXNG(query: string, instanceUrl: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query, format: 'json' })
  const url = `${instanceUrl.replace(/\/$/, '')}/search?${params}`
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal })
  if (!response.ok) {
    throw new Error(`SearXNG returned HTTP ${response.status}`)
  }
  const data = await response.json() as {
    results?: Array<{ title: string; url: string; content?: string }>
  }
  return (data.results ?? []).slice(0, MAX_RESULTS).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.content ?? '',
  }))
}

// --- Pluggable search dispatcher ---
async function performSearch(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const searxngUrl = process.env.HANEKAWA_SEARCH_URL
  if (searxngUrl) {
    return searchSearXNG(query, searxngUrl, signal)
  }
  return searchDuckDuckGo(query, signal)
}

// --- Tool definition ---
export const webSearchTool: Tool = {
  name: 'WebSearch',
  description: 'Search the web for current information. Returns titles, URLs, and snippets for relevant results.',
  searchHint: 'search the web for current information',
  inputSchema: z.object({
    query: z.string().min(2).describe('The search query to use'),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 50_000,
  shouldDefer: true,
  userFacingName: () => 'Web Search',
  getToolUseSummary(input) {
    if (typeof input !== 'object' || input === null) return null
    const query = (input as { query?: unknown }).query
    return typeof query === 'string' ? query : null
  },
  getActivityDescription(input) {
    const query = (typeof input === 'object' && input !== null)
      ? (input as { query?: string }).query
      : undefined
    return query ? `Searching for "${query}"` : 'Searching the web'
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const { query } = input as { query: string }
    const startTime = Date.now()

    try {
      const results = await performSearch(query, context.abortSignal)
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)

      if (results.length === 0) {
        return {
          ok: true,
          content: 'No search results found.',
          metadata: { display: { summary: 'No results found' } },
        }
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`,
      ).join('\n\n')

      return {
        ok: true,
        content: `Search results for "${query}":\n\n${formatted}`,
        metadata: {
          display: {
            summary: `Found ${results.length} results in ${duration}s`,
          },
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        content: `Web search failed: ${message}`,
        errorCode: 'execution_failed',
      }
    }
  },
}
