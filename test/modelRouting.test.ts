import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ConfigService } from '../src/config/service.js'
import {
  DEFAULT_ROUTING,
  mergeRouting,
  parseTierInput,
  pickTier,
  resolveTier,
} from '../src/config/routing.js'

function tmpDir(): Promise<string> {
  return mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'myagent-routing-'))
}

async function writeConfig(dir: string, content: object): Promise<void> {
  await mkdir(path.join(dir, '.myagent'), { recursive: true })
  await writeFile(path.join(dir, '.myagent', 'config.json'), JSON.stringify(content))
}

test('resolveTier: fast falls back to balanced then powerful', () => {
  assert.equal(resolveTier({ powerful: 'p' }, 'fast'), 'p')
  assert.equal(resolveTier({ balanced: 'b', powerful: 'p' }, 'fast'), 'b')
  assert.equal(resolveTier({ fast: 'f', balanced: 'b' }, 'fast'), 'f')
})

test('resolveTier: balanced prefers powerful then fast', () => {
  assert.equal(resolveTier({ fast: 'f' }, 'balanced'), 'f')
  assert.equal(resolveTier({ powerful: 'p', fast: 'f' }, 'balanced'), 'p')
  assert.equal(resolveTier({ balanced: 'b', powerful: 'p' }, 'balanced'), 'b')
})

test('resolveTier: powerful prefers balanced then fast', () => {
  assert.equal(resolveTier({ fast: 'f' }, 'powerful'), 'f')
  assert.equal(resolveTier({ balanced: 'b', fast: 'f' }, 'powerful'), 'b')
  assert.equal(resolveTier({ powerful: 'p' }, 'powerful'), 'p')
})

test('resolveTier: empty profile returns undefined', () => {
  assert.equal(resolveTier({}, 'fast'), undefined)
  assert.equal(resolveTier(undefined, 'balanced'), undefined)
})

test('parseTierInput: accepts only Hanekawa tier names', () => {
  assert.equal(parseTierInput('fast'), 'fast')
  assert.equal(parseTierInput(' BALANCED '), 'balanced')
  assert.equal(parseTierInput('powerful'), 'powerful')
  assert.equal(parseTierInput('haiku'), undefined)
  assert.equal(parseTierInput('opus'), undefined)
  assert.equal(parseTierInput('inherit'), undefined)
})

test('mergeRouting: defaults applied when nothing provided', () => {
  const merged = mergeRouting()
  assert.equal(merged.main, DEFAULT_ROUTING.main)
  assert.equal(merged.plan, DEFAULT_ROUTING.plan)
  assert.equal(merged.compact, DEFAULT_ROUTING.compact)
  assert.equal(merged.subagent?.fork, 'inherit')
  assert.equal(merged.subagent?.explore, 'balanced')
})

test('mergeRouting: deep-merges subagent overrides', () => {
  const merged = mergeRouting(
    { subagent: { explore: 'powerful' } },
    { main: 'fast' },
  )
  assert.equal(merged.main, 'fast')
  assert.equal(merged.subagent?.explore, 'powerful')
  // Untouched defaults preserved.
  assert.equal(merged.subagent?.fork, 'inherit')
})

test('pickTier: subagent type override beats general fallback', () => {
  const routing = mergeRouting({
    subagent: { general: 'fast', explore: 'powerful' },
  })
  assert.equal(pickTier(routing, { kind: 'subagent', type: 'explore' }), 'powerful')
  assert.equal(pickTier(routing, { kind: 'subagent', type: 'unknown-custom' }), 'fast')
})

test('pickTier: subagent without general falls through to inherit', () => {
  const routing = mergeRouting({ subagent: { explore: 'fast' } })
  assert.equal(pickTier(routing, { kind: 'subagent', type: 'something-else' }), 'inherit')
})

test('ConfigService.resolveModel: legacy inline model still works', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        legacy: { provider: 'anthropic', model: 'claude-test', apiKey: 'sk', baseUrl: 'https://x' },
      },
      defaultModel: 'legacy',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    const resolved = cfg.resolveModel('legacy')
    assert.ok(resolved)
    assert.equal(resolved!.provider, 'anthropic')
    assert.equal(resolved!.model, 'claude-test')
    assert.equal(resolved!.apiKey, 'sk')
    assert.equal(resolved!.baseUrl, 'https://x')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModel: endpoint reference inlines provider/baseUrl/apiKey', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      endpoints: {
        deepseek: { provider: 'anthropic', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-d' },
      },
      models: {
        ds: { endpoint: 'deepseek', model: 'deepseek-v4-flash' },
      },
      defaultModel: 'ds',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    const resolved = cfg.resolveModel('ds')
    assert.ok(resolved)
    assert.equal(resolved!.provider, 'anthropic')
    assert.equal(resolved!.baseUrl, 'https://api.deepseek.com')
    assert.equal(resolved!.apiKey, 'sk-d')
    assert.equal(resolved!.model, 'deepseek-v4-flash')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModel: model fields override endpoint fields', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      endpoints: {
        e: { provider: 'anthropic', baseUrl: 'https://shared', apiKey: 'shared-key' },
      },
      models: {
        m: { endpoint: 'e', model: 'm', apiKey: 'override-key' },
      },
      defaultModel: 'm',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    const resolved = cfg.resolveModel('m')!
    assert.equal(resolved.apiKey, 'override-key')
    assert.equal(resolved.baseUrl, 'https://shared')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModel: missing endpoint reference returns undefined', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { m: { endpoint: 'missing', model: 'x' } },
      defaultModel: 'm',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.equal(cfg.resolveModel('m'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelKeyFor: uses active profile + tier routing', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        small: { provider: 'openai', model: 'small' },
        med: { provider: 'openai', model: 'med' },
        big: { provider: 'openai', model: 'big' },
      },
      profiles: {
        cn: { fast: 'small', balanced: 'med', powerful: 'big' },
      },
      activeProfile: 'cn',
      defaultModel: 'med',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    // Defaults: main=balanced, plan=powerful, compact=fast.
    assert.equal(cfg.resolveModelKeyFor({ kind: 'main' }, { currentModelKey: 'med' }), 'med')
    assert.equal(cfg.resolveModelKeyFor({ kind: 'plan' }, { currentModelKey: 'med' }), 'big')
    assert.equal(cfg.resolveModelKeyFor({ kind: 'compact' }, { currentModelKey: 'med' }), 'small')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelKeyFor: subagent fork inherits parent', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        small: { provider: 'openai', model: 'small' },
        med: { provider: 'openai', model: 'med' },
        big: { provider: 'openai', model: 'big' },
      },
      profiles: {
        cn: { fast: 'small', balanced: 'med', powerful: 'big' },
      },
      activeProfile: 'cn',
      defaultModel: 'med',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.equal(
      cfg.resolveModelKeyFor({ kind: 'subagent', type: 'fork' }, { currentModelKey: 'med' }),
      'med',
    )
    // explore default is balanced -> med
    assert.equal(
      cfg.resolveModelKeyFor({ kind: 'subagent', type: 'explore' }, { currentModelKey: 'med' }),
      'med',
    )
    // plan default is powerful -> big
    assert.equal(
      cfg.resolveModelKeyFor({ kind: 'subagent', type: 'plan' }, { currentModelKey: 'med' }),
      'big',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelKeyFor: tier fallback when profile has only powerful', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { only: { provider: 'openai', model: 'only' } },
      profiles: { p: { powerful: 'only' } },
      activeProfile: 'p',
      defaultModel: 'only',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    // compact wants fast, but only powerful is present; should pick powerful.
    assert.equal(cfg.resolveModelKeyFor({ kind: 'compact' }, { currentModelKey: 'only' }), 'only')
    // main wants balanced -> falls through powerful.
    assert.equal(cfg.resolveModelKeyFor({ kind: 'main' }, { currentModelKey: 'only' }), 'only')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelKeyFor: no profile -> falls back to currentModelKey/defaultModel', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { only: { provider: 'openai', model: 'only' } },
      defaultModel: 'only',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    // Without profiles, all roles should resolve to the inherit/default key.
    assert.equal(cfg.resolveModelKeyFor({ kind: 'main' }, { currentModelKey: 'only' }), 'only')
    assert.equal(cfg.resolveModelKeyFor({ kind: 'plan' }, { currentModelKey: 'only' }), 'only')
    assert.equal(cfg.resolveModelKeyFor({ kind: 'compact' }, { currentModelKey: 'only' }), 'only')
    assert.equal(
      cfg.resolveModelKeyFor({ kind: 'subagent', type: 'explore' }, { currentModelKey: 'only' }),
      'only',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelKeyFor: invalid current falls back to valid default', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { only: { provider: 'openai', model: 'only' } },
      defaultModel: 'only',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.equal(cfg.resolveModelKeyFor({ kind: 'plan' }, { currentModelKey: 'missing' }), 'only')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelInput: exact model keys and tiers resolve, inherit is rejected', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        fastModel: { provider: 'openai', model: 'fast' },
        main: { provider: 'openai', model: 'main' },
        power: { provider: 'openai', model: 'power' },
      },
      profiles: {
        p: { fast: 'fastModel', balanced: 'main', powerful: 'power' },
      },
      activeProfile: 'p',
      defaultModel: 'main',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.equal(cfg.resolveModelInput('main'), 'main')
    assert.equal(cfg.resolveModelInput('fast'), 'fastModel')
    assert.equal(cfg.resolveModelInput('powerful'), 'power')
    assert.equal(cfg.resolveModelInput('inherit'), undefined)
    assert.equal(cfg.resolveModelInput('sonnet'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelInput: exact model key wins over tier spelling', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        fast: { provider: 'openai', model: 'literal-fast' },
        routedFast: { provider: 'openai', model: 'routed-fast' },
        main: { provider: 'openai', model: 'main' },
      },
      profiles: { p: { fast: 'routedFast', balanced: 'main' } },
      activeProfile: 'p',
      defaultModel: 'main',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.equal(cfg.resolveModelInput('fast'), 'fast')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService model reference fields may use tiers', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        fastModel: { provider: 'openai', model: 'fast-id' },
        main: { provider: 'openai', model: 'main-id' },
        power: { provider: 'openai', model: 'power-id' },
      },
      profiles: {
        p: { fast: 'fastModel', balanced: 'main', powerful: 'power' },
      },
      activeProfile: 'p',
      defaultModel: 'balanced',
      fallbackModel: 'fast',
      compactModel: 'powerful',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()

    assert.equal(cfg.resolveModelReference(cfg.get().defaultModel), 'main')
    assert.equal(cfg.resolveModelReference(cfg.get().fallbackModel), 'fastModel')
    assert.equal(cfg.resolveModelReference(cfg.get().compactModel), 'power')
    assert.equal(cfg.getDefaultModel()?.model, 'main-id')
    assert.equal(cfg.getFallbackModel()?.model, 'fast-id')
    assert.equal(cfg.getCompactModel()?.model, 'power-id')
    assert.equal(cfg.resolveModelKeyFor({ kind: 'main' }, { currentModelKey: cfg.get().defaultModel }), 'main')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.resolveModelKeyFor: routing override beats default tier', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        small: { provider: 'openai', model: 's' },
        med: { provider: 'openai', model: 'm' },
        big: { provider: 'openai', model: 'b' },
      },
      profiles: { p: { fast: 'small', balanced: 'med', powerful: 'big' } },
      activeProfile: 'p',
      defaultModel: 'med',
      routing: {
        subagent: { explore: 'powerful' },
      },
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.equal(
      cfg.resolveModelKeyFor({ kind: 'subagent', type: 'explore' }, { currentModelKey: 'med' }),
      'big',
    )
    // Untouched defaults still apply.
    assert.equal(cfg.resolveModelKeyFor({ kind: 'compact' }, { currentModelKey: 'med' }), 'small')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService.getActiveProfile: returns single profile when activeProfile not set', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { x: { provider: 'openai', model: 'x' } },
      profiles: { only: { fast: 'x' } },
      defaultModel: 'x',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    const active = cfg.getActiveProfile()
    assert.ok(active)
    assert.equal(active!.name, 'only')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService write-back: setEndpoint + setModelConfig + setProfile persist', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { seed: { provider: 'anthropic', model: 'seed' } },
      defaultModel: 'seed',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    cfg.setEndpoint('e1', { provider: 'anthropic', baseUrl: 'https://x' })
    cfg.setModelConfig('m1', { endpoint: 'e1', model: 'm1' })
    cfg.setProfile('p1', { fast: 'm1' })
    cfg.setActiveProfile('p1')
    await cfg.save()

    const reloaded = new ConfigService(dir)
    await reloaded.load()
    assert.equal(reloaded.getEndpoint('e1')?.baseUrl, 'https://x')
    assert.equal(reloaded.resolveModel('m1')?.baseUrl, 'https://x')
    const active = reloaded.getActiveProfile()
    assert.equal(active?.name, 'p1')
    assert.equal(active?.profile.fast, 'm1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService write-back: removeEndpoint refuses while a model references it', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      endpoints: { e: { provider: 'anthropic', baseUrl: 'https://x' } },
      models: { m: { endpoint: 'e', model: 'm' } },
      defaultModel: 'm',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.throws(() => cfg.removeEndpoint('e'), /referenced by model "m"/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService write-back: removeModel refuses while a profile references it', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: {
        a: { provider: 'anthropic', model: 'a' },
        b: { provider: 'anthropic', model: 'b' },
      },
      profiles: { p: { fast: 'a', balanced: 'b' } },
      defaultModel: 'b',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.throws(() => cfg.removeModel('a'), /referenced by profile "p\.fast"/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService write-back: removeModel refuses removing the defaultModel', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { d: { provider: 'anthropic', model: 'd' } },
      defaultModel: 'd',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    assert.throws(() => cfg.removeModel('d'), /defaultModel/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService write-back: removeProfile clears activeProfile when it matches', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { x: { provider: 'openai', model: 'x' } },
      profiles: { p: { fast: 'x' } },
      activeProfile: 'p',
      defaultModel: 'x',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    cfg.removeProfile('p')
    assert.equal(cfg.get().activeProfile, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ConfigService write-back: setRouting persists deep-merged routing', async () => {
  const dir = await tmpDir()
  try {
    await writeConfig(dir, {
      models: { x: { provider: 'openai', model: 'x' } },
      defaultModel: 'x',
    })
    const cfg = new ConfigService(dir)
    await cfg.load()
    const before = cfg.getRouting()
    cfg.setRouting({ ...before, main: 'fast', subagent: { ...before.subagent, explore: 'powerful' } })
    await cfg.save()

    const reloaded = new ConfigService(dir)
    await reloaded.load()
    const after = reloaded.getRouting()
    assert.equal(after.main, 'fast')
    assert.equal(after.subagent?.explore, 'powerful')
    // Untouched defaults preserved through reload.
    assert.equal(after.subagent?.fork, 'inherit')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
