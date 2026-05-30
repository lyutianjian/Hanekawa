interface CacheEntry {
  timestamp: number
}

/**
 * LRU cache eviction via linear scan of timestamps.
 * Evicts the oldest entry when the cache reaches maxSize.
 *
 * Performance: O(n) per eviction where n is the current cache size.
 * This is acceptable for the current use cases (maxSize <= 50). If larger
 * caches are needed, replace with a doubly-linked list + Map for O(1) eviction.
 */
export function evictOldestIfNeeded<K, V extends CacheEntry>(
  cache: Map<K, V>,
  maxSize: number,
): void {
  if (cache.size < maxSize) return

  let oldestKey: K | undefined
  let oldestTimestamp = Infinity

  for (const [key, value] of cache.entries()) {
    if (value.timestamp < oldestTimestamp) {
      oldestTimestamp = value.timestamp
      oldestKey = key
    }
  }

  if (oldestKey !== undefined) {
    cache.delete(oldestKey)
  }
}
