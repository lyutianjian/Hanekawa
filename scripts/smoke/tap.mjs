/**
 * The page-side tap, as a string evaluated once per launch.
 *
 * Lives in its own module so `app.mjs` stays readable and so this code can be
 * reviewed as what it is: a script that runs inside the app's renderer.
 *
 * Design constraints, both of which were arrived at the hard way:
 *
 * - **Project, never forward.** `session-event` fires once per streamed token
 *   and `snapshot` fires on every background-task output flush. Storing whole
 *   bodies overruns the ring buffer during a single turn, and every poll would
 *   ship megabytes back over CDP. Only rare, decision-carrying frames become
 *   entries; high-frequency ones update a small latest-value map in place.
 * - **Claim only `smoke-` replies.** The app's own command ids are UUIDs, and
 *   `PendingRequests.settle` returns false for ids it does not know rather than
 *   complaining — so the two senders coexist on one transport as long as the tap
 *   never swallows a reply the app is waiting for.
 *
 * No template literals below: this whole thing is embedded in one, and nesting
 * them is a needless escaping hazard.
 */

/** Mirrors `SHELL_LANE` in `src/desktop/shellProtocol.ts`. */
export const SHELL_LANE = '__shell'

export const TAP_SOURCE = `(() => {
  if (window.__smoke) return 'already'
  var s = {
    seq: 0,
    CAP: 600,
    events: [],
    replies: new Map(),
    /** Latest per-lane streaming state; updated in place, never an event. */
    state: {},
    /** Latest per-lane runtime snapshot fields. */
    runtime: {},
    /** Which session each lane is bound to. */
    session: {},
  }
  s.snapshotState = function () {
    return { state: s.state, runtime: s.runtime, session: s.session, seq: s.seq }
  }
  var push = function (entry) {
    entry.seq = ++s.seq
    entry.t = Date.now()
    s.events.push(entry)
    if (s.events.length > s.CAP) s.events.splice(0, s.events.length - s.CAP)
  }
  window.__smoke = s
  s.unsubscribe = window.hanekawa.onMessage(function (frame) {
    if (!frame || typeof frame !== 'object') return
    if (frame.kind === 'close') {
      push({ lane: frame.lane, type: 'lane-close' })
      return
    }
    if (frame.kind !== 'data' || !frame.body || typeof frame.body !== 'object') return
    var lane = frame.lane
    var body = frame.body
    var type = body.type
    if ((type === 'reply' || type === 'fail') && typeof body.id === 'string') {
      if (body.id.indexOf('smoke-') !== 0) return
      s.replies.set(
        body.id,
        type === 'reply' ? { ok: true, result: body.result } : { ok: false, message: body.message },
      )
      return
    }
    if (type === 'snapshot') {
      var snap = body.snapshot || {}
      s.state[lane] = { streaming: !!snap.isStreaming, spinner: snap.spinnerSubText || '' }
      return
    }
    if (type === 'background-tasks' || type === 'queued-messages' || type === 'command-effect') return
    if (type === 'session-event') {
      var kind = body.event && body.event.type
      if (kind === 'turn-start' || kind === 'turn-end') push({ lane: lane, type: 'turn', turn: kind })
      return
    }
    if (type === 'runtime-snapshot') {
      var r = body.snapshot || {}
      s.runtime[lane] = { modelKey: r.modelKey, effort: r.effort, permissionMode: r.permissionMode }
      push({ lane: lane, type: 'runtime-snapshot', modelKey: r.modelKey, effort: r.effort })
      return
    }
    if (type === 'session-changed') {
      var meta = body.session || {}
      s.session[lane] = { id: meta.id, title: meta.title, messageCount: meta.messageCount }
      push({ lane: lane, type: 'session-changed', sessionId: meta.id })
      return
    }
    if (type === 'ui-request') {
      var request = body.request || {}
      var payload = request.payload || {}
      push({
        lane: lane,
        type: 'ui-request',
        kind: request.kind,
        requestId: request.requestId,
        tool: payload.toolName,
      })
      return
    }
    if (type === 'lanes') {
      push({
        lane: lane,
        type: 'lanes',
        lanes: (body.lanes || []).map(function (info) {
          return { lane: info.lane, paneId: info.paneId, projectRoot: info.projectRoot, title: info.sessionTitle }
        }),
      })
      return
    }
    if (type === 'activate') {
      push({ lane: lane, type: 'activate', target: body.lane })
      return
    }
    if (type === 'pane-list') return
    push({ lane: lane, type: type })
  })
  return 'installed'
})()`
