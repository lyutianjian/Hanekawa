import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { migrateProjectConfig } from '../src/config/migrateProjectConfig.js'
import { ConfigService } from '../src/config/service.js'
import type { Config } from '../src/config/service.js'

/**
 * `config.json` used to be two layers with the project one on top. It is one
 * global file now, so a project that still has its own has to be folded into it
 * — otherwise the endpoints and models a user configured per repo simply stop
 * existing on the next launch.
 *
 * A fresh home per test: the migration *writes* `~/.myagent/config.json`.
 */
beforeEach(() => {
  const testHome = mkdtempSync(path.join(tmpdir(), 'myagent-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
})

async function project(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'myagent-migrate-'))
  await mkdir(path.join(dir, '.myagent'), { recursive: true })
  return dir
}

function globalPath(): string {
  return path.join(process.env.USERPROFILE!, '.myagent', 'config.json')
}

async function writeConfig(file: string, config: Partial<Config>): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(config), 'utf8')
}

async function readConfig(file: string): Promise<Partial<Config>> {
  return JSON.parse(await readFile(file, 'utf8')) as Partial<Config>
}

test('a project config is merged into the global one and archived', async () => {
  const dir = await project()
  try {
    await writeConfig(globalPath(), {
      endpoints: { shared: { provider: 'anthropic', baseUrl: 'https://shared' } },
      models: { keep: { provider: 'anthropic', model: 'claude-keep' } },
      defaultModel: 'keep',
    })
    await writeConfig(path.join(dir, '.myagent', 'config.json'), {
      endpoints: { own: { provider: 'anthropic', baseUrl: 'https://own' } },
      models: { mine: { model: 'claude-mine', endpoint: 'own' } },
    })

    const findings = await migrateProjectConfig(dir)

    const merged = await readConfig(globalPath())
    assert.deepEqual(Object.keys(merged.endpoints ?? {}).sort(), ['own', 'shared'])
    assert.deepEqual(Object.keys(merged.models ?? {}).sort(), ['keep', 'mine'])
    assert.equal(merged.defaultModel, 'keep', 'a key the project did not name is left alone')

    assert.equal(existsSync(path.join(dir, '.myagent', 'config.json')), false)
    assert.equal(existsSync(path.join(dir, '.myagent', 'config.migrated.json')), true)
    assert.ok(findings.some((line) => line.includes('config.migrated.json')))

    // What the next launch actually sees.
    const service = new ConfigService(dir)
    await service.load()
    assert.equal(service.getModel('mine')?.baseUrl, 'https://own')
    assert.equal(service.getModel('keep')?.model, 'claude-keep')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the project value wins a name collision — nothing resolves differently after', async () => {
  const dir = await project()
  try {
    await writeConfig(globalPath(), {
      endpoints: { api: { provider: 'anthropic', baseUrl: 'https://global' } },
      models: { big: { model: 'claude-global', endpoint: 'api' } },
      defaultModel: 'big',
      routing: { main: 'big' },
    })
    await writeConfig(path.join(dir, '.myagent', 'config.json'), {
      endpoints: { api: { provider: 'anthropic', baseUrl: 'https://project' } },
      models: { big: { model: 'claude-project', endpoint: 'api' } },
      defaultModel: 'big',
      routing: { plan: 'big' },
    })

    const findings = await migrateProjectConfig(dir)

    const merged = await readConfig(globalPath())
    assert.equal(merged.endpoints?.api?.baseUrl, 'https://project')
    assert.equal(merged.models?.big?.model, 'claude-project')
    assert.equal(merged.routing?.main, 'big', 'a role only the global file set survives')
    assert.equal(merged.routing?.plan, 'big')
    assert.ok(
      findings.some((line) => line.includes('replaced the global')),
      'an overwrite is reported, since it is the one thing a user has to check',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('every launch after the first is a no-op, and no archive is overwritten', async () => {
  const dir = await project()
  try {
    await writeConfig(path.join(dir, '.myagent', 'config.json'), {
      models: { mine: { provider: 'anthropic', model: 'claude-mine' } },
    })
    await migrateProjectConfig(dir)
    assert.deepEqual(await migrateProjectConfig(dir), [], 'the next launch has nothing to move')

    // Somebody restores a config.json into the project afterwards — a backup, a
    // git checkout. It migrates too, and the first archive survives it.
    await writeConfig(path.join(dir, '.myagent', 'config.json'), {
      models: { later: { provider: 'anthropic', model: 'claude-later' } },
    })
    await migrateProjectConfig(dir)

    const first = await readConfig(path.join(dir, '.myagent', 'config.migrated.json'))
    assert.deepEqual(Object.keys(first.models ?? {}), ['mine'])
    const second = await readConfig(path.join(dir, '.myagent', 'config.migrated.2.json'))
    assert.deepEqual(Object.keys(second.models ?? {}), ['later'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the global workspace has nothing to migrate — its cwd is the home directory', async () => {
  const home = process.env.USERPROFILE!
  await writeConfig(globalPath(), {
    models: { only: { provider: 'anthropic', model: 'claude-only' } },
  })

  assert.deepEqual(await migrateProjectConfig(home), [])
  const kept = await readConfig(globalPath())
  assert.deepEqual(Object.keys(kept.models ?? {}), ['only'], 'the one file is untouched')
  assert.equal(existsSync(path.join(home, '.myagent', 'config.migrated.json')), false)
})

test('a project without a config.json is left alone', async () => {
  const dir = await project()
  try {
    assert.deepEqual(await migrateProjectConfig(dir), [])
    assert.equal(existsSync(globalPath()), false, 'nothing is written for nothing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failure is reported, not thrown — a bad config must not stop the app', async () => {
  const dir = await project()
  try {
    await writeFile(path.join(dir, '.myagent', 'config.json'), '{ not json', 'utf8')

    const findings = await migrateProjectConfig(dir, {
      // A directory where the file has to go: the write cannot succeed.
      globalPath: path.join(dir, '.myagent'),
    })

    assert.equal(findings.length, 1)
    assert.match(findings[0]!, /Could not migrate/)
    assert.equal(
      existsSync(path.join(dir, '.myagent', 'config.json')),
      true,
      'the project file stays put when the migration did not happen',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
