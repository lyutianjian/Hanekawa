#!/usr/bin/env node
/** Compact, reproducible evidence from smoke:motion output. Run after recording,
 * never concurrently: screenshot encoding would contaminate frame timings.
 * node scripts/smoke/motionEvidence.mjs <output-dir> <run-dir> [<run-dir> ...]
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { summarizeMotion } from './motionProbe.mjs'

const [destination, ...sources] = process.argv.slice(2)
if (!destination || !sources.length) throw new Error('Expected output directory and one or more motion run directories')
const out = resolve(destination)
mkdirSync(out, { recursive: true })
const json = (path) => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
const compressed = (path) => JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'))
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const round = (n) => Math.round(n * 100) / 100
const bounds = (node) => node && Object.fromEntries(['id', 'attached', 'visible', 'x', 'y', 'w', 'h', 'phase', 'opacity', 'transform', 'inert'].map((key) => [key, node[key]]))
const compact = (summary) => ({ ...summary, targets: Object.fromEntries(Object.entries(summary.targets).map(([name, target]) => [name,
  { ...target, first: bounds(target.first), last: bounds(target.last) }])) })
const profiles = []
const loaded = []
for (const source of sources) {
  const report = json(join(source, 'report.json'))
  if (report.fatal || report.checks.some((c) => !c.ok) || report.cleanup.some((s) => s.includes('ERROR'))) throw new Error('Run did not pass: ' + source)
  const display = json(join(source, 'display.json'))
  if (report.dpi === 'native' && (display.restoredScalePercent !== display.originalScalePercent || display.restoredHz !== display.originalHz)) throw new Error('Display restoration was not verified: ' + source)
  const profile = { id: basename(source), generatedAt: report.generatedAt, theme: report.theme, scale: report.scale,
    dpi: report.dpi ?? 'chromium', environment: report.environment, display, checks: report.checks, cleanup: report.cleanup, scenes: {} }
  const scenes = {}
  for (const scene of Object.keys(report.scenes)) {
    const framePath = join(source, scene + '-frames.json.gz')
    const tracePath = join(source, scene + '-trace.json.gz')
    const record = compressed(framePath)
    const trace = compressed(tracePath)
    const capturePath = join(source, scene + '-capture.json.gz')
    const capture = existsSync(capturePath) ? compressed(capturePath) : undefined
    const pictures = capture ? capture.frames.map((f) => ({ ts: (f.timestamp * 1000 - capture.timeOrigin) * 1000, args: { snapshot: f.jpeg } }))
      : trace.traceEvents.filter((e) => e.name === 'Screenshot' && e.args?.snapshot)
    const turnEnd = record.wire.findLast((e) => e.kind === 'turn-end')?.t
    if (capture && scene === 'stream' && (turnEnd === undefined || pictures.at(-1).ts / 1000 < turnEnd)) throw new Error('Continuous capture ended before turn-end: ' + source)
    const gaps = pictures.slice(1).map((p, i) => (p.ts - pictures[i].ts) / 1000)
    const phases = Object.fromEntries(Object.entries(summarizeMotion(record)).map(([label, summary]) => [label, compact(summary)]))
    const frames = record.frames.filter((f) => scene !== 'stream' || (f.streaming && f.nodes.group?.id))
    const total = summarizeMotion({ ...record, frames: frames.map((f) => ({ ...f, label: 'all' })), events: record.events.map((e) => ({ ...e, label: 'all' })) }).all
    const counts = (type) => {
      const result = {}
      for (const event of record.events.filter((e) => e.type === type)) result[event.name] = (result[event.name] ?? 0) + 1
      return result
    }
    profile.scenes[scene] = { total: total && compact(total), phases, animationStarts: counts('animationstart'),
      transitionStarts: counts('transitionrun'), screenshots: pictures.length, screenshotSource: capture ? 'CDP screencast' : 'trace filmstrip', screenshotMaxGapMs: round(Math.max(0, ...gaps)),
      hashes: { frames: hash(framePath), trace: hash(tracePath), ...(capture ? { capture: hash(capturePath) } : {}) },
      ...(capture ? { captureEndMs: round(pictures.at(-1).ts / 1000), turnEndMs: turnEnd } : {}) }
    let offset
    for (const mark of record.marks) {
      const event = trace.traceEvents.find((e) => e.name === 'motion:' + mark.label)
      if (event) { offset = event.ts - mark.t * 1000; break }
    }
    scenes[scene] = { record, pictures, offset: capture ? 0 : offset }
  }
  profiles.push(profile)
  loaded.push({ source, profile, scenes })
}
writeFileSync(join(out, 'measurements.json'), JSON.stringify({
  method: 'Real Electron; delivered rAF geometry, CSS events, CDP trace screenshots. Stream totals start when a live group exists. Structural blank samples are not a physical-display-frame guarantee.',
  profiles,
}, null, 2) + '\n')

const labelSvg = (text, width, height) => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><rect width="100%" height="100%" fill="#242322"/><text x="12" y="23" font-family="Arial,sans-serif" font-size="15" fill="#f2efe9">' + text.replaceAll('&', '&amp;').replaceAll('<', '&lt;') + '</text></svg>')
const at = (scene, label, delay) => {
  const mark = scene.record.marks.find((m) => m.label === label)
  if (!mark || scene.offset === undefined) throw new Error('Missing trace/phase alignment: ' + label)
  const wanted = scene.offset + (mark.t + delay) * 1000
  const picture = scene.pictures.reduce((a, b) => Math.abs(b.ts - wanted) < Math.abs(a.ts - wanted) ? b : a)
  if (Math.abs(picture.ts - wanted) > 120000) throw new Error('No nearby screenshot for ' + label + ': filmstrip may be truncated')
  return picture
}
for (const run of loaded) {
  const picks = [
    ['stream', 'thought-noop', 600], ['stream', 'stream-menu', 600], ['still', 'turn end / selection retained', 0],
    ['disclosure', 'detail-close-settle', 140], ['disclosure', 'detail-open', 350], ['layout', 'sidebar-close', 80],
    ['layout', 'menu-reverse', 130], ['permission', 'permission-allow-enter', 250], ['permission', 'permission-deny-exit', 180],
    ['modal', 'modal-exit', 100], ['settings', 'toggle-save', 80], ['reduced', 'reduce-mid-entrance', 100],
  ]
  const width = 640, height = 400, caption = 34
  const layers = []
  for (const [i, [name, label, delay]] of picks.entries()) {
    const picture = name === 'still' ? undefined : at(run.scenes[name], label, delay)
    const source = picture ? Buffer.from(picture.args.snapshot, 'base64') : join(run.source, 'stream-reading.png')
    const buffer = await sharp(source).resize(width, height).toBuffer()
    const left = i % 3 * width, top = Math.floor(i / 3) * (height + caption)
    layers.push({ input: buffer, left, top: top + caption })
    layers.push({ input: labelSvg(label + (name === 'still' ? '' : ' +' + delay + 'ms'), width, caption), left, top })
  }
  await sharp({ create: { width: width * 3, height: (height + caption) * 4, channels: 3, background: '#242322' } })
    .composite(layers).jpeg({ quality: 85 }).toFile(join(out, run.profile.id + '-contact.jpg'))
  copyFileSync(join(run.source, 'stream-reading.png'), join(out, run.profile.id + '-reading.png'))
}

// Sample at most 12.5 fps, without interpolation or slowed playback. Retained
// frames hold until the next retained trace timestamp; the final hold is 100ms.
// The encoder normalizes 10ms to 100ms, so request that hold explicitly.
const preview = loaded[0]
const previews = []
for (const name of ['stream', 'disclosure', 'layout', 'permission', 'modal', 'settings']) {
  const scene = preview.scenes[name]
  if (name === 'stream' && !existsSync(join(preview.source, 'stream-capture.json.gz'))) throw new Error('Choose a first run with complete stream-capture.json.gz for the long preview')
  const selected = []
  for (const picture of scene.pictures) {
    if (!selected.length || picture.ts - selected.at(-1).ts >= 80000) selected.push(picture)
  }
  const last = scene.pictures.at(-1)
  if (selected.at(-1) !== last) {
    if (last.ts - selected.at(-1).ts < 80000) selected[selected.length - 1] = last
    else selected.push(last)
  }
  const width = 800, height = 500
  const buffers = []
  for (const picture of selected) buffers.push(await sharp(Buffer.from(picture.args.snapshot, 'base64')).resize(width, height).removeAlpha().raw().toBuffer())
  const delays = selected.map((p, i) => i + 1 < selected.length ? Math.round((selected[i + 1].ts - p.ts) / 1000) : 100)
  const file = name + '.webp'
  await sharp(Buffer.concat(buffers), { raw: { width, height: height * selected.length, channels: 3, pageHeight: height } })
    .webp({ quality: 76, effort: 3, loop: 0, delay: delays }).toFile(join(out, file))
  // WebP can merge identical sampled frames; index the file that was written.
  const encoded = await sharp(join(out, file), { animated: true }).metadata()
  previews.push({ scene: name, profile: preview.profile.id, file, frames: encoded.pages, durationMs: encoded.delay.reduce((a, b) => a + b, 0), width, height })
}
writeFileSync(join(out, 'previews.json'), JSON.stringify({ method: 'At most 12.5 fps, original trace timestamp delays, no slow motion or interpolated frames; final hold 100ms.', previews }, null, 2) + '\n')
writeFileSync(join(out, 'viewer-data.js'), 'window.motionEvidence = ' + JSON.stringify({
  profiles: profiles.map((p) => ({ id: p.id, theme: p.theme, scale: p.scale, hz: p.display.measuredHz, dpi: p.dpi })),
  previews,
}) + ';\n')
console.log('Wrote evidence to ' + out)
