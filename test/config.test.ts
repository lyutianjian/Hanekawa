import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { ConfigService } from '../src/config/service.js'
import {
  loadMergedSettings,
  trustMcpServerLocally,
  validateSettings,
} from '../src/config/settings.js'
import { loadMcpConfig } from '../src/services/mcp/config.js'
import {
  AnthropicProvider,
  OpenAIProvider,
  ProviderRegistry,
  buildAnthropicMessages,
  buildAnthropicPayload,
  buildAnthropicTools,
  collectCacheControlTelemetry,
  enforceAnthropicCacheControlLimit,
  assertAnthropicCacheControlLimit,
  buildOpenAIMessages,
  buildOpenAIPayload,
  buildOpenAIPromptCacheKey,
  buildOpenAITools,
  createProvider,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
} from '../src/config/providers.js'
import { getAllTools, getBuiltinTools } from '../src/tools/index.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { resetCacheTTLEvaluation, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../src/harness/cacheControl.js'
import type { ModelRequest } from '../src/harness/types.js'

function countCacheControlMarkers(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countCacheControlMarkers(item), 0)
  }
  if (typeof value !== 'object' || value === null) return 0
  const record = value as Record<string, unknown>
  return (Object.hasOwn(record, 'cache_control') ? 1 : 0)
    + Object.values(record).reduce<number>((sum, item) => sum + countCacheControlMarkers(item), 0)
}

test('ConfigService loads defaults and saves config', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    await service.load()

    const config = service.get()
    assert.ok(config.models)
    assert.ok(config.agent)
    assert.deepEqual(config.models, {})
    assert.equal(config.defaultModel, undefined)
    assert.equal(config.fallbackModel, undefined)
    assert.equal(config.compactModel, undefined)

    service.addModel('test', { provider: 'anthropic', model: 'test-model' })
    assert.ok(service.getModel('test'))
    assert.equal(service.getModel('test')?.model, 'test-model')

    service.setDefaultModel('test')
    assert.equal(service.getDefaultModel()?.model, 'test-model')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService loads fallbackModel config', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    service.addModel('small', { provider: 'anthropic', model: 'claude-small' })
    service.get().fallbackModel = 'small'
    await service.save()

    const reloaded = new ConfigService(dir)
    await reloaded.load()
    const config = reloaded.get()
    assert.equal(config.fallbackModel, 'small')
    assert.equal(reloaded.getFallbackModel()?.model, 'claude-small')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService loads compactModel config', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    service.addModel('small', { provider: 'anthropic', model: 'claude-small' })
    service.get().compactModel = 'small'
    await service.save()

    const reloaded = new ConfigService(dir)
    await reloaded.load()
    const config = reloaded.get()
    assert.equal(config.compactModel, 'small')
    assert.equal(reloaded.getCompactModel()?.model, 'claude-small')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService accepts model pricing config', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    await service.load()

    service.addModel('priced', {
      provider: 'openai',
      model: 'gpt-test',
      pricing: {
        cacheReadInputPerMillionTokens: 0.1,
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 2,
        currency: 'USD',
      },
    })

    assert.deepEqual(service.getModel('priced')?.pricing, {
      cacheReadInputPerMillionTokens: 0.1,
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 2,
      currency: 'USD',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService loads model and agent defaults from merged settings', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    const service = new ConfigService(dir)
    await service.load({
      models: {
        local: {
          provider: 'openai',
          model: 'gpt-local',
          baseUrl: 'https://example.test/v1',
        },
      },
      defaultModel: 'local',
      fallbackModel: 'local',
      compactModel: 'local',
      agent: {
        system: 'settings system',
        contextManagement: {
          contextWindow: 12345,
        },
      },
    })

    const config = service.get()
    assert.equal(config.defaultModel, 'local')
    assert.equal(config.fallbackModel, 'local')
    assert.equal(config.compactModel, 'local')
    assert.deepEqual(Object.keys(config.models), ['local'])
    assert.equal(config.models.local?.model, 'gpt-local')
    assert.equal(config.agent.system, 'settings system')
    assert.equal(config.agent.contextManagement?.contextWindow, 12345)
    assert.equal(config.agent.contextManagement?.summaryOutputTokens, 20_000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService gives config.json priority over settings config fields', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    await mkdir(path.join(dir, '.myagent'), { recursive: true })
    await writeFile(path.join(dir, '.myagent', 'config.json'), JSON.stringify({
      models: {
        configModel: {
          provider: 'anthropic',
          model: 'claude-config',
        },
      },
      defaultModel: 'configModel',
      fallbackModel: 'settingsModel',
      compactModel: 'settingsModel',
      agent: {
        system: 'config system',
        contextManagement: {
          contextWindow: 999,
        },
      },
    }), 'utf8')

    const service = new ConfigService(dir)
    await service.load({
      models: {
        settingsModel: {
          provider: 'openai',
          model: 'gpt-settings',
        },
      },
      defaultModel: 'settingsModel',
      fallbackModel: 'settingsModel',
      compactModel: 'settingsModel',
      agent: {
        system: 'settings system',
        contextManagement: {
          contextWindow: 12345,
          summaryOutputTokens: 111,
        },
      },
    })

    const config = service.get()
    assert.equal(config.defaultModel, 'configModel')
    assert.equal(config.fallbackModel, 'settingsModel')
    assert.equal(config.compactModel, 'settingsModel')
    assert.equal(config.models.settingsModel?.model, 'gpt-settings')
    assert.equal(config.models.configModel?.model, 'claude-config')
    assert.deepEqual(Object.keys(config.models).sort(), ['configModel', 'settingsModel'])
    assert.equal(config.agent.system, 'config system')
    assert.equal(config.agent.contextManagement?.contextWindow, 999)
    assert.equal(config.agent.contextManagement?.summaryOutputTokens, 111)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService does not inject built-in Anthropic model when models are configured', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-config-'))
  try {
    await mkdir(path.join(dir, '.myagent'), { recursive: true })
    const configPath = path.join(dir, '.myagent', 'config.json')
    await writeFile(configPath, JSON.stringify({
      models: {
        local: {
          provider: 'openai',
          model: 'gpt-local',
        },
      },
      defaultModel: 'local',
    }), 'utf8')

    const service = new ConfigService(dir)
    await service.load()

    assert.deepEqual(Object.keys(service.get().models), ['local'])
    assert.equal(service.get().models.anthropic, undefined)

    await service.save()
    const saved = JSON.parse(await readFile(configPath, 'utf8')) as { models?: Record<string, unknown> }
    assert.deepEqual(Object.keys(saved.models ?? {}), ['local'])
    assert.equal(saved.models?.anthropic, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('validateSettings accepts hook settings', () => {
  const result = validateSettings({
    hooks: {
      userPromptSubmit: [
        { command: 'node scripts/prompt-context.js', timeoutMs: 1000 },
      ],
      preToolUse: [
        { matcher: 'Bash', command: 'node scripts/lint-bash.js', timeoutMs: 1000 },
      ],
      postToolUse: [
        { matcher: '*', command: 'node scripts/post-tool.js', timeoutMs: 1000 },
      ],
      stop: [
        { command: 'node scripts/notify.js', timeoutMs: 1000 },
      ],
    },
  })

  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
})

test('validateSettings accepts model, agent, and cache settings', () => {
  const result = validateSettings({
    models: {
      local: {
        provider: 'openai',
        model: 'gpt-local',
      },
    },
    defaultModel: 'local',
    fallbackModel: 'anthropic',
    compactModel: 'local',
    agent: {
      system: 'custom system',
      agentTimeoutMs: 120_000,
    },
    cache: {
      ttl1h: true,
    },
  })

  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
})

test('validateSettings rejects malformed model settings', () => {
  const result = validateSettings({
    models: {
      broken: {
        provider: '',
        model: '',
      },
    },
    defaultModel: '',
    fallbackModel: '',
    compactModel: '',
    agent: {
      system: 1 as unknown as string,
      agentTimeoutMs: 0,
    },
  })

  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /provider/)
  assert.match(result.errors.join('\n'), /agentTimeoutMs/)
  assert.match(result.errors.join('\n'), /model/)
  assert.match(result.errors.join('\n'), /defaultModel/)
  assert.match(result.errors.join('\n'), /fallbackModel/)
  assert.match(result.errors.join('\n'), /compactModel/)
  assert.match(result.errors.join('\n'), /agent\.system/)
})

test('validateSettings rejects malformed hook settings', () => {
  const result = validateSettings({
    hooks: {
      userPromptSubmit: 'bad' as unknown as [],
      preToolUse: [
        { matcher: 'Bash', command: '', timeoutMs: 0 },
      ],
      stop: [
        { command: '' },
      ],
    },
  })

  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /command/)
  assert.match(result.errors.join('\n'), /timeoutMs/)
  assert.match(result.errors.join('\n'), /userPromptSubmit/)
  assert.match(result.errors.join('\n'), /stop/)
})

test('validateSettings rejects malformed cache settings', () => {
  const result = validateSettings({
    cache: {
      ttl1h: 'yes',
    },
  } as never)

  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /cache\.ttl1h/)
})

test('validateSettings ignores legacy permission mode settings', () => {
  const result = validateSettings({
    permissionMode: 'accept-edits',
  } as never)

  assert.equal(result.valid, true)
  assert.doesNotMatch(result.errors.join('\n'), /permissionMode/)
})

test('validateSettings accepts permission rule arrays', () => {
  const result = validateSettings({
    permissions: {
      mode: 'bypass',
      allow: ['Read', 'Bash:*npm test*'],
      deny: ['Delete'],
      ask: ['Write:src/**'],
    },
  })

  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
})

test('validateSettings rejects invalid startup permission mode', () => {
  const result = validateSettings({
    permissions: {
      mode: 'plan',
    },
  } as never)

  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /permissions\.mode/)

  const unknown = validateSettings({
    permissions: {
      mode: 'accept-edits',
    },
  } as never)

  assert.equal(unknown.valid, false)
  assert.match(unknown.errors.join('\n'), /permissions\.mode/)
})

test('validateSettings rejects malformed permission rule arrays', () => {
  const result = validateSettings({
    permissions: {
      allow: 'Read',
      deny: [''],
      ask: [1],
    },
  } as never)

  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /permissions\.allow/)
  assert.match(result.errors.join('\n'), /permissions\.deny/)
  assert.match(result.errors.join('\n'), /permissions\.ask/)
})

test('validateSettings accepts trusted MCP servers and stdio timeout', () => {
  const result = validateSettings({
    mcp: {
      trustedServers: ['filesystem'],
    },
    mcpServers: {
      filesystem: {
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        timeoutMs: 60_000,
      },
    },
  })

  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
})

test('validateSettings rejects malformed MCP trust and args settings', () => {
  const result = validateSettings({
    mcp: {
      trustedServers: [''],
    },
    mcpServers: {
      unsafe: {
        transport: 'stdio',
        command: 'node',
        args: ['ok', 1] as unknown as string[],
        timeoutMs: 0,
      },
    },
  })

  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /trustedServers/)
  assert.match(result.errors.join('\n'), /args/)
  assert.match(result.errors.join('\n'), /timeoutMs/)
})

test('trustMcpServerLocally writes only project local settings', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-settings-'))
  try {
    await trustMcpServerLocally(dir, 'filesystem')
    await trustMcpServerLocally(dir, 'github')
    await trustMcpServerLocally(dir, 'filesystem')

    const localSettingsPath = path.join(dir, '.myagent', 'settings.local.json')
    const content = await readFile(localSettingsPath, 'utf-8')
    const parsed = JSON.parse(content) as { mcp?: { trustedServers?: string[] } }
    assert.deepEqual(parsed.mcp?.trustedServers, ['filesystem', 'github'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadMergedSettings ignores legacy permissionMode from local settings', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-settings-'))
  try {
    await mkdir(path.join(dir, '.myagent'), { recursive: true })
    await writeFile(path.join(dir, '.myagent', 'settings.local.json'), JSON.stringify({
      defaultModel: 'local',
      permissionMode: 'plan',
    }), 'utf8')

    const settings = await loadMergedSettings(dir)
    assert.equal(settings.defaultModel, 'local')
    assert.equal((settings as { permissionMode?: unknown }).permissionMode, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadMergedSettings merges permission rules and overrides startup mode', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-settings-'))
  try {
    await mkdir(path.join(dir, '.myagent'), { recursive: true })
    await writeFile(path.join(dir, '.myagent', 'settings.json'), JSON.stringify({
      permissions: {
        mode: 'auto',
        allow: ['Read'],
        deny: ['Delete'],
      },
    }), 'utf8')
    await writeFile(path.join(dir, '.myagent', 'settings.local.json'), JSON.stringify({
      permissions: {
        mode: 'bypass',
        allow: ['Grep'],
        ask: ['Write:src/**'],
      },
    }), 'utf8')

    const settings = await loadMergedSettings(dir)
    assert.deepEqual(settings.permissions, {
      mode: 'bypass',
      allow: ['Read', 'Grep'],
      deny: ['Delete'],
      ask: ['Write:src/**'],
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadMergedSettings folds legacy mcp.json before local settings overrides', async () => {
  const dir = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-settings-'))
  try {
    await mkdir(path.join(dir, '.myagent'), { recursive: true })
    await writeFile(path.join(dir, '.myagent', 'mcp.json'), JSON.stringify({
      mcpServers: {
        filesystem: {
          transport: 'stdio',
          command: 'node',
          args: ['legacy.js'],
        },
        github: {
          transport: 'stdio',
          command: 'node',
          args: ['github.js'],
        },
      },
    }), 'utf8')
    await writeFile(path.join(dir, '.myagent', 'settings.local.json'), JSON.stringify({
      mcpServers: {
        filesystem: {
          transport: 'stdio',
          command: 'node',
          args: ['local.js'],
        },
      },
    }), 'utf8')

    const settings = await loadMergedSettings(dir)
    const mcpConfig = await loadMcpConfig(dir, settings)
    assert.deepEqual(mcpConfig.filesystem?.args, ['local.js'])
    assert.deepEqual(mcpConfig.github?.args, ['github.js'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ProviderRegistry registers and retrieves providers', () => {
  const registry = new ProviderRegistry()
  assert.ok(!registry.has('test'))
  assert.equal(registry.get('test'), undefined)

  const provider = createProvider({ provider: 'anthropic', model: 'claude-3' })
  if (provider) {
    registry.register(provider)
    assert.ok(registry.has('anthropic'))
    assert.equal(registry.get('anthropic')?.name, 'anthropic')
    assert.deepEqual(registry.list(), ['anthropic'])
  }
})

test('createProvider selects adapter from provider field', () => {
  const anthropic = createProvider({ provider: 'anthropic', model: 'claude-3', apiKey: 'test-key' })
  const openai = createProvider({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'test-key' })

  assert.ok(anthropic instanceof AnthropicProvider)
  assert.ok(openai instanceof OpenAIProvider)
})

test('buildAnthropicMessages includes tool use and tool results', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    system: 'system text',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'hello',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'tool_use',
        id: 'call-1',
        tool: 'Read',
        input: { filePath: 'a.txt' },
      },
      {
        kind: 'tool_result',
        toolUseId: 'call-1',
        tool: 'Read',
        ok: true,
        content: 'file body',
      },
    ],
  }

  const messages = buildAnthropicMessages(request)
  assert.equal(messages.length, 3)
  assert.equal(messages[0]?.role, 'user')
  assert.deepEqual(messages[0]?.content, [{
    type: 'text',
    text: 'hello',
  }])
  assert.equal(messages[1]?.role, 'assistant')
  assert.deepEqual(messages[1]?.content, [{
    type: 'tool_use',
    id: 'call-1',
    name: 'Read',
    input: { filePath: 'a.txt' },
  }])
  assert.equal(messages[2]?.role, 'user')
  assert.deepEqual(messages[2]?.content, [{
    type: 'tool_result',
    tool_use_id: 'call-1',
    content: 'file body',
    is_error: false,
  }])
})

test('buildAnthropicMessages uses a readable placeholder when context is empty', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    system: 'system text',
    messages: [],
    contextItems: [],
  }

  const messages = buildAnthropicMessages(request)
  assert.deepEqual(messages, [{
    role: 'user',
    content: [{
      type: 'text',
      text: '(context truncated - please continue)',
    }],
  }])
})

test('buildAnthropicPayload caches static system and final message text blocks (native Anthropic)', () => {
  resetCacheTTLEvaluation()
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    system: 'system text',
    systemBlocks: ['identity text', 'instruction text', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'custom system text'],
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: 'hello',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'u2',
        role: 'user',
        content: 'latest',
        createdAt: new Date().toISOString(),
      },
    ],
  }

  const payload = buildAnthropicPayload(request, undefined, true) as Record<string, unknown>

  assert.deepEqual(payload.system, [
    {
      type: 'text',
      text: 'identity text\n\ninstruction text',
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: 'custom system text',
    },
  ])
  assert.deepEqual(payload.messages, [
    {
      role: 'user',
      content: [{
        type: 'text',
        text: 'hello',
      }],
    },
    {
      role: 'user',
      content: [{
        type: 'text',
        text: 'latest',
        cache_control: { type: 'ephemeral' },
      }],
    },
  ])
})

test('buildAnthropicPayload can enable 1h cache ttl from runtime settings', () => {
  resetCacheTTLEvaluation()
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    system: 'system text',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'latest',
      createdAt: new Date().toISOString(),
    }],
    cacheRuntime: {
      settings: { cache: { ttl1h: true } },
      env: { MYAGENT_PROMPT_CACHE_1H: '0' },
    },
  }

  const payload = buildAnthropicPayload(request, undefined, true) as Record<string, unknown>
  const system = payload.system as Array<Record<string, unknown>>
  const messages = payload.messages as Array<{ content: Array<Record<string, unknown>> }>

  assert.deepEqual(system[0]?.cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(messages[0]?.content[0]?.cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('buildAnthropicPayload caches only the final tool schema for native Anthropic', () => {
  resetCacheTTLEvaluation()
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString(),
    }],
    tools: [
      { name: 'a', description: 'a', inputSchema: z.object({}).strict(), riskLevel: 'safe', execute: async () => ({ ok: true, content: '' }) },
      { name: 'b', description: 'b', inputSchema: z.object({}).strict(), riskLevel: 'safe', execute: async () => ({ ok: true, content: '' }) },
    ],
  }

  const payload = buildAnthropicPayload(request, undefined, true) as { tools: Array<Record<string, unknown>> }

  assert.equal(payload.tools[0]?.cache_control, undefined)
  assert.deepEqual(payload.tools[1]?.cache_control, { type: 'ephemeral' })
})

test('enforceAnthropicCacheControlLimit removes tool schema markers first', () => {
  const payload = {
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text', text: 'c', cache_control: { type: 'ephemeral' } }] },
    ],
    tools: [
      { name: 'a', description: 'a', input_schema: {}, cache_control: { type: 'ephemeral' } },
    ],
  }

  enforceAnthropicCacheControlLimit(payload)

  assert.equal(countCacheControlMarkers(payload), 4)
  assert.equal(payload.tools[0]?.cache_control, undefined)
  assert.deepEqual(payload.system[0]?.cache_control, { type: 'ephemeral' })
})

test('collectCacheControlTelemetry reports marker count and distribution', () => {
  const payload = {
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
    ],
    tools: [
      { name: 'a', description: 'a', input_schema: {}, cache_control: { type: 'ephemeral' } },
    ],
  }

  assert.deepEqual(collectCacheControlTelemetry(payload), {
    total: 3,
    limit: 4,
    byLocation: {
      system: 1,
      tools: 1,
      messages: 1,
      other: 0,
    },
    paths: [
      'system.0.cache_control',
      'messages.0.content.0.cache_control',
      'tools.0.cache_control',
    ],
  })
})

test('assertAnthropicCacheControlLimit rejects payloads over Anthropic marker limit', () => {
  const payload = {
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text', text: 'c', cache_control: { type: 'ephemeral' } }] },
    ],
    tools: [
      { name: 'a', description: 'a', input_schema: {}, cache_control: { type: 'ephemeral' } },
    ],
  }

  assert.throws(
    () => assertAnthropicCacheControlLimit(payload),
    /Anthropic payload has 5 cache_control markers; limit is 4/,
  )
})

test('buildAnthropicPayload sends clean format for third-party providers', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    system: 'system text',
    systemBlocks: ['identity text', 'instruction text', 'custom system text'],
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString(),
    }],
  }

  const payload = buildAnthropicPayload(request) as Record<string, unknown>

  assert.equal(payload.system, 'identity text\n\ninstruction text\n\ncustom system text')
  assert.deepEqual(payload.messages, [{
    role: 'user',
    content: [{ type: 'text', text: 'hello' }],
  }])
  assert.ok(!('tool_choice' in payload))
  assert.equal(JSON.stringify(payload).includes('cache_control'), false)
})

test('normalizeAnthropicUsage maps cache and output tokens', () => {
  assert.deepEqual(normalizeAnthropicUsage({
    input_tokens: 100,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 300,
    output_tokens: 40,
  }), {
    cacheReadInputTokens: 300,
    inputTokens: 120,
    outputTokens: 40,
  })
})

test('normalizeOpenAIUsage splits cached and uncached prompt tokens', () => {
  assert.deepEqual(normalizeOpenAIUsage({
    prompt_tokens: 500,
    completion_tokens: 60,
    prompt_tokens_details: {
      cached_tokens: 200,
    },
  }), {
    cacheReadInputTokens: 200,
    inputTokens: 300,
    outputTokens: 60,
  })
})

test('buildOpenAIMessages includes tool call history and tool results', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'hello',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'tool_use',
        id: 'call-1',
        tool: 'Grep',
        input: { pattern: 'hello' },
      },
      {
        kind: 'tool_result',
        toolUseId: 'call-1',
        tool: 'Grep',
        ok: true,
        content: 'a.txt:1: hello',
      },
    ],
  }

  const messages = buildOpenAIMessages(request)
  assert.equal(messages.length, 3)
  assert.equal(messages[0]?.role, 'user')
  assert.equal(messages[1]?.role, 'assistant')
  assert.deepEqual((messages[1] as { tool_calls: unknown }).tool_calls, [{
    id: 'call-1',
    type: 'function',
    function: {
      name: 'Grep',
      arguments: JSON.stringify({ pattern: 'hello' }),
    },
  }])
  assert.equal(messages[2]?.role, 'tool')
  assert.equal((messages[2] as { tool_call_id: string }).tool_call_id, 'call-1')
})

test('buildAnthropicPayload omits tool fields for plain-text requests', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString(),
    }],
  }

  const payload = buildAnthropicPayload(request) as Record<string, unknown>
  assert.equal(payload.model, 'fake-model')
  assert.ok(Array.isArray(payload.messages))
  assert.ok(!('tools' in payload))
  assert.ok(!('tool_choice' in payload))
  assert.ok(!('system' in payload))
})

test('buildOpenAIPayload omits tools for plain-text requests', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    messages: [{
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString(),
    }],
  }

  const payload = buildOpenAIPayload(request) as Record<string, unknown>
  assert.equal(payload.model, 'fake-model')
  assert.ok(Array.isArray(payload.messages))
  assert.ok(!('tools' in payload))
  assert.equal(JSON.stringify(payload).includes('cache_control'), false)
  assert.equal(typeof payload.prompt_cache_key, 'string')
})

test('buildOpenAIPayload includes Hanekawa system, skills reminder, Skill tool, and cache key', async () => {
  const tools = await getAllTools()
  const builder = new ContextBuilder(undefined, { contextWindow: 50000, summaryOutputTokens: 0 })
  const built = await builder.build({
    records: [{
      type: 'message',
      id: 'u1',
      role: 'user',
      content: 'hello',
      createdAt: new Date().toISOString(),
    }],
    tools,
    skills: [
      { name: 'debugging', description: 'Use when diagnosing bugs', content: 'Debug content' },
    ],
    system: 'custom system',
    now: new Date('2026-05-10T12:00:00.000Z'),
  })

  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'gpt-test',
    system: built.system,
    messages: built.messages,
    contextItems: built.contextItems,
    tools,
    promptCacheRetention: '24h',
  }
  const payload = buildOpenAIPayload(request) as {
    messages: Array<{ role: string; content: string }>
    tools: Array<{ function: { name: string } }>
    prompt_cache_key: string
    prompt_cache_retention?: string
  }

  assert.equal(payload.messages[0]?.role, 'system')
  assert.match(payload.messages[0]?.content ?? '', /You are Hanekawa/)
  assert.match(payload.messages[0]?.content ?? '', /lyutianjian/)
  assert.match(payload.messages[0]?.content ?? '', /# Doing tasks/)
  assert.match(payload.messages[0]?.content ?? '', /# Using your tools/)
  assert.match(payload.messages[0]?.content ?? '', /custom system/)
  assert.match(payload.messages[0]?.content ?? '', /The following skills are available for use with the Skill tool/)
  assert.match(payload.messages[0]?.content ?? '', /- debugging: Use when diagnosing bugs/)
  assert.ok(payload.tools.some((tool) => tool.function.name === 'Skill'))
  assert.equal(payload.tools.some((tool) => tool.function.name.startsWith('skill_')), false)
  assert.match(payload.prompt_cache_key, /^myagent:[a-f0-9]{32}$/)
  assert.equal(payload.prompt_cache_retention, '24h')
  assert.equal(JSON.stringify(payload).includes('cache_control'), false)
})

test('buildOpenAIPromptCacheKey is stable for model, system, and tools', async () => {
  const tools = await getAllTools()
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'gpt-test',
    system: 'system text',
    messages: [],
    tools,
  }

  assert.equal(buildOpenAIPromptCacheKey(request), buildOpenAIPromptCacheKey({ ...request, messages: [] }))
  assert.equal(
    buildOpenAIPromptCacheKey(request),
    buildOpenAIPromptCacheKey({ ...request, cacheSource: 'agent:other-session' }),
  )
  assert.notEqual(
    buildOpenAIPromptCacheKey(request),
    buildOpenAIPromptCacheKey({ ...request, system: 'different system' }),
  )
  assert.notEqual(
    buildOpenAIPromptCacheKey(request),
    buildOpenAIPromptCacheKey({ ...request, model: 'gpt-other' }),
  )
  assert.notEqual(
    buildOpenAIPromptCacheKey(request),
    buildOpenAIPromptCacheKey({ ...request, tools: [] }),
  )
})

test('buildOpenAITools includes concrete schemas for built-in tools', () => {
  const readFileTool = getBuiltinTools().find((tool) => tool.name === 'Read')
  assert.ok(readFileTool)

  const tools = buildOpenAITools([readFileTool])
  assert.equal(tools.length, 1)
  assert.deepEqual(tools[0]?.function.parameters, {
    type: 'object',
    properties: {
      filePath: { type: 'string', minLength: 1 },
    },
    required: ['filePath'],
    additionalProperties: false,
  })
})

test('buildAnthropicTools includes concrete schemas for built-in tools', () => {
  const readFileTool = getBuiltinTools().find((tool) => tool.name === 'Read')
  assert.ok(readFileTool)

  const tools = buildAnthropicTools([readFileTool])
  assert.equal(tools.length, 1)
  assert.deepEqual(tools[0]?.input_schema, {
    type: 'object',
    properties: {
      filePath: { type: 'string', minLength: 1 },
    },
    required: ['filePath'],
    additionalProperties: false,
  })
})

test('buildAnthropicMessages merges assistant text with following tool use', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'read the file',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: 'I will read it now.',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'tool_use',
        id: 'call-1',
        tool: 'Read',
        input: { filePath: 'src/config/providers.ts' },
      },
    ],
  }

  const messages = buildAnthropicMessages(request)
  assert.equal(messages.length, 2)
  assert.equal(messages[1]?.role, 'assistant')
  assert.deepEqual(messages[1]?.content, [
    {
      type: 'text',
      text: 'I will read it now.',
    },
    {
      type: 'tool_use',
      id: 'call-1',
      name: 'Read',
      input: { filePath: 'src/config/providers.ts' },
    },
  ])
})

test('buildOpenAIMessages merges assistant text with following tool call', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'fake-model',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'search for hello',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: 'I will search the codebase.',
          createdAt: new Date().toISOString(),
        },
      },
      {
        kind: 'tool_use',
        id: 'call-1',
        tool: 'Grep',
        input: { pattern: 'hello' },
      },
    ],
  }

  const messages = buildOpenAIMessages(request)
  assert.equal(messages.length, 2)
  assert.equal(messages[1]?.role, 'assistant')
  assert.equal((messages[1] as { content: string }).content, 'I will search the codebase.')
  assert.deepEqual((messages[1] as { tool_calls: unknown }).tool_calls, [{
    id: 'call-1',
    type: 'function',
    function: {
      name: 'Grep',
      arguments: JSON.stringify({ pattern: 'hello' }),
    },
  }])
})

test('buildAnthropicPayload includes thinking parameter when enabled', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'claude-opus-4-7',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: { id: 'u1', role: 'user', content: 'hi', createdAt: new Date().toISOString() },
      },
    ],
    thinking: { enabled: true, budgetTokens: 5000 },
  }

  const payload = buildAnthropicPayload(request, undefined, true) as { thinking?: unknown; max_tokens: number }
  assert.deepEqual(payload.thinking, { type: 'enabled', budget_tokens: 5000 })
  assert.ok(payload.max_tokens > 5000)
})

test('buildAnthropicPayload omits thinking when disabled', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'claude-opus-4-7',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: { id: 'u1', role: 'user', content: 'hi', createdAt: new Date().toISOString() },
      },
    ],
  }

  const payload = buildAnthropicPayload(request) as Record<string, unknown>
  assert.equal(payload.thinking, undefined)
})

test('buildAnthropicMessages prepends thinking blocks before assistant content', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'claude-opus-4-7',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: { id: 'u1', role: 'user', content: 'solve this', createdAt: new Date().toISOString() },
      },
      {
        kind: 'message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: 'The answer is 42.',
          createdAt: new Date().toISOString(),
          thinkingBlocks: [
            { type: 'thinking', thinking: 'Let me think...', signature: 'sig-abc' },
          ],
        },
      },
    ],
  }

  const messages = buildAnthropicMessages(request)
  assert.equal(messages.length, 2)
  assert.equal(messages[1]?.role, 'assistant')
  const content = messages[1]?.content as Array<Record<string, unknown>>
  assert.equal(content[0]?.type, 'thinking')
  assert.equal(content[0]?.thinking, 'Let me think...')
  assert.equal(content[0]?.signature, 'sig-abc')
  assert.equal(content[1]?.type, 'text')
  assert.equal(content[1]?.text, 'The answer is 42.')
})

test('buildAnthropicMessages preserves thinking blocks when followed by tool_use', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'claude-opus-4-7',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: { id: 'u1', role: 'user', content: 'read it', createdAt: new Date().toISOString() },
      },
      {
        kind: 'message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
          thinkingBlocks: [
            { type: 'thinking', thinking: 'I should read the file', signature: 'sig-xyz' },
          ],
        },
      },
      {
        kind: 'tool_use',
        id: 'call-1',
        tool: 'Read',
        input: { filePath: 'a.txt' },
      },
    ],
  }

  const messages = buildAnthropicMessages(request)
  assert.equal(messages.length, 2)
  const content = messages[1]?.content as Array<Record<string, unknown>>
  assert.equal(content[0]?.type, 'thinking')
  assert.equal(content[1]?.type, 'tool_use')
})

test('buildOpenAIMessages includes reasoning_content on assistant messages', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'deepseek-reasoner',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: { id: 'u1', role: 'user', content: 'hi', createdAt: new Date().toISOString() },
      },
      {
        kind: 'message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: 'Hello!',
          createdAt: new Date().toISOString(),
          reasoningContent: 'The user greeted me, I should greet back.',
        },
      },
    ],
  }

  const messages = buildOpenAIMessages(request)
  assert.equal(messages.length, 2)
  const assistant = messages[1] as { content: string; reasoning_content?: string }
  assert.equal(assistant.content, 'Hello!')
  assert.equal(assistant.reasoning_content, 'The user greeted me, I should greet back.')
})

test('buildOpenAIMessages omits reasoning_content for user messages', () => {
  const request: ModelRequest = {
    cacheSource: 'agent:test',
    model: 'deepseek-reasoner',
    messages: [],
    contextItems: [
      {
        kind: 'message',
        message: { id: 'u1', role: 'user', content: 'hi', createdAt: new Date().toISOString() },
      },
    ],
  }

  const messages = buildOpenAIMessages(request)
  const user = messages[0] as { reasoning_content?: string }
  assert.equal(user.reasoning_content, undefined)
})
