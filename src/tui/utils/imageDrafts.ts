import type { ImageAttachmentRef } from '../../media/types.js'

/**
 * The composer's draft image attachments (design doc §6.2/§13, session S14).
 *
 * A draft is an imported attachment waiting to ride along with the user's
 * next real message. Pure helpers live here so the strip view, the
 * `/attachments` command, and the submit path all share one list format and
 * one removal/renumbering rule.
 */

export interface DraftImage {
  ref: ImageAttachmentRef
  /** True when the import knew the source was animated (first frame is sent). Absent when unknown, e.g. a restored draft. */
  animated?: boolean
}

/**
 * Whether a submitted input must leave the draft attachments in place.
 *
 * Slash commands never carry the drafts away with them: control commands
 * (`/model`, `/provider`, `/effort`, `/paste-image`) only act, view commands
 * only view, and skill or `/plan` queries consume the drafts themselves at
 * `submitQuery` time so the generated user input keeps its image refs. The
 * only inputs that take the drafts along here are plain messages. Session
 * switches (`/clear`, `/resume`) drop the draft list through their own
 * handlers, leaving the files with the session that owns them (S23 owns the
 * full ownership rules).
 */
export function keepsDraftAttachments(input: string): boolean {
  return input.startsWith('/')
}

/** The ref list a submission carries; `undefined` when there is nothing to carry. */
export function draftImageRefs(images: readonly DraftImage[]): ImageAttachmentRef[] | undefined {
  return images.length > 0 ? images.map((image) => image.ref) : undefined
}

/**
 * One attachment line, numbered: `[图片 1：screenshot.png，1920×1080]` — with
 * the animated-first-frame annotation when the import knew the source was
 * animated. Numbering is the list position, so removal renumbers by itself.
 */
export function formatDraftAttachmentLine(index: number, image: DraftImage): string {
  return `[${formatImageAttachmentSummary(index, image.ref, image.animated)}]`
}

/** The shared summary inside the brackets; also the transcript's per-image line. */
export function formatImageAttachmentSummary(
  index: number,
  ref: ImageAttachmentRef,
  animated?: boolean,
): string {
  const animatedSuffix = animated ? '，动画首帧' : ''
  return `图片 ${index}：${ref.name}，${ref.width}×${ref.height}${animatedSuffix}`
}

/**
 * Removes the 1-based numbered draft image. Numbering is display position, so
 * the surviving list renumbers automatically.
 */
export function removeDraftImageAt(
  images: readonly DraftImage[],
  index: number,
): { ok: boolean; message?: string; next: DraftImage[] } {
  if (!Number.isInteger(index) || index < 1 || index > images.length) {
    return {
      ok: false,
      message: images.length === 0
        ? 'There are no draft images to remove.'
        : `No image ${index}; the draft has ${images.length}.`,
      next: [...images],
    }
  }
  return { ok: true, next: images.filter((_, position) => position !== index - 1) }
}
