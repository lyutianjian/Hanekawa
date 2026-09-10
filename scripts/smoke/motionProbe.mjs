/**
 * Read-only instrumentation evaluated inside the real renderer.
 * The frame callback observes geometry and CSS progress; it never simulates
 * animation, dispatches completion events or mutates the app's state.
 */
export function installMotionProbe() {
  window.__motion?.dispose()
  const watches = new Map()
  const ids = new WeakMap()
  let nextId = 0
  let raf
  let label = 'idle'
  let recording = false
  let frames = []
  let events = []
  let wire = []
  let marks = []
  let streaming = false
  const id = (node) => {
    if (!node) return null
    if (!ids.has(node)) ids.set(node, ++nextId)
    return ids.get(node)
  }
  const round = (value) => Math.round(value * 100) / 100
  const pane = () => [...document.querySelector('#transcript-area').children].find((node) => !node.hidden)
  const root = (scope) => scope === 'pane' ? pane() : document
  const box = (node) => {
    if (!node) return null
    const rect = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    return {
      id: id(node), attached: node.isConnected, visible: node.getClientRects().length > 0,
      x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height),
      opacity: Number(style.opacity), transform: style.transform,
      cls: String(node.className), expanded: node.getAttribute('aria-expanded'),
      phase: [...node.classList].find((c) => /presence-(closed|entering|open|closing)$/.test(c)) ?? '',
      inert: node.inert, chars: node.textContent.length,
      ...(node.id === 'overlay' || node.id === 'rewind' ? { scrimOpacity: Number(getComputedStyle(node, '::before').opacity) } : {}),
    }
  }
  const locate = (watch) => {
    if (watch.fixed) return watch.node
    const found = root(watch.scope)?.querySelector(watch.selector)
    watch.node ??= found
    return found
  }
  const sample = (time) => {
    if (recording) {
      const active = pane()
      const scroll = active?.querySelector('.transcript')
      const rect = scroll?.getBoundingClientRect()
      const nodes = {}
      for (const [name, watch] of watches) {
        const current = locate(watch)
        nodes[name] = { ...box(watch.node), currentId: id(current) }
      }
      const visibleText = rect ? [...active.querySelectorAll('.item.user, .group-head, .step-head, .step-body, .md > p, .md pre')].filter((node) => {
        const r = node.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && r.bottom > rect.top && r.top < rect.bottom
          && node.textContent.length > 0 && getComputedStyle(node).opacity !== '0'
      }).length : 0
      frames.push({
        t: round(time), label, streaming, scroll: round(scroll?.scrollTop ?? 0),
        height: scroll?.clientHeight ?? 0, contentHeight: scroll?.scrollHeight ?? 0,
        viewport: rect ? { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) } : null,
        visibleText, focus: id(document.activeElement), nodes,
      })
    }
    raf = requestAnimationFrame(sample)
  }
  const cssEvent = (event) => {
    if (!recording) return
    events.push({
      t: round(performance.now()), label, type: event.type, id: id(event.target),
      target: event.target.id || String(event.target.className),
      name: event.animationName ?? event.propertyName, pseudo: event.pseudoElement,
    })
  }
  const types = ['animationstart', 'animationend', 'animationcancel', 'transitionrun', 'transitionend', 'transitioncancel']
  for (const type of types) document.addEventListener(type, cssEvent, true)
  // Distinguish a viewport correction from real wheel/pointer input during a
  // recording. Do not record typed text or key contents.
  const inputEvent = (event) => {
    if (recording) events.push({ t: round(performance.now()), label, type: event.type,
      x: round(event.clientX), y: round(event.clientY), deltaY: event.deltaY })
  }
  for (const type of ['wheel', 'pointerdown']) document.addEventListener(type, inputEvent, { capture: true, passive: true })
  const observer = new MutationObserver((mutations) => {
    if (!recording) return
    for (const mutation of mutations) for (const removed of mutation.removedNodes) {
      for (const [name, watch] of watches) if (watch.node && (removed === watch.node || removed.contains(watch.node))) {
        events.push({ t: round(performance.now()), label, type: 'detach', name, id: id(watch.node) })
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  const unsubscribe = window.hanekawa.onMessage((frame) => {
    if (frame.kind !== 'data') return
    const body = frame.body
    if (body.type === 'snapshot') streaming = body.snapshot.isStreaming === true
    if (!recording) return
    if (['snapshot', 'session-event', 'ui-request', 'reply', 'fail'].includes(body.type)) {
      wire.push({ t: round(performance.now()), label, type: body.type,
        kind: body.event?.type ?? body.request?.kind, id: body.id, streaming })
    }
  })
  const api = {
    watch(name, selector, scope = 'pane') {
      const watch = { selector, scope }
      watches.set(name, watch)
      locate(watch)
      return id(watch.node)
    },
    node(name) { return watches.get(name)?.node },
    hold(name, node) { watches.set(name, { node, fixed: true }); return id(node) },
    box(name) { return box(watches.get(name)?.node) },
    mark(next) { label = next; marks.push({ t: round(performance.now()), label }); performance.mark('motion:' + next) },
    start(next) {
      frames = []; events = []; wire = []; marks = []; watches.clear()
      recording = true
      api.mark(next)
    },
    stop() {
      recording = false
      return { timeOrigin: performance.timeOrigin, frames, events, wire, marks }
    },
    dispose() {
      recording = false
      cancelAnimationFrame(raf)
      observer.disconnect()
      unsubscribe()
      for (const type of types) document.removeEventListener(type, cssEvent, true)
      for (const type of ['wheel', 'pointerdown']) document.removeEventListener(type, inputEvent, true)
    },
  }
  window.__motion = api
  raf = requestAnimationFrame(sample)
  return {
    userAgent: navigator.userAgent, width: innerWidth, height: innerHeight,
    devicePixelRatio, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    screen: { width: screen.width, height: screen.height }, visibility: document.visibilityState,
    interpolateSize: CSS.supports('interpolate-size', 'allow-keywords'),
  }
}

const round = (value) => Math.round(value * 100) / 100
const range = (values) => values.length ? round(Math.max(...values) - Math.min(...values)) : 0
export function summarizeMotion(record) {
  const summaries = {}
  for (const label of new Set(record.frames.map((frame) => frame.label))) {
    const frames = record.frames.filter((frame) => frame.label === label)
    const deltas = frames.slice(1).map((frame, i) => frame.t - frames[i].t).sort((a, b) => a - b)
    const percentile = (fraction) => round(deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * fraction))] ?? 0)
    const targets = {}
    for (const name of new Set(frames.flatMap((frame) => Object.keys(frame.nodes)))) {
      const boxes = frames.map((frame) => frame.nodes[name]).filter((node) => node?.id)
      const visible = boxes.filter((node) => node.visible)
      targets[name] = {
        identities: [...new Set(boxes.map((node) => node.currentId).filter(Boolean))],
        detaches: record.events.filter((event) => event.label === label && event.type === 'detach' && event.name === name).length,
        xRange: range(visible.map((box) => box.x)), yRange: range(visible.map((box) => box.y)),
        widthRange: range(visible.map((box) => box.w)), heightRange: range(visible.map((box) => box.h)),
        distinctHeights: new Set(visible.map((box) => box.h)).size,
        distinctOpacity: new Set(visible.map((box) => box.opacity)).size,
        first: boxes[0], last: boxes.at(-1),
      }
    }
    const starts = {}
    for (const event of record.events.filter((event) => event.label === label && ['animationstart', 'transitionrun'].includes(event.type))) {
      const key = event.target + ':' + event.name
      starts[key] = (starts[key] ?? 0) + 1
    }
    summaries[label] = {
      frames: frames.length, medianMs: percentile(0.5), p95Ms: percentile(0.95), maxMs: percentile(1),
      deliveredFps: frames.length > 1 ? round((frames.length - 1) * 1000 / (frames.at(-1).t - frames[0].t)) : 0,
      blankSamples: frames.filter((frame) => frame.visibleText === 0).length,
      scrollRange: range(frames.map((frame) => frame.scroll)),
      maxScrollStep: round(Math.max(0, ...frames.slice(1).map((frame, i) => Math.abs(frame.scroll - frames[i].scroll)))),
      targets, starts,
    }
  }
  return summaries
}
