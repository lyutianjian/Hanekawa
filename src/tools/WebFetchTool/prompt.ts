export const WEB_FETCH_TOOL_NAME = 'WebFetch'

export const DESCRIPTION = `Fetch a URL and return the page converted to markdown.

Usage:
- The only parameter is \`url\`. There is no \`prompt\` parameter: the page comes back as markdown for you to read, not summarized by a second model.
- \`url\` must be a full absolute URL including the scheme, e.g. "https://nodejs.org/api/stream.html".
- Well-known documentation hosts are pre-approved; every other host asks the user before the request goes out.
- Responses are cached for 15 minutes, so re-fetching the same URL within a turn costs nothing and returns the same bytes.
- Large pages are truncated. Prefer a URL that points at the specific page or anchor you need.`
