/**
 * Requests in flight, per page.
 *
 * Fed by the browser partition's `webRequest` events rather than by CDP: the
 * debugger attaches on demand and detaches when idle, so it would miss exactly
 * the requests a click started before the next call asked. `webRequest` sees
 * every request the partition makes, attached or not.
 *
 * Electron-free and clock-injectable, so the bookkeeping is tested without a
 * session. Keyed by `webContents.id`; a page that goes away is forgotten.
 */

export interface PendingRequest {
  url: string
  ageMs: number
}

export interface NetworkState {
  pending: PendingRequest[]
  /** Since a request last started or ended on this page; `Infinity` if none ever did. */
  quietMs: number
}

interface PageRequests {
  inflight: Map<number, { url: string; since: number }>
  lastEvent: number
}

export class NetworkActivity {
  private readonly pages = new Map<number, PageRequests>()

  constructor(private readonly now: () => number = () => performance.now()) {}

  started(contentsId: number, requestId: number, url: string): void {
    const page = this.page(contentsId)
    page.inflight.set(requestId, { url, since: this.now() })
    page.lastEvent = this.now()
  }

  /** Completed, failed or cancelled: the request no longer holds the page up. */
  ended(contentsId: number, requestId: number): void {
    const page = this.pages.get(contentsId)
    if (page === undefined) return
    page.inflight.delete(requestId)
    page.lastEvent = this.now()
  }

  forget(contentsId: number): void {
    this.pages.delete(contentsId)
  }

  state(contentsId: number): NetworkState {
    const page = this.pages.get(contentsId)
    if (page === undefined) return { pending: [], quietMs: Infinity }
    const at = this.now()
    return {
      pending: [...page.inflight.values()].map(({ url, since }) => ({ url, ageMs: at - since })),
      quietMs: at - page.lastEvent,
    }
  }

  private page(contentsId: number): PageRequests {
    let page = this.pages.get(contentsId)
    if (page === undefined) {
      page = { inflight: new Map(), lastEvent: this.now() }
      this.pages.set(contentsId, page)
    }
    return page
  }
}
