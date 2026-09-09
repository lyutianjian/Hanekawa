import type { ImageAttachmentRef } from '../media/types.js'
import type {
  AttachmentRefLookup,
  ImageStoreResult,
  StoredAttachment,
} from '../services/imageAttachments/imageAttachmentService.js'
import type { RebindQueuedImages } from './messageQueue.js'

/** The one method the hand-off needs; structural so a test fakes it. */
export interface AttachmentCopier {
  copyToSession(
    ref: AttachmentRefLookup,
    nextOwnerSessionId: string,
  ): Promise<ImageStoreResult<StoredAttachment>>
}

/**
 * The `/clear` attachment hand-off (design §12.3), shared by both shells.
 *
 * `switchToNewSession` migrates the pending queue into a brand-new session log,
 * and a migrated message that kept refs owned by the *previous* session would
 * turn into a dangling reference the moment that session is deleted. So each
 * image is copied into the new session first and the message carries the new
 * refs — the order the design spells out, and the reason `migrateTo` takes this
 * as a callback instead of copying inline.
 *
 * Degrades per image rather than failing the migration: a copy that fails
 * leaves that ref pointing at the old session, which still resolves today.
 * Losing the user's queued message would be strictly worse than a reference
 * that only breaks if they later delete the session it came from.
 */
export function createQueueImageRebinder(attachments: AttachmentCopier): RebindQueuedImages {
  return async (images, nextSessionId) => Promise.all(
    images.map(async (ref): Promise<ImageAttachmentRef> => {
      try {
        const copied = await attachments.copyToSession(ref, nextSessionId)
        return copied.ok ? copied.value.ref : ref
      } catch {
        return ref
      }
    }),
  )
}
