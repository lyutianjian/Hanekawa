import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import { ConfigService } from '../src/config/service.js'
import { resolveRuntimeModelKeyAfterConfigChange } from '../src/runtime/providerRuntime.js'
import { tmpdir } from 'node:os'
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

async function createConfig(): Promise<ConfigService> {
  const cwd = await mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-provider-runtime-'))
  const config = new ConfigService(cwd)
  await config.load()
  config.setModelConfig('fast-a', { provider: 'openai', model: 'fast-a' })
  config.setModelConfig('main-a', { provider: 'openai', model: 'main-a' })
  config.setModelConfig('main-b', { provider: 'anthropic', model: 'main-b' })
  config.setDefaultModel('main-a')
  config.setProfile('a', { fast: 'fast-a', balanced: 'main-a' })
  config.setProfile('b', { fast: 'fast-a', balanced: 'main-b' })
  config.setActiveProfile('a')
  return config
}

test('endpoint and model config changes keep the current model selected', async () => {
  const config = await createConfig()

  assert.equal(resolveRuntimeModelKeyAfterConfigChange(config, 'fast-a', 'endpoints'), 'fast-a')
  assert.equal(resolveRuntimeModelKeyAfterConfigChange(config, 'fast-a', 'models'), 'fast-a')
})

test('profile config changes immediately re-resolve the main runtime model', async () => {
  const config = await createConfig()
  config.setActiveProfile('b')

  assert.equal(resolveRuntimeModelKeyAfterConfigChange(config, 'main-a', 'profiles'), 'main-b')
})

test('routing config changes immediately re-resolve the main runtime model', async () => {
  const config = await createConfig()
  config.setRouting({ main: 'fast' })

  assert.equal(resolveRuntimeModelKeyAfterConfigChange(config, 'main-a', 'routing'), 'fast-a')
})

test('removing the selected model falls back to the configured main model', async () => {
  const config = await createConfig()
  config.setModelConfig('manual', { provider: 'openai', model: 'manual' })
  config.removeModel('manual')

  assert.equal(resolveRuntimeModelKeyAfterConfigChange(config, 'manual', 'models'), 'main-a')
})
