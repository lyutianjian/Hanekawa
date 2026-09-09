import type { ImageAttachmentRef, ImageInputErrorReason } from '../media/types.js'
import type { SessionRecord } from './types.js'
import { orientedDimensions } from '../tools/imageFile.js'

/**
 * Turn-scoped image rules (design §9): which images in a request are "new" —
 * belonging to the run in flight — and which are history from earlier turns.
 *
 * One module supplies the rule every validation site shares (UI precheck,
 * submission preparation, the loop's per-request recheck, the provider's final
 * check): classification is by *record identity* (turn ID, message ID), never
 * by array position, so a queued input only becomes "new" when the dequeued
 * run actually records it, and an in-flight retry keeps its turn identity.
 */

/** Facts about a stored attachment the request path needs for honest placeholders. */
export interface AttachmentFacts {
  originalWidth: number
  originalHeight: number
  exifOrientation?: number
  localPath: string
}

/**
 * Resolves a ref's stored facts without loading image bytes. `ok: false`
 * covers an unregistered ref and cached files that are gone; the caller turns
 * that into a file-missing placeholder (history) or a blocked submission
 * (current input). Structurally satisfied by an adapter over
 * `ImageAttachmentService`.
 */
export interface AttachmentFactsResolver {
  resolveAttachmentFacts(
    ref: ImageAttachmentRef,
  ): Promise<{ ok: true; facts: AttachmentFacts } | { ok: false }>
}

export type TurnImageBlockReason = Extract<
  ImageInputErrorReason,
  'model-not-capable' | 'file-missing' | 'too-many-images' | 'image-too-large' | 'request-too-large'
>

/** A submission or request was stopped because its new images cannot be sent. */
export class TurnImageBlockError extends Error {
  readonly imageInputBlock: TurnImageBlockReason
  readonly images: ImageAttachmentRef[]

  constructor(reason: TurnImageBlockReason, images: ImageAttachmentRef[], message: string) {
    super(message)
    this.name = 'TurnImageBlockError'
    this.imageInputBlock = reason
    this.images = images
  }
}

/**
 * A fallback activation that did not happen because the fallback model cannot
 * accept this turn's new images (design §9.1). It carries the failure that
 * asked for the fallback in `cause`, because dropping it would leave the user
 * with only the image reason for an outage that started somewhere else.
 *
 * Refusing to activate is also what keeps the retry from looping: the loop
 * rethrows instead of switching, so the same incompatible target is never
 * tried again for this turn.
 */
export class FallbackNotApplicableForImagesError extends TurnImageBlockError {
  constructor(
    cause: unknown,
    fallbackModelLabel: string,
    images: readonly ImageAttachmentRef[],
  ) {
    super(
      'model-not-capable',
      [...images],
      formatFallbackNotApplicableMessage(cause, fallbackModelLabel, images.length),
    )
    this.name = 'FallbackNotApplicableForImagesError'
    this.cause = cause
  }
}

export function formatFallbackNotApplicableMessage(
  cause: unknown,
  fallbackModelLabel: string,
  imageCount: number,
): string {
  const plural = imageCount === 1 ? '' : 's'
  const original = cause instanceof Error ? cause.message : String(cause)
  return `${original}\n`
    + `The fallback model ${fallbackModelLabel} does not accept image input, and this turn carries `
    + `${imageCount} new image${plural}, so the fallback does not apply and was not used. `
    + `The new image${plural} ${imageCount === 1 ? 'was' : 'were'} not degraded. `
    + `Switch to another image-capable model or remove the image${plural}, then resend.`
}

export function formatNewImagesBlockedMessage(imageCount: number, model: string): string {
  const plural = imageCount === 1 ? '' : 's'
  return `Model ${model} does not accept image input, but this input carries ${imageCount} image${plural}. `
    + `Nothing was sent or recorded. Switch to an image-capable model (for example /model) or remove the image${plural}, then resend.`
}

/**
 * The shared new-image gate: sending images the model cannot accept is
 * rejected before anything is recorded, and the failure names the reason and
 * the way out. History-only images are *not* this function's concern — those
 * degrade to placeholders instead of blocking.
 */
export function assertNewImagesAllowed(
  newImages: readonly ImageAttachmentRef[] | undefined,
  supportsImageInput: boolean | undefined,
  modelLabel: string,
): void {
  if (supportsImageInput === true) return
  if (!newImages || newImages.length === 0) return
  throw new TurnImageBlockError(
    'model-not-capable',
    [...newImages],
    formatNewImagesBlockedMessage(newImages.length, modelLabel),
  )
}

/** Blocks a submission whose current-input files are gone (design §11.1). */
export async function assertCurrentImagesAvailable(
  newImages: readonly ImageAttachmentRef[] | undefined,
  resolveAttachmentFacts: AttachmentFactsResolver | undefined,
): Promise<void> {
  if (!newImages || newImages.length === 0) return
  if (!resolveAttachmentFacts) return
  const missing: ImageAttachmentRef[] = []
  for (const ref of newImages) {
    const resolved = await resolveAttachmentFacts.resolveAttachmentFacts(ref)
    if (!resolved.ok) missing.push(ref)
  }
  if (missing.length === 0) return
  throw new TurnImageBlockError(
    'file-missing',
    missing,
    `${missing.length} attached image${missing.length === 1 ? ' is' : 's are'} no longer available in this session's attachment store `
      + `(${missing.map((ref) => ref.name).join(', ')}). Nothing was sent or recorded; re-attach the image${missing.length === 1 ? '' : 's'} and resend.`,
  )
}

/**
 * Whether a record belongs to the run in flight — by message ID or turn ID,
 * never by array position. The identity rule behind every current/historical
 * image decision; the media-count cap (`mediaStrip.ts`) shares it so "new" and
 * "protected" cannot mean different things in the two checks.
 */
export function recordIsCurrentTurn(
  record: Pick<SessionRecord, 'id'> & { turnId?: string },
  currentTurnId: string,
  currentUserMessageId?: string,
): boolean {
  if (currentUserMessageId !== undefined && record.id === currentUserMessageId) return true
  return record.turnId === currentTurnId
}

/** Records that can carry request-visible images (the kinds the context builder sends). */
function imageBearingRecords(records: readonly SessionRecord[]): Array<SessionRecord & { images: ImageAttachmentRef[] }> {
  const result: Array<SessionRecord & { images: ImageAttachmentRef[] }> = []
  for (const record of records) {
    if (record.type !== 'message' && record.type !== 'tool_result') continue
    if (!record.images || record.images.length === 0) continue
    result.push(record as SessionRecord & { images: ImageAttachmentRef[] })
  }
  return result
}

export interface RequestImageProjection {
  /** The request-projected records; the input array and its records are never mutated. */
  records: SessionRecord[]
  /** Historical images replaced by text placeholders in this projection. */
  projectedImageCount: number
  /** Historical images found in the records (projected or not, per capability). */
  historicalImageCount: number
  /** Historical images whose cached files could not be resolved. */
  missingImageCount: number
  /** New (current-turn) images found in the records — protected, never projected. */
  newImageCount: number
  /**
   * The same new images as refs. The loop keeps these so a mid-turn fallback
   * can tell whether switching to a text-only model would strand them, without
   * re-deriving "new" from a different rule.
   */
  newImages: ImageAttachmentRef[]
  /**
   * Stable identity of (capability x image set) so a notice fires once per
   * distinct degradation instead of once per tool step; a switch back to a
   * capable model changes it silently, and re-degrading the same set notifies
   * again.
   */
  signature: string
}

/**
 * Applies the turn-image rules to a prepared request (design §9.1, §11.1):
 *
 * - capable model: records pass through untouched (the same reference);
 * - text-only model + new images: throws — new images are never dropped or
 *   degraded to get a request through;
 * - text-only model + history only: historical images leave the request as
 *   honest text placeholders (path, original dimensions, or a file-missing
 *   notice). This is a request projection: JSONL and cached files are not
 *   modified, so switching back to a capable model restores the pixels.
 */
export async function projectTurnImagesForRequest(input: {
  records: SessionRecord[]
  currentTurnId: string
  currentUserMessageId?: string
  supportsImageInput: boolean | undefined
  /** Display name of the model serving the request, for block messages. */
  modelLabel?: string
  resolveAttachmentFacts?: AttachmentFactsResolver
}): Promise<RequestImageProjection> {
  const bearing = imageBearingRecords(input.records)
  const current: ImageAttachmentRef[] = []
  const historical: Array<{ record: SessionRecord & { images: ImageAttachmentRef[] }; ref: ImageAttachmentRef }> = []
  for (const record of bearing) {
    const isCurrent = recordIsCurrentTurn(record, input.currentTurnId, input.currentUserMessageId)
    for (const ref of record.images) {
      if (isCurrent) current.push(ref)
      else historical.push({ record, ref })
    }
  }

  // New images in front of a text-only model block the request — this fires
  // even when there is no history at all, and before any degradation happens.
  if (input.supportsImageInput !== true && current.length > 0) {
    // A mid-run model change (fallback, plan routing) put new images in front
    // of a text-only model. Same rule as submission: block, never degrade.
    throw new TurnImageBlockError(
      'model-not-capable',
      current,
      formatNewImagesBlockedMessage(current.length, input.modelLabel ?? 'the active model'),
    )
  }

  if (input.supportsImageInput === true || historical.length === 0) {
    return {
      records: input.records,
      projectedImageCount: 0,
      historicalImageCount: historical.length,
      missingImageCount: 0,
      newImageCount: current.length,
      newImages: current,
      signature: projectionSignature(input.supportsImageInput, current, historical.map((entry) => entry.ref), []),
    }
  }

  const factsByRefId = new Map<string, { ok: true; facts: AttachmentFacts } | { ok: false }>()
  if (input.resolveAttachmentFacts) {
    for (const entry of historical) {
      if (factsByRefId.has(entry.ref.id)) continue
      factsByRefId.set(entry.ref.id, await input.resolveAttachmentFacts.resolveAttachmentFacts(entry.ref))
    }
  }

  const placeholdersByRecordId = new Map<string, string[]>()
  const missingIds: string[] = []
  let projected = 0
  for (const entry of historical) {
    const resolved = factsByRefId.get(entry.ref.id)
    const blocks = placeholdersByRecordId.get(entry.record.id) ?? []
    if (resolved?.ok) {
      blocks.push(formatHistoricalImagePlaceholder(entry.ref, resolved.facts))
    } else {
      blocks.push(formatMissingHistoricalImagePlaceholder(entry.ref))
      missingIds.push(entry.ref.id)
    }
    projected += 1
    placeholdersByRecordId.set(entry.record.id, blocks)
  }

  const records = input.records.map((record) => {
    const blocks = placeholdersByRecordId.get(record.id)
    if (!blocks) return record
    // Only message/tool_result records reach this map entry; the cast keeps
    // the destructure honest for the union TS cannot narrow here.
    const { images: _images, ...rest } = record as SessionRecord & {
      images?: ImageAttachmentRef[]
      content: string
    }
    return { ...rest, content: appendPlaceholderBlocks(rest.content, blocks) } as SessionRecord
  })

  return {
    records,
    projectedImageCount: projected,
    historicalImageCount: historical.length,
    missingImageCount: missingIds.length,
    newImageCount: 0,
    newImages: [],
    signature: projectionSignature(input.supportsImageInput, current, historical.map((entry) => entry.ref), missingIds),
  }
}

/** Distinct image refs a record list carries, oldest first (design §9.1). */
export function collectImageRefsInRecords(records: readonly SessionRecord[]): ImageAttachmentRef[] {
  const seen = new Set<string>()
  const refs: ImageAttachmentRef[] = []
  for (const record of imageBearingRecords(records)) {
    for (const ref of record.images) {
      if (seen.has(ref.id)) continue
      seen.add(ref.id)
      refs.push(ref)
    }
  }
  return refs
}

/**
 * What a *manual* model switch does to the images already in the conversation
 * (design §9.1). History never blocks a switch — this only tells the user what
 * the next request will look like, and returns `undefined` when there is
 * nothing to say. The request path still re-validates before sending; this is
 * a notice, not a gate, and never a second confirmation dialog.
 */
export function describeModelSwitchImageImpact(
  records: readonly SessionRecord[],
  supportsImageInput: boolean | undefined,
  modelLabel: string,
): string | undefined {
  const imageCount = collectImageRefsInRecords(records).length
  if (imageCount === 0) return undefined
  const plural = imageCount === 1 ? '' : 's'
  if (supportsImageInput === true) {
    return `${modelLabel} accepts images: the ${imageCount} image${plural} still in the effective context `
      + `will be sent again. Older turns already replaced by a summary are not re-expanded.`
  }
  return `${modelLabel} does not accept images: the ${imageCount} image${plural} in this conversation `
    + `will be sent as file paths instead. The originals are kept and are sent again after switching back `
    + `to an image-capable model.`
}

/** The degradation notice a user sees once per distinct (model, image set) state. */
export function formatHistoricalProjectionNotice(projectedImageCount: number, missingImageCount: number): string {
  const plural = projectedImageCount === 1 ? '' : 's'
  const message = `The current model does not accept images; ${projectedImageCount} historical image${plural} in this request `
    + `were replaced with file paths. The originals are kept and will be sent again after switching to an image-capable model.`
  if (missingImageCount > 0) {
    return `${message} (${missingImageCount} of them could not be found on disk.)`
  }
  return message
}

function projectionSignature(
  supportsImageInput: boolean | undefined,
  current: readonly ImageAttachmentRef[],
  historical: readonly ImageAttachmentRef[],
  missingIds: readonly string[],
): string {
  return [
    `capable:${supportsImageInput === true ? 1 : 0}`,
    `new:${current.map((ref) => ref.id).sort().join(',')}`,
    `hist:${historical.map((ref) => ref.id).sort().join(',')}`,
    `miss:${[...missingIds].sort().join(',')}`,
  ].join('|')
}

/** Appends placeholder blocks after existing text; empty text keeps just them. */
export function appendPlaceholderBlocks(content: string, blocks: readonly string[]): string {
  const addition = blocks.join('\n\n')
  return content.trim().length === 0 ? addition : `${content}\n\n${addition}`
}

/**
 * The placeholder the model receives instead of pixels. It states what the
 * image was and where the cache lives, and is explicit that no visual content
 * is present — never a description or OCR of the image.
 */
export function formatHistoricalImagePlaceholder(ref: ImageAttachmentRef, facts: AttachmentFacts): string {
  const oriented = orientedDimensions(facts.exifOrientation, facts.originalWidth, facts.originalHeight)
  return `[Historical image omitted for this text-only model:\n`
    + `${ref.name}, original ${oriented.width}x${oriented.height}, cached at ${facts.localPath}.\n`
    + `The pixels are not present in this request.]`
}

/** History whose cached files are gone keeps its slot with an explicit missing notice. */
export function formatMissingHistoricalImagePlaceholder(ref: ImageAttachmentRef): string {
  return `[Historical image missing: ${ref.name} (attachment ${ref.id}). `
    + `The cached files are gone, so the pixels are not present in this request.]`
}
