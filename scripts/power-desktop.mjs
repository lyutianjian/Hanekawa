#!/usr/bin/env node
/**
 * Desktop energy benchmark: the same offline turn, replayed, with the CPU time
 * each Electron process spent on it.
 *
 * npm run build:desktop
 * node scripts/power-desktop.mjs --runs=3 --out=.smoke/power-after
 *
 * The turn is `smoke/motionFixture.mjs`'s: thinking, TaskCreate/TaskUpdate,
 * Read/Glob, then a long Markdown answer with code, maths and a table — real
 * SSE through the provider, loop, tools and bridge, so only the build differs
 * between two runs of this script. Every run launches a fresh app on a fresh
 * session, so later runs do not inherit a longer transcript.
 *
 * CPU seconds come from `ps` (user + system) sampled at the turn's two edges and
 * after an idle tail; CPU time is the energy proxy macOS itself builds Energy
 * Impact from. The window must stay visible and uncovered: an occluded window
 * stops compositing, and the numbers stop meaning anything. macOS/Linux only;
 * like smoke:desktop, it needs a display and runs outside npm test.
 *
 * `--profile` also records the renderer during the turn and prints where its
 * main thread went (trace events) and the hottest JS functions (self time).
 * Profiling costs CPU itself: never compare its numbers with a plain run's.
 * `--reduced-motion` stops every looping animation, to price them alone.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as app from './smoke/app.mjs'
import * as fixtures from './smoke/fixtures.mjs'
import { sleep } from './smoke/cdp.mjs'
import { startMotionFixture } from './smoke/motionFixture.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  if (arg === '--keep') return ['keep', true]
  if (arg === '--profile') return ['profile', true]
  if (arg === '--reduced-motion') return ['reducedMotion', true]
  const match = /^--(runs|out|port|theme|idle)=(.+)$/.exec(arg)
  if (!match) throw new Error('unknown argument: ' + arg)
  return [match[1], match[2]]
}))
const runs = Number(args.runs ?? 3)
const idleSeconds = Number(args.idle ?? 15)
const theme = args.theme ?? 'dark'
const port = Number(args.port ?? 9238)
if (!existsSync(join(repoRoot, 'dist/desktop/main.js'))) throw new Error('run npm run build:desktop first')

/** CPU seconds per role for every process under `root`. */
function cpuByRole(root) {
  const { stdout } = spawnSync('ps', ['-axo', 'pid=,ppid=,time=,command='], { encoding: 'utf8' })
  const rows = stdout.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)).filter(Boolean)
  const tree = new Set([root])
  for (let grew = true; grew;) {
    grew = false
    for (const [, pid, ppid] of rows) if (tree.has(Number(ppid)) && !tree.has(Number(pid))) { tree.add(Number(pid)); grew = true }
  }
  const totals = { main: 0, renderer: 0, gpu: 0, other: 0 }
  for (const [, pid, , time, command] of rows) {
    if (!tree.has(Number(pid))) continue
    const seconds = time.split(/[:-]/).reduce((sum, part) => sum * 60 + Number(part), 0)
    const role = Number(pid) === root ? 'main' : /--type=renderer/.test(command) ? 'renderer' : /--type=gpu/.test(command) ? 'gpu' : 'other'
    totals[role] += seconds
  }
  return totals
}

const delta = (after, before) => Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]))

async function once(index, environment, project, fixture, out) {
  const handle = app.launch({ repoRoot, cwd: project.root, port, out, tag: 'power-' + index,
    pidFile: join(out, 'power-electron.pid'), environment })
  try {
    await app.attach(handle)
    await handle.cdp.send('Emulation.setEmulatedMedia', { features: [
      { name: 'prefers-color-scheme', value: theme },
      // A diagnostic: how much of the cost is the looping animations alone.
      ...(args.reducedMotion ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : []),
    ] })
    // Launch work settles before anything is counted.
    await sleep(5000)
    const { lanes } = await app.shell(handle, { type: 'panes' })
    fixture.arm()
    if (args.profile) await startProfile(handle.cdp)
    const start = { at: Date.now(), cpu: cpuByRole(handle.pid) }
    const id = await app.post(handle, lanes[0].lane, { type: 'submit', input: 'Power benchmark: the fixed motion turn.' })
    await app.reply(handle, id, { timeout: 180000, label: 'the benchmark turn' })
    const end = { at: Date.now(), cpu: cpuByRole(handle.pid) }
    if (args.profile) await stopProfile(handle.cdp, out)
    await sleep(idleSeconds * 1000)
    const idle = { at: Date.now(), cpu: cpuByRole(handle.pid) }
    return {
      turn: { seconds: (end.at - start.at) / 1000, cpu: delta(end.cpu, start.cpu) },
      idle: { seconds: (idle.at - end.at) / 1000, cpu: delta(idle.cpu, end.cpu) },
    }
  } finally {
    await app.quitGracefully(handle).catch(() => {})
    await app.ensureStopped(handle).catch(() => {})
  }
}

async function startProfile(cdp) {
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
  await cdp.send('Profiler.start')
  profileTrace = new Promise((resolve) => {
    const remove = cdp.on('Tracing.tracingComplete', (event) => { remove(); resolve(event.stream) })
  })
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline,v8.execute,blink,cc,gpu,viz',
    transferMode: 'ReturnAsStream',
  })
}
let profileTrace

async function stopProfile(cdp, out) {
  const { profile } = await cdp.send('Profiler.stop')
  await cdp.send('Tracing.end')
  const stream = await profileTrace
  const chunks = []
  for (;;) {
    const result = await cdp.send('IO.read', { handle: stream, size: 1 << 20 })
    chunks.push(Buffer.from(result.data, result.base64Encoded ? 'base64' : 'utf8'))
    if (result.eof) break
  }
  await cdp.send('IO.close', { handle: stream })
  const events = JSON.parse(Buffer.concat(chunks).toString('utf8')).traceEvents
  writeFileSync(join(out, 'profile.cpuprofile'), JSON.stringify(profile))
  // The renderer's main thread: the thread its `RunTask`s with `FunctionCall`s live on.
  const threads = new Map()
  for (const event of events) if (event.name === 'FunctionCall') threads.set(event.pid + ':' + event.tid, (threads.get(event.pid + ':' + event.tid) ?? 0) + 1)
  const main = [...threads].sort((a, b) => b[1] - a[1])[0]?.[0]
  const byName = new Map()
  const perThread = new Map()
  for (const event of events) {
    if (event.ph !== 'X' || !event.dur) continue
    const thread = event.pid + ':' + event.tid
    if (event.name === 'ThreadControllerImpl::RunTask' || event.name === 'RunTask') perThread.set(thread, (perThread.get(thread) ?? 0) + event.dur)
    if (thread !== main) continue
    byName.set(event.name, (byName.get(event.name) ?? 0) + event.dur)
  }
  console.log('renderer main thread, inclusive ms by event:')
  for (const [name, dur] of [...byName].sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log('  ' + (dur / 1000).toFixed(0).padStart(7) + '  ' + name)
  const threadNames = new Map(events.filter((e) => e.name === 'thread_name').map((e) => [e.pid + ':' + e.tid, e.args.name]))
  console.log('busiest threads (RunTask ms):')
  for (const [thread, dur] of [...perThread].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log('  ' + (dur / 1000).toFixed(0).padStart(7) + '  ' + (threadNames.get(thread) ?? thread))
  const self = new Map()
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const interval = (profile.endTime - profile.startTime) / Math.max(1, profile.samples.length)
  for (const id of profile.samples) {
    const frame = byId.get(id).callFrame
    const key = (frame.functionName || '(anonymous)') + ' ' + frame.url.split('/').slice(-2).join('/') + ':' + (frame.lineNumber + 1)
    self.set(key, (self.get(key) ?? 0) + interval)
  }
  console.log('hottest JS by self ms:')
  for (const [key, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log('  ' + (us / 1000).toFixed(0).padStart(7) + '  ' + key)
}

const percent = (phase) => Object.fromEntries(Object.entries(phase.cpu).map(([role, seconds]) => [role, +(100 * seconds / phase.seconds).toFixed(1)]))
function mean(list) {
  const roles = Object.keys(list[0])
  return Object.fromEntries(roles.map((role) => [role, +(list.reduce((sum, item) => sum + item[role], 0) / list.length).toFixed(2)]))
}

const tripwires = fixtures.captureTripwires(repoRoot)
const environment = fixtures.createSmokeEnvironment({ keep: Boolean(args.keep), copyConfig: false })
const out = resolve(args.out ?? join(environment.root, 'output'))
mkdirSync(out, { recursive: true })
const report = { generatedAt: new Date().toISOString(), repoRoot, theme, runs: [] }
let fixture
try {
  app.preflightProcesses({ port, pidFile: join(out, 'power-electron.pid'), killStale: false })
  const project = fixtures.makeProject(environment.root, 'power-benchmark', environment.home)
  fixtures.seedLocalSettings(project, { permissions: { allow: ['Read', 'Glob', 'TaskCreate', 'TaskUpdate'] } })
  // About 75 chunks a second, 6k characters of answer: a fast OpenAI-style stream
  // rather than the motion check's deliberately slow one.
  fixture = await startMotionFixture(project, { pace: 0.3, chunk: 0.4, paragraphs: 80 })
  writeFileSync(fixtures.globalConfigPath(environment.home), JSON.stringify(fixture.config, null, 2) + '\n', { mode: 0o600 })
  writeFileSync(join(environment.home, '.myagent', 'projects.json'), JSON.stringify({ projects: [project.root] }) + '\n')
  for (let index = 0; index < runs; index++) {
    const run = await once(index, environment, project, fixture, out)
    report.runs.push(run)
    console.log(`run ${index + 1}: turn ${run.turn.seconds.toFixed(1)}s cpu% ${JSON.stringify(percent(run.turn))} | idle cpu% ${JSON.stringify(percent(run.idle))}`)
  }
  report.turnCpuSeconds = mean(report.runs.map((run) => run.turn.cpu))
  report.turnCpuPercent = mean(report.runs.map((run) => percent(run.turn)))
  report.idleCpuPercent = mean(report.runs.map((run) => percent(run.idle)))
  console.log('MEAN turn cpu-seconds ' + JSON.stringify(report.turnCpuSeconds))
  console.log('MEAN turn cpu% ' + JSON.stringify(report.turnCpuPercent))
  console.log('MEAN idle cpu% ' + JSON.stringify(report.idleCpuPercent))
} catch (error) {
  report.fatal = error.stack ?? String(error)
  console.error(report.fatal)
  process.exitCode = 1
} finally {
  if (fixture) await fixture.close().catch(() => {})
  try { fixtures.assertTripwires(repoRoot, tripwires) } catch (error) { console.error('tripwires: ' + error); process.exitCode = 2 }
  if (args.out) writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
  const failure = environment.cleanup()
  if (failure) { console.error('scratch not removed: ' + failure); process.exitCode = 2 }
}
