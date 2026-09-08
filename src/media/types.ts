/**
 * Pure multimodal-input types: the vocabulary every image-input layer shares.
 *
 * `config/` (model capability), the protocol wire, `prompts/` budgets, and both
 * UIs name images with these types, so the module must stay importable from
 * all of them: no `harness/`, no `services/`, no `sharp`, no `node:fs` — no
 * imports at all. Anything that has to *decide or read* (capability resolution,
 * decoding, storage) lives in the layer that owns it and only uses these names.
 */

/** The MIME types the send path emits; collectors normalize to one of these. */
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp'

/**
 * One persisted image, as messages, tool results, and the queue reference it.
 *
 * Describes the default processed send version (dimensions, byte length); the
 * original's own facts live in {@link ImageAttachmentMetadata}. Records carry
 * only this ref — never Base64, `File`/`Blob`/`NativeImage`, or preview URLs —
 * and resolve back through the owning session's attachment service.
 */
export interface ImageAttachmentRef {
  id: string
  ownerSessionId: string
  name: string
  mimeType: ImageMimeType
  width: number
  height: number
  byteLength: number
}

/** What a submit carries: text always, images when the turn has any. */
export interface UserInput {
  text: string
  images?: ImageAttachmentRef[]
}

/**
 * Text content that may carry image refs beside it. `content` stays the text of
 * record for display, search, and the existing commands; images ride separately.
 */
export interface ImageBearingContent {
  content: string
  images?: ImageAttachmentRef[]
}

/**
 * The original's facts, persisted beside the files in the attachment store.
 * The ref above describes the default send version; this describes where that
 * version came from — enough to rebuild it and to restore orientation without
 * re-reading a source file that may since have changed.
 */
export interface ImageAttachmentMetadata {
  /** Content-sniffed MIME of the original bytes; may differ from the ref's. */
  originalMimeType: string
  /** File name the image arrived under. */
  originalName: string
  /** Stored-original dimensions, before EXIF orientation is applied. */
  originalWidth: number
  originalHeight: number
  /** EXIF orientation tag (1–8) as stored; the send version applies it. */
  exifOrientation?: number
  /** Hex digest of the original bytes; same-session content dedup key. */
  checksum: string
  /** Bumped when the processing pipeline's output changes; caches rebuild lazily. */
  processingVersion: number
  /** Default send-version dimensions — the ref's width/height. */
  sentWidth: number
  sentHeight: number
  /** Absolute path of the cached original. */
  localPath: string
}

/**
 * Why an image-bearing input or request failed, kept distinguishable so the UI
 * never has to show a bare HTTP 400 for what is really "this model cannot see
 * images". Tool results reuse their existing error codes and carry one of
 * these in the structured details; provider requests map onto them in the
 * final pre-send check.
 */
export const IMAGE_INPUT_ERROR_REASONS = [
  /** The request's model is not image-capable (switch off, or adapter lacks it). */
  'model-not-capable',
  /** The file's format is outside the first version's set (BMP, HEIC, TIFF, AVIF…). */
  'unsupported-format',
  /** The bytes claimed to be an image but would not decode. */
  'decode-failed',
  /** The referenced attachment (or its source) is gone. */
  'file-missing',
  /** One image exceeds the per-image byte or pixel budget. */
  'image-too-large',
  /** The whole serialized request exceeds its byte budget. */
  'request-too-large',
  /** More images than the per-input or per-request cap allows. */
  'too-many-images',
] as const

export type ImageInputErrorReason = typeof IMAGE_INPUT_ERROR_REASONS[number]
