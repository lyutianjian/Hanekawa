#!/usr/bin/env node
/**
 * Stage 4f: the desktop smoke run.
 *
 * Launches the real Electron app against a scratch project, drives it over CDP,
 * asserts the ten acceptance items of stage 4, writes screenshots for the parts
 * only a human can judge, and exits non-zero when something is wrong.
 *
 * **Why this file is tracked.** Stage 3j drove the app exactly this way with a
 * throwaway script and kept only prose about it. Stage 4 then had to rediscover
 * the same four CDP rules (see `smoke/cdp.mjs`) and the same Windows process
 * handling, and would have paid a third time. A smoke driver is test
 * infrastructure; the reason it kept getting thrown away is that it does not fit
 * in `npm test`, not that it is disposable.
 *
 * **It is not part of `npm test` and must not become part of it.** It needs a
 * display, a real endpoint and real credentials; `npm test` is hermetic and
 * offline, and that is worth more than the coverage this adds.
 *
 * Safety, by construction rather than by care:
 *
 * - the app is always pointed at a **scratch project in the OS temp directory**
 *   (`--cwd=`), seeded from `~/.myagent/config.json`, so the repository's own
 *   `.myagent/` — real sessions, real API keys — is never the project the app can
 *   delete sessions from or rewrite config in;
 * - four **tripwires** assert afterwards that the repo's session index, the repo's
 *   session files, `~/.myagent/config.json` and `~/.myagent/settings.json` were
 *   never written;
 * - **money is opt-in**: one model turn, only with `--paid-turn`, behind a
 *   one-shot latch, on the cheapest configured model, interrupted if it overruns.
 *
 * Exit codes: 0 pass (skips allowed), 1 an assertion failed — the app is wrong,
 * 2 preflight or teardown failed — do not trust the run at all.
 *
 * Usage:
 *   node scripts/smoke-desktop.mjs [--paid-turn] [--only=S3,S8] [--keep]
 *                                  [--model=<key>] [--port=9222] [--kill-stale]
 *                                  [--config=<path>] [--out=<dir>] [--verbose]
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as app from './smoke/app.mjs'
import { shot, sleep } from './smoke/cdp.mjs'
import {
  assertTripwires,
  captureTripwires,
  makeProject,
  makeRunDir,
  removeRunDir,
  seedArtifacts,
  seedLocalSettings,
  seedSession,
} from './smoke/fixtures.mjs'
import { RESTART_STEPS, STEPS } from './smoke/steps.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

const opts = parseArgs(process.argv.slice(2))
process.exitCode = await main()

function parseArgs(argv) {
  const flags = {
    paidTurn: false,
    keep: false,
    killStale: false,
    verbose: false,
    port: 9222,
    model: 'step-3.5-flash',
    paidPrompt: 'Write about 150 words on why a smoke test should be committed. No tools, no questions.',
    paidTurnTimeout: 45000,
    only: undefined,
    out: undefined,
    config: undefined,
  }
  for (const arg of argv) {
    if (arg === '--paid-turn') flags.paidTurn = true
    else if (arg === '--keep') flags.keep = true
    else if (arg === '--kill-stale') flags.killStale = true
    else if (arg === '--verbose') flags.verbose = true
    else if (arg.startsWith('--only=')) flags.only = new Set(arg.slice('--only='.length).split(',').filter(Boolean))
    else if (arg.startsWith('--out=')) flags.out = arg.slice('--out='.length)
    else if (arg.startsWith('--config=')) flags.config = arg.slice('--config='.length)
    else if (arg.startsWith('--model=')) flags.model = arg.slice('--model='.length)
    else if (arg.startsWith('--paid-prompt=')) flags.paidPrompt = arg.slice('--paid-prompt='.length)
    else if (arg.startsWith('--paid-turn-timeout=')) flags.paidTurnTimeout = Number(arg.slice('--paid-turn-timeout='.length))
    else if (arg.startsWith('--port=')) flags.port = Number(arg.slice('--port='.length))
    else throw new Error(`unknown flag ${arg}`)
  }
  return flags
}

/**
 * Refuses to run against a stale bundle.
 *
 * A smoke run measuring yesterday's `dist/` is worse than no smoke run: it
 * reports on code that is not the code under review, and every conclusion drawn
 * from it is wrong in a way nothing else will catch.
 *
 * Compiled output and copied assets are checked differently on purpose.
 * `copy-desktop-assets.mjs` uses `copyFileSync`, and on Windows that preserves
 * the source's timestamps — so a copied `index.html` is never newer than the
 * `src/` file it came from, and folding it into one "newest source vs oldest
 * output" comparison makes the guard fire on every run.
 */
function assertFreshBuild() {
  const compiled = [
    join(repoRoot, 'dist', 'desktop', 'main.js'),
    join(repoRoot, 'dist', 'desktop', 'preload.js'),
    join(repoRoot, 'dist', 'desktop', 'renderer', 'app.js'),
  ]
  const assets = [
    ['src/desktop/renderer/index.html', 'dist/desktop/renderer/index.html'],
    ['src/desktop/renderer/styles.css', 'dist/desktop/renderer/styles.css'],
  ]
  const missing = [...compiled, ...assets.map(([, to]) => join(repoRoot, to))].filter((path) => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(`no desktop build at ${missing[0]}; run: npm run build:desktop`)
  }
  const built = Math.min(...compiled.map((path) => statSync(path).mtimeMs))
  let newest = 0
  let newestPath = ''
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name)) {
        const mtime = statSync(path).mtimeMs
        if (mtime > newest) {
          newest = mtime
          newestPath = path
        }
      }
    }
  }
  walk(join(repoRoot, 'src'))
  if (newest > built) {
    throw new Error(`${newestPath} is newer than dist/; run: npm run build:desktop`)
  }
  for (const [from, to] of assets) {
    if (statSync(join(repoRoot, from)).mtimeMs > statSync(join(repoRoot, to)).mtimeMs) {
      throw new Error(`${from} has not been copied into dist/; run: npm run build:desktop`)
    }
  }
}

async function main() {
  const started = Date.now()
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const out = opts.out ? opts.out : join(repoRoot, '.smoke', stamp)
  mkdirSync(out, { recursive: true })
  const pidFile = join(repoRoot, '.smoke', 'electron.pid')

  const results = []
  let runDir
  let handle
  let teardownNote = ''
  const tripwires = captureTripwires(repoRoot)

  try {
    assertFreshBuild()
    const preflight = app.preflightProcesses({ port: opts.port, pidFile, killStale: opts.killStale })
    for (const note of preflight.notes) console.log(`preflight: ${note}`)

    // --- fixtures ------------------------------------------------------------
    runDir = makeRunDir()
    console.log(`scratch: ${runDir}`)
    const projectA = makeProject(runDir, 'projA', opts.config ? { configFrom: opts.config } : {})
    const projectB = makeProject(runDir, 'projB', opts.config ? { configFrom: opts.config } : {})
    // `ask: ['Write']` makes the permission prompt deterministic whatever the
    // gate's default for a `confirm` tool is, and it is a *local* entry, so the
    // "only local entries" assertion in the settings step still means something.
    seedLocalSettings(projectA, { permissions: { ask: ['Write'] } })
    seedLocalSettings(projectB, { permissions: { ask: ['Write'] } })
    // Newest first: A1 is what the app bootstraps by itself.
    const sessionsA = Array.from({ length: 8 }, (_, index) =>
      seedSession(projectA, { marker: `SMOKE-A${index + 1} fixture session`, ageMinutes: index + 1 }),
    )
    const sessionsB = Array.from({ length: 2 }, (_, index) =>
      seedSession(projectB, { marker: `SMOKE-B${index + 1} fixture session`, ageMinutes: index + 1 }),
    )
    for (const session of [...sessionsA, ...sessionsB]) seedArtifacts(projectA, session.id)
    for (const session of sessionsB) seedArtifacts(projectB, session.id)

    // --- launch #1 -----------------------------------------------------------
    handle = app.launch({ repoRoot, cwd: projectA.root, port: opts.port, out, tag: '1', pidFile })
    console.log(`launched electron pid ${handle.pid} on port ${opts.port}`)
    await app.attach(handle)
    console.log('attached; the window is up')

    const ctx = makeContext({ handle, out, projectA, projectB, sessionsA, sessionsB, runDir })
    await runSteps(STEPS, ctx, results)

    // --- restart -------------------------------------------------------------
    if (shouldRun(RESTART_STEPS)) {
      teardownNote = await app.quitGracefully(handle)
      console.log(`launch 1 teardown: ${teardownNote}`)
      await sleep(1200)
      handle = app.launch({ repoRoot, cwd: projectA.root, port: opts.port, out, tag: '2', pidFile })
      await app.attach(handle)
      const restartCtx = makeContext({ handle, out, projectA, projectB, sessionsA, sessionsB, runDir, ctx })
      await runSteps(RESTART_STEPS, restartCtx, results)
    }

    const finalTeardown = await app.quitGracefully(handle)
    console.log(`final teardown: ${finalTeardown}`)

    // --- item 10 + the tripwires --------------------------------------------
    const leftovers = app.electronPids().filter((pid) => !preflight.baseline.includes(pid))
    results.push({
      id: 'S10',
      item: 10,
      name: 'no leftover electron processes',
      ok: leftovers.length === 0 && !existsSync(pidFile),
      ms: 0,
      assertions: [
        { ok: leftovers.length === 0, label: 'no electron process outside the baseline', detail: leftovers.join(', ') },
        { ok: !existsSync(pidFile), label: 'the pidfile is gone', detail: pidFile },
        {
          ok: finalTeardown !== 'killed',
          label: 'the app quit gracefully (before-quit drained lanes and projects)',
          detail: `teardown: ${finalTeardown}${teardownNote ? `, first launch: ${teardownNote}` : ''}`,
        },
      ],
      shots: [],
      notes: finalTeardown === 'killed' ? ['had to kill the app: before-quit did not finish in time'] : [],
    })
    assertTripwires(repoRoot, tripwires)
  } catch (error) {
    console.error(`\nFATAL: ${error instanceof Error ? error.stack : String(error)}`)
    if (handle) {
      try {
        await app.quitGracefully(handle, { timeout: 4000 })
      } catch {
        // Nothing left to do; the cleanup handler kills the tree.
      }
    }
    writeSummary({ out, results, started, fatal: error instanceof Error ? error.message : String(error), runDir })
    if (runDir && !opts.keep) removeRunDir(runDir)
    return 2
  }

  const rendererFailures = handle?.exceptions ?? []
  const summary = writeSummary({ out, results, started, renderer: rendererFailures, runDir })
  if (!opts.keep && runDir) removeRunDir(runDir)
  else if (runDir) console.log(`kept scratch dir: ${runDir}`)
  return summary.failed > 0 || rendererFailures.length > 0 ? 1 : 0
}

function shouldRun(steps) {
  return steps.some((step) => !opts.only || opts.only.has(step.id))
}

/**
 * The per-step context.
 *
 * `ok`/`eq` record rather than throw: one broken item should not hide the other
 * nine, which is the whole reason the steps are independent. A step may still
 * throw for an *infrastructure* failure — a command that never answered — and
 * the harness records that as the step failing.
 */
function makeContext({ handle, out, projectA, projectB, sessionsA, sessionsB, runDir, ctx }) {
  const state = ctx?.state ?? { lanesSeen: new Set(), paidTurnSpent: false, deleted: new Set() }
  const context = {
    app: handle,
    get cdp() {
      return handle.cdp
    },
    out,
    opts,
    projectA,
    projectB,
    sessionsA,
    sessionsB,
    runDir,
    state,
    current: undefined,
    ok(label, condition, detail = '') {
      context.current.assertions.push({ ok: Boolean(condition), label, detail: String(detail) })
      return Boolean(condition)
    },
    eq(label, actual, expected) {
      const ok = JSON.stringify(actual) === JSON.stringify(expected)
      context.current.assertions.push({
        ok,
        label,
        detail: ok ? String(actual) : `expected ${JSON.stringify(expected)}, saw ${JSON.stringify(actual)}`,
      })
      return ok
    },
    skip(label, why) {
      context.current.notes.push(`SKIP ${label}: ${why}`)
    },
    note(text) {
      context.current.notes.push(text)
      if (opts.verbose) console.log(`    ${text}`)
    },
    /** A screenshot plus what a reviewer should look at in it. */
    async shot(name, look) {
      const file = join(out, `${name}.png`)
      await shot(handle.cdp, file)
      context.current.shots.push({ name, look })
      return file
    },
  }
  return context
}

async function runSteps(steps, ctx, results) {
  for (const step of steps) {
    if (opts.only && !opts.only.has(step.id)) continue
    const record = { id: step.id, item: step.item, name: step.name, assertions: [], shots: [], notes: [], ms: 0 }
    ctx.current = record
    const started = Date.now()
    process.stdout.write(`  ${step.id} ${step.name} … `)
    try {
      if (step.paid && !opts.paidTurn) {
        record.skipped = true
        record.notes.push('skipped: pass --paid-turn to run the one model turn this needs')
        console.log('SKIP')
        results.push(record)
        continue
      }
      await withTimeout(step.run(ctx), step.timeout, `${step.id} ${step.name}`)
    } catch (error) {
      record.assertions.push({
        ok: false,
        label: 'the step ran to completion',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    record.ms = Date.now() - started
    record.ok = record.assertions.length > 0 && record.assertions.every((assertion) => assertion.ok)
    console.log(`${record.ok ? 'PASS' : 'FAIL'} (${(record.ms / 1000).toFixed(1)}s, ${record.assertions.length} assertions)`)
    for (const assertion of record.assertions) {
      if (!assertion.ok) console.log(`      ✗ ${assertion.label}${assertion.detail ? ` — ${assertion.detail}` : ''}`)
      else if (opts.verbose) console.log(`      ✓ ${assertion.label}`)
    }
    results.push(record)
    // A blocked main process makes every later step a slow timeout, so this is
    // the one failure that aborts the run instead of being recorded.
    await app.liveness(ctx.app)
  }
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its ${ms}ms budget`)), ms)
    }),
  ])
}

function writeSummary({ out, results, started, renderer = [], fatal, runDir }) {
  const passed = results.filter((step) => step.ok && !step.skipped).length
  const failed = results.filter((step) => step.ok === false && !step.skipped).length
  const skipped = results.filter((step) => step.skipped).length
  const lines = []
  lines.push(`Hanekawa desktop smoke — ${new Date().toISOString()}`)
  lines.push(`${passed} passed, ${failed} failed, ${skipped} skipped in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  if (fatal) lines.push(`FATAL: ${fatal}`)
  lines.push('')
  for (const step of results) {
    const verdict = step.skipped ? 'SKIP' : step.ok ? 'PASS' : 'FAIL'
    lines.push(`${verdict} ${step.id} item ${step.item} ${step.name} (${(step.ms / 1000).toFixed(1)}s, ${step.assertions.length} assertions)`)
    for (const assertion of step.assertions) {
      if (!assertion.ok) lines.push(`   ✗ ${assertion.label}${assertion.detail ? ` — ${assertion.detail}` : ''}`)
    }
    for (const note of step.notes) lines.push(`   · ${note}`)
  }
  if (renderer.length > 0) {
    lines.push('')
    lines.push('RENDERER EXCEPTIONS (a thrown app is a smoke failure even if every assertion passed):')
    for (const text of renderer) lines.push(`   ! ${text}`)
  }
  const shots = results.flatMap((step) => step.shots.map((entry) => ({ ...entry, step: step.id })))
  if (shots.length > 0) {
    lines.push('')
    lines.push('SCREENSHOTS — these are the judgements no assertion can make:')
    for (const entry of shots) lines.push(`   ${entry.name}.png (${entry.step}) — ${entry.look}`)
  }
  lines.push('')
  lines.push(`output: ${out}`)
  if (runDir) lines.push(`scratch: ${runDir}${opts.keep ? ' (kept)' : ' (removed)'}`)
  const text = `${lines.join('\n')}\n`
  writeFileSync(join(out, 'summary.txt'), text)
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ results, renderer, fatal }, null, 2)}\n`)
  console.log(`\n${text}`)
  return { passed, failed, skipped }
}
