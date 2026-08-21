import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ConfigService } from '../src/config/service.js'

/**
 * The settings screen's writes, against a real `ConfigService` and a real
 * directory.
 *
 * `test/desktopShellHost.test.ts` proves the shell calls `save()` before
 * `reloadSettings()` using a recorder. This file is the other half: that the
 * mutation plus that `save()` actually survives a fresh `load()`. A recorder
 * cannot show that, and the ordering bug it guards against is a *data-loss*
 * bug — `reloadSettings` ends in `config.load()`, which re-reads the layers off
 * disk and discards anything unsaved.
 *
 * `globalConfigPath: null` throughout: without it these would read the
 * developer's own `~/.myagent/config.json` and the assertions would depend on
 * whose machine ran them.
 */

async function withProject(
  run: (cwd: string, config: ConfigService) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-settings-'))
  try {
    await mkdir(path.join(cwd, '.myagent'), { recursive: true })
    const config = new ConfigService(cwd, { globalConfigPath: null })
    await config.load()
    await run(cwd, config)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

/** A second service over the same directory — what the next launch would see. */
async function reload(cwd: string): Promise<ConfigService> {
  const config = new ConfigService(cwd, { globalConfigPath: null })
  await config.load()
  return config
}

test('an endpoint written through the screen survives a fresh load', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', {
      provider: 'anthropic',
      baseUrl: 'https://api.example',
      apiKey: 'sk-abcdefghijkl',
    })
    await config.save()

    const reloaded = await reload(cwd)
    assert.deepEqual(reloaded.getEndpoint('main'), {
      provider: 'anthropic',
      baseUrl: 'https://api.example',
      apiKey: 'sk-abcdefghijkl',
    })
  })
})

test('without save() the edit is gone on the next load — the ordering bug, demonstrated', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', { provider: 'anthropic' })
    // No save(). This is precisely what `reloadSettings()` does to an unsaved
    // mutation, since it ends in `config.load()`.
    await config.load()
    assert.equal(config.getEndpoint('main'), undefined, 'load() discarded the unsaved edit')

    const reloaded = await reload(cwd)
    assert.equal(reloaded.getEndpoint('main'), undefined)
  })
})

test('getSaveTarget names the file that actually changes', async () => {
  await withProject(async (cwd, config) => {
    const target = config.getSaveTarget()
    config.setModelConfig('big', { model: 'claude-big', endpoint: 'main' })
    await config.save()

    const written = JSON.parse(await readFile(target, 'utf8')) as { models: Record<string, unknown> }
    assert.ok(written.models.big, 'the screen reports the path it really wrote')
  })
})

test('a model and its routing survive the round trip', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', { provider: 'anthropic', apiKey: 'sk-abcdefghijkl' })
    config.setModelConfig('big', { model: 'claude-big', endpoint: 'main', contextWindow: 200_000 })
    config.setRouting({ ...config.getRouting(), main: 'big' })
    config.setDefaultModel('big')
    await config.save()

    const reloaded = await reload(cwd)
    assert.equal(reloaded.getModel('big')?.contextWindow, 200_000)
    assert.equal(reloaded.getRouting().main, 'big')
    assert.equal(reloaded.get().defaultModel, 'big')
  })
})

test('renameModel carries the routing reference with it, on disk', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', { provider: 'anthropic' })
    config.setModelConfig('big', { model: 'claude-big', endpoint: 'main' })
    config.setRouting({ ...config.getRouting(), main: 'big' })
    await config.save()

    config.renameModel('big', 'huge')
    await config.save()

    const reloaded = await reload(cwd)
    assert.equal(reloaded.getModel('big'), undefined)
    assert.equal(reloaded.getModel('huge')?.model, 'claude-big')
    assert.equal(
      reloaded.getRouting().main,
      'huge',
      'a rename that left routing behind would silently degrade the role to inherit',
    )
  })
})

test('removeModel refuses a key routing still points at, and writes nothing', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', { provider: 'anthropic' })
    config.setModelConfig('big', { model: 'claude-big', endpoint: 'main' })
    config.setRouting({ ...config.getRouting(), main: 'big' })
    await config.save()

    assert.throws(() => config.removeModel('big'))

    const reloaded = await reload(cwd)
    assert.ok(reloaded.getModel('big'), 'the rejected removal left the config alone')
  })
})

test('removeEndpoint refuses one a model still references', async () => {
  await withProject(async (_cwd, config) => {
    config.setEndpoint('main', { provider: 'anthropic' })
    config.setModelConfig('big', { model: 'claude-big', endpoint: 'main' })
    assert.throws(() => config.removeEndpoint('main'))
  })
})

test('clearing an endpoint key really removes it from disk', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', { provider: 'anthropic', apiKey: 'sk-abcdefghijkl' })
    await config.save()

    // What `clear-endpoint-key` does: rewrite the endpoint without the key.
    config.setEndpoint('main', { provider: 'anthropic' })
    await config.save()

    const raw = await readFile(config.getSaveTarget(), 'utf8')
    assert.ok(!raw.includes('sk-abcdefghijkl'), 'the key is gone from the file, not just the object')
    const reloaded = await reload(cwd)
    assert.equal(reloaded.getEndpoint('main')?.apiKey, undefined)
  })
})

test('a routing value naming a model that no longer exists degrades to inherit', async () => {
  await withProject(async (cwd, config) => {
    config.setEndpoint('main', { provider: 'anthropic' })
    config.setModelConfig('big', { model: 'claude-big', endpoint: 'main' })
    config.setRouting({ ...config.getRouting(), plan: 'ghost' })
    await config.save()

    const reloaded = await reload(cwd)
    // The stored value is kept as written; resolution is what degrades, which
    // is what makes deleting a model a recoverable mistake rather than a crash.
    assert.equal(reloaded.resolveModelKeyFor({ kind: 'plan' }, { currentModelKey: 'big' }), 'big')
  })
})
