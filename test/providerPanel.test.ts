import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createElement as h } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { ConfigService } from '../src/config/service.js'
import { ProviderPanel } from '../src/tui/components/ProviderPanel.js'
import { mkdtempSync } from 'node:fs'

// ConfigService layers a shared `~/.myagent/config.json` under the project one.
// A fresh home per test keeps these off the developer's config and stops a
// save() in one test (which targets the shared layer when no project config
// exists) from leaking models into the next.
beforeEach(() => {
  const testHome = mkdtempSync(path.join(tmpdir(), 'myagent-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
})

afterEach(() => cleanup())

async function createConfig(): Promise<{ config: ConfigService; cwd: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-provider-panel-'))
  const config = new ConfigService(cwd)
  return { config, cwd }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function writeInput(panel: ReturnType<typeof render>, input: string): Promise<void> {
  panel.stdin.write(input)
  await flush()
}

async function writeEscape(panel: ReturnType<typeof render>): Promise<void> {
  panel.stdin.write('\x1B')
  await new Promise<void>((resolve) => setTimeout(resolve, 120))
}

async function writeKey(panel: ReturnType<typeof render>, sequence: string): Promise<void> {
  await writeInput(panel, sequence)
}

async function waitForFrame(panel: ReturnType<typeof render>, pattern: RegExp): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (pattern.test(panel.lastFrame() ?? '')) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  assert.match(panel.lastFrame() ?? '', pattern)
}

test('ProviderPanel saves endpoint provider choices', async () => {
  const { config, cwd } = await createConfig()
  try {
    const panel = render(h(ProviderPanel, {
      config,
      onChange: () => {},
      onClose: () => {},
    }))

    await writeInput(panel, 'n')
    assert.match(panel.lastFrame() ?? '', /Provider\s+: anthropic/)
    await writeInput(panel, 'test-endpoint')
    await writeInput(panel, '\t')
    await writeInput(panel, '\x1B[C')
    assert.match(panel.lastFrame() ?? '', /‹ openai ›/)
    await writeInput(panel, '\r')
    await waitForFrame(panel, /Saved endpoint "test-endpoint"/)

    assert.deepEqual(config.get().endpoints?.['test-endpoint'], { provider: 'openai' })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('ProviderPanel requires models to reference an endpoint', async () => {
  const { config, cwd } = await createConfig()
  try {
    config.setEndpoint('shared', { provider: 'openai', baseUrl: 'https://example.test' })
    const panel = render(h(ProviderPanel, {
      config,
      onChange: () => {},
      onClose: () => {},
    }))

    await writeInput(panel, '\t')
    await writeInput(panel, 'n')
    assert.match(panel.lastFrame() ?? '', /Endpoint\s+: shared/)
    assert.match(panel.lastFrame() ?? '', /Provider\s+: openai\s+inherited from endpoint/)
    await writeInput(panel, 'endpoint-model')
    await writeInput(panel, '\t')
    await writeInput(panel, 'remote-id')
    await writeInput(panel, '\r')
    await waitForFrame(panel, /Saved model "endpoint-model"/)
    assert.deepEqual(config.get().models['endpoint-model'], {
      model: 'remote-id',
      endpoint: 'shared',
    })

    assert.doesNotMatch(panel.lastFrame() ?? '', /Direct/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('ProviderPanel marks unsupported and missing legacy references', async () => {
  const { config, cwd } = await createConfig()
  try {
    config.setEndpoint('legacy', { provider: 'custom' })
    config.setModelConfig('broken-model', { endpoint: 'missing-endpoint', model: 'id' })
    const panel = render(h(ProviderPanel, {
      config,
      onChange: () => {},
      onClose: () => {},
    }))

    await writeInput(panel, '\r')
    assert.match(panel.lastFrame() ?? '', /custom \(unsupported\)/)
    await writeInput(panel, '\r')
    assert.match(panel.lastFrame() ?? '', /Unsupported provider "custom"/)
    await writeEscape(panel)
    await writeInput(panel, '\t')
    await writeInput(panel, '\r')
    assert.match(panel.lastFrame() ?? '', /missing-endpoint \(missing\)/)
    await writeInput(panel, '\r')
    assert.match(panel.lastFrame() ?? '', /Unknown endpoint "missing-endpoint"/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('ProviderPanel requires an endpoint before creating a model', async () => {
  const { config, cwd } = await createConfig()
  try {
    const panel = render(h(ProviderPanel, {
      config,
      onChange: () => {},
      onClose: () => {},
    }))

    await writeInput(panel, '\t')
    await writeInput(panel, 'n')
    assert.match(panel.lastFrame() ?? '', /Create an endpoint before adding a model/)
    assert.doesNotMatch(panel.lastFrame() ?? '', /New model/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('the panel has exactly three sections; profiles is gone', async () => {
  const { config, cwd } = await createConfig()
  try {
    const panel = render(h(ProviderPanel, {
      config,
      onChange: () => {},
      onClose: () => {},
    }))

    const frame = panel.lastFrame() ?? ''
    assert.match(frame, /Endpoints/)
    assert.match(frame, /Models/)
    assert.match(frame, /Routing/)
    assert.doesNotMatch(frame, /Profiles/)

    // Three tabs, so three right-arrows return to the first.
    await writeKey(panel, '\x1B[C')
    assert.match(panel.lastFrame() ?? '', /\[Models\]/)
    await writeKey(panel, '\x1B[C')
    assert.match(panel.lastFrame() ?? '', /\[Routing\]/)
    await writeKey(panel, '\x1B[C')
    assert.match(panel.lastFrame() ?? '', /\[Endpoints\]/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('ProviderPanel uses spatial arrow navigation and Ctrl+S in endpoint forms', async () => {
  const { config, cwd } = await createConfig()
  try {
    const panel = render(h(ProviderPanel, {
      config,
      onChange: () => {},
      onClose: () => {},
    }))

    assert.match(panel.lastFrame() ?? '', /←\/→ to switch section/)
    await writeKey(panel, '\x1B[C')
    assert.match(panel.lastFrame() ?? '', /\[Models\]/)
    await writeKey(panel, '\x1B[D')
    assert.match(panel.lastFrame() ?? '', /\[Endpoints\]/)

    await writeInput(panel, 'n')
    assert.match(panel.lastFrame() ?? '', /> Name\s+:/)
    assert.match(panel.lastFrame() ?? '', /←\/→ to cursor/)
    await writeInput(panel, 'arrow-endpoint')
    await writeKey(panel, '\x1B[B')
    assert.match(panel.lastFrame() ?? '', /> Provider\s+:/)
    assert.match(panel.lastFrame() ?? '', /←\/→ to change/)
    await writeKey(panel, '\x1B[C')
    await writeKey(panel, '\x1B[B')
    assert.match(panel.lastFrame() ?? '', /> Base URL\s+:/)
    await writeInput(panel, 'https://example.test')
    await writeKey(panel, '\x1B[B')
    assert.match(panel.lastFrame() ?? '', /> API Key\s+:/)
    await writeInput(panel, 'secret')
    await writeInput(panel, '\x13')
    await waitForFrame(panel, /Saved endpoint "arrow-endpoint"/)

    assert.deepEqual(config.get().endpoints?.['arrow-endpoint'], {
      provider: 'openai',
      baseUrl: 'https://example.test',
      apiKey: 'secret',
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('ProviderPanel supports Shift+Tab reverse field navigation and bounded Up/Down', async () => {
  const { config, cwd } = await createConfig()
  try {
    const panel = render(h(ProviderPanel, {
      config,
      onChange: () => {},
      onClose: () => {},
    }))

    await writeInput(panel, 'n')
    await writeKey(panel, '\x1B[A')
    assert.match(panel.lastFrame() ?? '', /> Name\s+:/)
    await writeKey(panel, '\x1B[B')
    assert.match(panel.lastFrame() ?? '', /> Provider\s+:/)
    await writeKey(panel, '\x1B[Z')
    assert.match(panel.lastFrame() ?? '', /> Name\s+:/)
    await writeKey(panel, '\x1B[A')
    assert.match(panel.lastFrame() ?? '', /> Name\s+:/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('ProviderPanel edits models with arrow-first navigation', async () => {
  const { config, cwd } = await createConfig()
  try {
    config.setEndpoint('first-endpoint', { provider: 'anthropic' })
    config.setEndpoint('second-endpoint', { provider: 'openai' })
    config.setModelConfig('first-model', { model: 'first-id', endpoint: 'first-endpoint' })
    config.setModelConfig('second-model', { model: 'second-id', endpoint: 'second-endpoint' })
    const panel = render(h(ProviderPanel, {
      config,
      onChange: () => {},
      onClose: () => {},
    }))

    await writeKey(panel, '\x1B[C')
    await writeInput(panel, 'n')
    await writeInput(panel, 'arrow-model')
    await writeKey(panel, '\x1B[B')
    await writeInput(panel, 'remote-id')
    await writeKey(panel, '\x1B[B')
    assert.match(panel.lastFrame() ?? '', /> Endpoint\s+:/)
    await writeKey(panel, '\x1B[C')
    await writeInput(panel, '\r')
    await waitForFrame(panel, /Saved model "arrow-model"/)
    assert.deepEqual(config.get().models['arrow-model'], {
      model: 'remote-id',
      endpoint: 'second-endpoint',
    })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('ProviderPanel supports Home/End list jumps and both Routing axes', async () => {
  const { config, cwd } = await createConfig()
  try {
    config.setEndpoint('alpha', { provider: 'anthropic' })
    config.setEndpoint('beta', { provider: 'openai' })
    config.setModelConfig('model-a', { provider: 'openai', model: 'a' })
    config.setModelConfig('model-b', { provider: 'openai', model: 'b' })
    const panel = render(h(ProviderPanel, {
      config,
      onChange: () => {},
      onClose: () => {},
    }))

    await writeKey(panel, '\x1B[F')
    await writeInput(panel, 'e')
    assert.match(panel.lastFrame() ?? '', /Edit endpoint "beta"/)
    await writeEscape(panel)
    await writeKey(panel, '\x1B[H')
    await writeInput(panel, 'e')
    assert.match(panel.lastFrame() ?? '', /Edit endpoint "alpha"/)
    await writeEscape(panel)

    // Left from the first tab wraps to the last, which is Routing now that
    // Profiles is gone.
    await writeKey(panel, '\x1B[D')
    assert.match(panel.lastFrame() ?? '', /\[Routing\]/)
    await writeInput(panel, '\r')

    // The choices are the configured model keys plus inherit — never tiers.
    const options = panel.lastFrame() ?? ''
    assert.match(options, /inherit/)
    assert.match(options, /model-a/)
    assert.match(options, /model-b/)
    assert.doesNotMatch(options, /balanced|powerful/)

    // main starts at 'inherit' (index 0); Up wraps to the last model key.
    await writeKey(panel, '\x1B[A')
    await writeInput(panel, '\r')
    await waitForFrame(panel, /Routing main -> model-b/)
    assert.equal(config.getRouting().main, 'model-b')

    // Reopen on 'model-b' (index 2); Right wraps forward to 'inherit'.
    await writeInput(panel, '\r')
    await writeKey(panel, '\x1B[C')
    await writeInput(panel, '\r')
    await waitForFrame(panel, /Routing main -> inherit/)
    assert.equal(config.getRouting().main, 'inherit')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
