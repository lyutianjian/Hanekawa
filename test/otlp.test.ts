import { createServer } from 'node:http'
import test from 'node:test'
import assert from 'node:assert/strict'
import { OtlpMetricExporter } from '../src/harness/otlp.js'

test('OtlpMetricExporter sends session metrics as OTLP HTTP JSON metrics', async () => {
  let requestPath = ''
  let requestBody = ''
  const server = createServer((req, res) => {
    requestPath = req.url ?? ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      requestBody += chunk
    })
    req.on('end', () => {
      res.writeHead(200)
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const exporter = new OtlpMetricExporter({
      endpoint: `http://127.0.0.1:${address.port}`,
      timeoutMs: 1_000,
    })

    await exporter.exportMetric({
      event: 'turn',
      created_at: '2026-05-24T00:00:00.000Z',
      session_id: 'session-1',
      model: 'fake-model',
      input_tokens: 10,
      response_tokens: 5,
      cache_read_tokens: 20,
      cache_hit_rate: 2 / 3,
      tool_calls: 1,
      duration_ms: 25,
    })

    assert.equal(requestPath, '/v1/metrics')
    const payload = JSON.parse(requestBody) as Record<string, unknown>
    const resourceMetrics = payload.resourceMetrics as Array<Record<string, unknown>>
    const resource = resourceMetrics[0]?.resource as Record<string, unknown>
    const resourceAttributes = resource.attributes as Array<{ key: string; value: Record<string, unknown> }>
    const scopeMetrics = resourceMetrics[0]?.scopeMetrics as Array<Record<string, unknown>>
    const metrics = scopeMetrics[0]?.metrics as Array<Record<string, unknown>>
    const dataPoints = metrics[0]?.gauge as { dataPoints: Array<{ timeUnixNano: string }> }
    assert.ok(metrics.some((metric) => metric.name === 'hanekawa.turn.response_tokens'))
    assert.ok(metrics.some((metric) => metric.name === 'hanekawa.turn.cache_hit_rate'))
    assert.deepEqual(resourceAttributes.filter((item) => item.key.startsWith('service.') || item.key.startsWith('telemetry.sdk.')).map((item) => item.key), [
      'service.name',
      'service.version',
      'telemetry.sdk.name',
      'telemetry.sdk.version',
    ])
    assert.equal(resourceAttributes.find((item) => item.key === 'service.version')?.value.stringValue, '0.1.0')
    assert.equal(resourceAttributes.find((item) => item.key === 'telemetry.sdk.name')?.value.stringValue, 'hanekawa')
    assert.equal(dataPoints.dataPoints[0]?.timeUnixNano, `${BigInt(Date.parse('2026-05-24T00:00:00.000Z')) * 1_000_000n}`)
    assert.match(JSON.stringify(payload), /hanekawa\.metrics/)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})

test('OtlpMetricExporter only exports known numeric fields', async () => {
  let requestBody = ''
  const server = createServer((req, res) => {
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      requestBody += chunk
    })
    req.on('end', () => {
      res.writeHead(200)
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const exporter = new OtlpMetricExporter({
      endpoint: `http://127.0.0.1:${address.port}`,
      timeoutMs: 1_000,
    })

    await exporter.exportMetric({
      event: 'session_cache_summary',
      created_at: '2026-05-24T00:00:00.000Z',
      session_id: 'session-1',
      total_cache_hit_rate: 0.5,
      total_turns: 3,
      first_break_turn_count: null,
      cache_break_count: 1,
      cause_distribution: {},
      future_numeric_field: 99,
    } as Parameters<OtlpMetricExporter['exportMetric']>[0])

    const payload = JSON.parse(requestBody) as Record<string, unknown>
    const resourceMetrics = payload.resourceMetrics as Array<Record<string, unknown>>
    const scopeMetrics = resourceMetrics[0]?.scopeMetrics as Array<Record<string, unknown>>
    const metrics = scopeMetrics[0]?.metrics as Array<Record<string, unknown>>
    const metricNames = metrics.map((metric) => metric.name)

    assert.ok(metricNames.includes('hanekawa.session_cache_summary.total_turns'))
    assert.ok(!metricNames.includes('hanekawa.session_cache_summary.future_numeric_field'))
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})
