export const WEB_SEARCH_TOOL_NAME = 'WebSearch'

export const DESCRIPTION = `Search the web and return titles, URLs, and snippets.

Usage:
- The only parameter is \`query\`. There is no \`allowed_domains\` or \`blocked_domains\` here; scope the search inside the query text instead, e.g. "site:nodejs.org stream backpressure".
- Snippets are short. Follow a promising result with WebFetch to read the page.
- Use this for information that is newer than your training data or that changes often (releases, versions, current docs).`
