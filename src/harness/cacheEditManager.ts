/**
 * Tracks tool results by tool_use_id and produces Anthropic `cache_edits` blocks
 * that instruct the API to delete cached tool results without breaking the prefix.
 *
 * Used by the progressive compaction system to evict stale tool results from the
 * prompt cache in a structured, safe way.
 */

export interface CacheEditsBlock {
  type: 'cache_edits'
  edits: Array<{ type: 'delete'; cache_reference: string }>
}

export interface PinnedCacheEdits {
  userMessageIndex: number
  block: CacheEditsBlock
}

export interface CacheEditManagerConfig {
  /** Number of most recent tool results to never delete. Default: 10 */
  keepRecent: number
  /** Minimum registered results before producing edits. Default: 15 */
  triggerAfter: number
}

interface RegisteredResult {
  messageIndex: number
  toolUseId: string
  tool: string
  estimatedTokens: number
}

export class CacheEditManager {
  private readonly keepRecent: number
  private readonly triggerAfter: number

  /** All registered tool results, in registration order. */
  private readonly registered: RegisteredResult[] = []
  /** Set of tool_use_ids already registered (dedup guard). */
  private readonly registeredIds = new Set<string>()

  /** Pending edits produced by produceCacheEdits, awaiting consumePendingEdits. */
  private pendingEdits: CacheEditsBlock | null = null

  /** Pinned edits for re-sending across requests. */
  private readonly pinnedEdits: PinnedCacheEdits[] = []

  /** Set of all cache_references ever pinned (dedup across pin blocks). */
  private readonly pinnedRefs = new Set<string>()

  constructor(config?: Partial<CacheEditManagerConfig>) {
    this.keepRecent = config?.keepRecent ?? 10
    this.triggerAfter = config?.triggerAfter ?? 15
  }

  /**
   * Register a tool result for potential future deletion.
   * Duplicate tool_use_ids are silently ignored.
   */
  registerToolResult(
    messageIndex: number,
    toolUseId: string,
    tool: string,
    estimatedTokens: number,
  ): void {
    if (this.registeredIds.has(toolUseId)) return
    this.registeredIds.add(toolUseId)
    this.registered.push({ messageIndex, toolUseId, tool, estimatedTokens })
  }

  /**
   * Produce cache_edits for tool results that should be deleted.
   * Keeps the most recent `keepRecent` results; deletes the rest.
   * Returns null if fewer than `triggerAfter` results are registered.
   * Stores the result as pending — call consumePendingEdits() to retrieve it.
   */
  produceCacheEdits(): CacheEditsBlock | null {
    if (this.registered.length < this.triggerAfter) return null

    // Identify which results to delete: all except the most recent `keepRecent`
    const toDelete = this.registered.slice(0, this.registered.length - this.keepRecent)

    // Filter out refs that are already pinned (avoid duplicate deletes)
    const edits = toDelete
      .filter(r => !this.pinnedRefs.has(r.toolUseId))
      .map(r => ({ type: 'delete' as const, cache_reference: r.toolUseId }))

    if (edits.length === 0) return null

    const block: CacheEditsBlock = { type: 'cache_edits', edits }
    this.pendingEdits = block
    return block
  }

  /**
   * Consume pending edits (clears from internal state).
   * Call once before building each API payload.
   */
  consumePendingEdits(): CacheEditsBlock | null {
    const edits = this.pendingEdits
    this.pendingEdits = null
    return edits
  }

  /**
   * Pin edits at a specific message index for re-sending in subsequent requests.
   * Tracks deleted refs globally to avoid duplicates across pin blocks.
   */
  pinEdits(userMessageIndex: number, block: CacheEditsBlock): void {
    // Filter out any edits whose refs are already pinned
    const newEdits = block.edits.filter(e => {
      if (this.pinnedRefs.has(e.cache_reference)) return false
      this.pinnedRefs.add(e.cache_reference)
      return true
    })

    if (newEdits.length > 0) {
      this.pinnedEdits.push({
        userMessageIndex,
        block: { type: 'cache_edits', edits: newEdits },
      })
    }
  }

  /** Get all pinned edits. Returns a shallow copy to prevent external mutation. */
  getPinnedEdits(): PinnedCacheEdits[] {
    return [...this.pinnedEdits]
  }

  /** Get the set of all registered tool_use_ids. */
  getRegisteredToolUseIds(): Set<string> {
    return new Set(this.registeredIds)
  }

  /** Clear all state. */
  reset(): void {
    this.registered.length = 0
    this.registeredIds.clear()
    this.pendingEdits = null
    this.pinnedEdits.length = 0
    this.pinnedRefs.clear()
  }
}
