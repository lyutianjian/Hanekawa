import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  IMAGE_PRESENTABLE_ERROR_REASONS,
  describeImageBlockError,
  formatImageFailure,
  imageBlockReasonOf,
  imageErrorCopy,
} from '../src/media/imageErrors.js'
import { TurnImageBlockError } from '../src/harness/turnImages.js'
import { IMAGE_INPUT_ERROR_REASONS } from '../src/media/types.js'

/**
 * Session S24: every image failure reaches both shells as a distinguishable
 * reason with a way out, and nothing else is relabelled as an image problem.
 */

test('every input reason plus the store reason has distinct copy with an exit', () => {
  assert.deepEqual(
    [...IMAGE_PRESENTABLE_ERROR_REASONS].sort(),
    [...IMAGE_INPUT_ERROR_REASONS, 'store-write-failed'].sort(),
  )
  const labels = new Set<string>()
  const actions = new Set<string>()
  for (const reason of IMAGE_PRESENTABLE_ERROR_REASONS) {
    const copy = imageErrorCopy(reason)
    assert.ok(copy, `${reason} has no copy`)
    assert.ok(copy.label.length > 0)
    // The actionable exit the design asks for: switch model / remove / crop /
    // convert / re-attach / retry. A label alone is not an exit.
    assert.ok(copy.action.length > 0, `${reason} has no action`)
    labels.add(copy.label)
    actions.add(copy.action)
  }
  assert.equal(labels.size, IMAGE_PRESENTABLE_ERROR_REASONS.length)
  assert.equal(actions.size, IMAGE_PRESENTABLE_ERROR_REASONS.length)
})

test('the model-not-capable exit names the model switch, and the size exits name crop/remove', () => {
  assert.match(imageErrorCopy('model-not-capable')!.action, /\/model/)
  assert.match(imageErrorCopy('image-too-large')!.action, /裁剪/)
  assert.match(imageErrorCopy('too-many-images')!.action, /移除/)
  assert.match(imageErrorCopy('unsupported-format')!.action, /PNG|JPEG/)
})

test('formatImageFailure keeps the detecting layer facts and adds the exit', () => {
  const line = formatImageFailure('unsupported-format', 'photo.heic is a HEIC image, which is not supported.')
  assert.ok(line.includes('photo.heic'), line)
  assert.ok(line.startsWith(imageErrorCopy('unsupported-format')!.label), line)
  assert.ok(line.endsWith(imageErrorCopy('unsupported-format')!.action), line)
})

test('a reason this module does not own keeps its own words, unlabelled', () => {
  // `@`-mention-only reasons, and anything a future layer adds: better an
  // unlabelled fact than a class the failure does not belong to.
  assert.equal(formatImageFailure('outside-project', 'x is outside the project.'), 'x is outside the project.')
  assert.equal(imageErrorCopy('outside-project'), undefined)
})

test('imageBlockReasonOf reads a thrown TurnImageBlockError structurally', () => {
  const error = new TurnImageBlockError('too-many-images', [], 'This request carries 12 image blocks.')
  assert.equal(imageBlockReasonOf(error), 'too-many-images')
  // Structural, not instanceof: the same failure crosses the protocol as a
  // plain object, and the renderer may not value-import `harness/`.
  assert.equal(imageBlockReasonOf({ imageInputBlock: 'file-missing' }), 'file-missing')
  assert.equal(imageBlockReasonOf({ imageInputBlock: 'not-a-reason' }), undefined)
  assert.equal(imageBlockReasonOf(new Error('boom')), undefined)
  assert.equal(imageBlockReasonOf(undefined), undefined)
})

test('describeImageBlockError appends the exit to a block and leaves HTTP errors alone', () => {
  const blocked = new TurnImageBlockError(
    'model-not-capable',
    [],
    'Model gpt-4 does not accept image input, but this input carries 1 image.',
  )
  const described = describeImageBlockError(blocked)
  assert.ok(described.startsWith(blocked.message), described)
  assert.ok(described.endsWith(imageErrorCopy('model-not-capable')!.action), described)

  // Design §13, work item 4: an endpoint's own 400 stays exactly what it was,
  // *including* one whose text mentions images — the classification is the
  // thrown reason, never a substring of the message. Claiming an image reason
  // for a config or server failure would be a lie about what happened.
  const http = Object.assign(new Error('400 invalid_request_error: image parts are not supported here'), {
    status: 400,
  })
  assert.equal(describeImageBlockError(http), http.message)
  assert.equal(describeImageBlockError('plain string failure'), 'plain string failure')
})
