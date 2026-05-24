export const ANTHROPIC_CACHE_CONTROL_LIMIT = 4

export interface CacheControlTelemetry {
  total: number
  limit: number
  byLocation: {
    system: number
    tools: number
    messages: number
    other: number
  }
  paths: string[]
}

export function collectCacheControlTelemetry(payload: unknown): CacheControlTelemetry {
  const telemetry: CacheControlTelemetry = {
    total: 0,
    limit: ANTHROPIC_CACHE_CONTROL_LIMIT,
    byLocation: {
      system: 0,
      tools: 0,
      messages: 0,
      other: 0,
    },
    paths: [],
  }

  collectMarkers(payload, [], telemetry)
  return telemetry
}

export function assertAnthropicCacheControlLimit(payload: unknown): CacheControlTelemetry {
  const telemetry = collectCacheControlTelemetry(payload)
  if (telemetry.total > ANTHROPIC_CACHE_CONTROL_LIMIT) {
    throw new Error(
      `Anthropic payload has ${telemetry.total} cache_control markers; limit is ${ANTHROPIC_CACHE_CONTROL_LIMIT}. `
      + `Markers: ${telemetry.paths.join(', ')}`,
    )
  }
  return telemetry
}

function collectMarkers(value: unknown, path: string[], telemetry: CacheControlTelemetry): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectMarkers(item, [...path, String(index)], telemetry))
    return
  }
  if (!isRecord(value)) return

  if (Object.hasOwn(value, 'cache_control')) {
    telemetry.total += 1
    telemetry.byLocation[cacheControlLocation(path)] += 1
    telemetry.paths.push([...path, 'cache_control'].join('.'))
  }

  for (const [key, item] of Object.entries(value)) {
    collectMarkers(item, [...path, key], telemetry)
  }
}

function cacheControlLocation(path: string[]): keyof CacheControlTelemetry['byLocation'] {
  const root = path[0]
  if (root === 'system' || root === 'tools' || root === 'messages') return root
  return 'other'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
