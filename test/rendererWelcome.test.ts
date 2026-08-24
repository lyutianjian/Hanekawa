import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WELCOME_CARD_ORDER,
  WELCOME_CARD_TITLES,
  WELCOME_LOCAL_LABEL,
  WELCOME_PROJECT_FALLBACK,
  WELCOME_TITLE_AFTER,
  WELCOME_TITLE_BEFORE,
  createWelcomeState,
  isTranscriptEmpty,
  welcomeRenderSignature,
  welcomeView,
  type WelcomeState,
} from '../src/desktop/renderer/model/welcome.js'
import type { TranscriptItem, TranscriptItemKind, TranscriptState } from '../src/desktop/renderer/model/transcript.js'

/**
 * The empty-state screen's model.
 *
 * The load-bearing case is「只有启动通知」: a fresh draft already carries `notice`
 * items, so a naive `items.length === 0` would mean this screen never appeared at
 * all. That is the assertion the rest of 5c hangs off.
 */

function item(kind: TranscriptItemKind, id: string = kind): TranscriptItem {
  return { id, kind, text: 'x' }
}

function transcript(overrides: Partial<TranscriptState> = {}): TranscriptState {
  return { items: [], generation: 0, toolProgress: undefined, isThinking: false, ...overrides }
}

function stateWith(overrides: Partial<WelcomeState> = {}): WelcomeState {
  return createWelcomeState({ projectName: 'Hanekawa-main', canSwitchWorkspace: true, ...overrides })
}

// --- constants ---------------------------------------------------------------

test('the constants are the agreed values', () => {
  assert.equal(WELCOME_TITLE_BEFORE, '你想让我们在 ')
  assert.equal(WELCOME_TITLE_AFTER, ' 中构建什么？')
  assert.equal(WELCOME_PROJECT_FALLBACK, '当前项目')
  assert.equal(WELCOME_LOCAL_LABEL, '本地')
  assert.deepEqual(WELCOME_CARD_TITLES, {
    explore: '探索并理解代码',
    build: '构建新功能、应用或工具',
    review: '审查代码并提出修改建议',
  })
})

// --- emptiness ---------------------------------------------------------------

test('a transcript with nothing in it is empty', () => {
  assert.equal(isTranscriptEmpty(transcript()), true)
  assert.equal(welcomeView(stateWith()).visible, true)
})

test('startup notices do not count as a conversation', () => {
  // The whole feature depends on this: `paneSession.start()` folds every startup
  // notice into the transcript before the first paint.
  const state = transcript({ items: [item('notice', 'n1'), item('error', 'e1')] })
  assert.equal(isTranscriptEmpty(state), true)
  assert.equal(welcomeView(stateWith({ transcript: state })).visible, true)
})

test('one message of either side ends the empty state', () => {
  assert.equal(isTranscriptEmpty(transcript({ items: [item('user')] })), false)
  assert.equal(isTranscriptEmpty(transcript({ items: [item('assistant')] })), false)
  assert.equal(welcomeView(stateWith({ transcript: transcript({ items: [item('user')] }) })).visible, false)
})

test('a turn that has started hides the screen even before an item lands', () => {
  assert.equal(isTranscriptEmpty(transcript({ toolProgress: 'Reading file' })), false)
  assert.equal(isTranscriptEmpty(transcript({ isThinking: true })), false)
})

test('every transcript item kind is classified, and only two are not conversation', () => {
  // Typed as the union, so a new `TranscriptItemKind` is a compile error here
  // rather than an item kind that silently keeps the Hero on screen.
  const verdicts: ReadonlyArray<[TranscriptItemKind, boolean]> = [
    ['user', false],
    ['assistant', false],
    ['thinking', false],
    ['tool', false],
    ['subagent', false],
    ['duration', false],
    ['notice', true],
    ['error', true],
  ]
  for (const [kind, stillEmpty] of verdicts) {
    assert.equal(isTranscriptEmpty(transcript({ items: [item(kind)] })), stillEmpty, kind)
  }
})

// --- the hero ----------------------------------------------------------------

test('the hero names the project, and falls back before hello answers', () => {
  assert.equal(welcomeView(stateWith()).projectLabel, 'Hanekawa-main')
  assert.equal(welcomeView(stateWith({ projectName: undefined })).projectLabel, WELCOME_PROJECT_FALLBACK)
})

test('the project name is only a control when both halves are there', () => {
  assert.equal(welcomeView(stateWith()).projectSwitchable, true)
  assert.equal(welcomeView(stateWith({ canSwitchWorkspace: false })).projectSwitchable, false)
  assert.equal(welcomeView(stateWith({ projectName: undefined })).projectSwitchable, false)
})

// --- cards and pills ---------------------------------------------------------

test('the three cards are in the agreed order with an icon each', () => {
  const cards = welcomeView(stateWith()).cards
  assert.deepEqual(cards.map((card) => card.kind), [...WELCOME_CARD_ORDER])
  assert.deepEqual(cards.map((card) => card.kind), ['explore', 'build', 'review'])
  assert.deepEqual(cards.map((card) => card.title), WELCOME_CARD_ORDER.map((k) => WELCOME_CARD_TITLES[k]))
  assert.equal(new Set(cards.map((card) => card.icon)).size, 3)
})

test('the branch pill is absent, not blank, outside a repository', () => {
  const view = welcomeView(stateWith({ branch: undefined }))
  assert.deepEqual(view.pills.map((pill) => pill.kind), ['project', 'local'])
})

test('a known branch adds a third pill carrying its name', () => {
  const view = welcomeView(stateWith({ branch: 'master' }))
  assert.deepEqual(view.pills.map((pill) => pill.kind), ['project', 'local', 'branch'])
  assert.equal(view.pills[2]?.label, 'master')
  assert.equal(view.pills[0]?.label, 'Hanekawa-main')
  assert.equal(view.pills[1]?.label, WELCOME_LOCAL_LABEL)
})

// --- the render signature ----------------------------------------------------

const of = (state: WelcomeState): string => welcomeRenderSignature(welcomeView(state))

test('the same state signs the same way', () => {
  assert.equal(of(stateWith({ branch: 'master' })), of(stateWith({ branch: 'master' })))
})

test('everything the DOM draws moves the signature', () => {
  const reference = of(stateWith({ branch: 'master' }))
  const mutations: ReadonlyArray<[string, WelcomeState]> = [
    ['visible', stateWith({ branch: 'master', transcript: transcript({ items: [item('user')] }) })],
    ['project label', stateWith({ branch: 'master', projectName: 'other' })],
    ['switchable', stateWith({ branch: 'master', canSwitchWorkspace: false })],
    ['branch', stateWith({ branch: 'topic' })],
    ['branch absent', stateWith({ branch: undefined })],
  ]
  for (const [what, state] of mutations) {
    assert.notEqual(of(state), reference, what)
  }
})

test('a notice arriving while the screen is up does not move the signature', () => {
  // The converse half: this view repaints from the pane's per-token transcript
  // paint, so anything it does not draw has to be invisible to the guard.
  const before = of(stateWith({ branch: 'master' }))
  const after = of(stateWith({
    branch: 'master',
    transcript: transcript({ items: [item('notice', 'n1'), item('notice', 'n2')] }),
  }))
  assert.equal(after, before)
})
