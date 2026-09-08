import { Box, Text } from 'ink'
import { theme } from '../theme.js'
import { formatDraftAttachmentLine, type DraftImage } from '../utils/imageDrafts.js'

interface DraftAttachmentsProps {
  images: DraftImage[]
  /** Imports currently in flight; the strip stays visible while any run. */
  importingCount: number
}

/**
 * The composer's draft image list (session S14): one numbered line per
 * attachment, the shared removal hint, and an in-flight marker. Rendering
 * nothing when idle keeps the prompt frame unchanged for image-less sessions.
 */
export function DraftAttachments({ images, importingCount }: DraftAttachmentsProps) {
  if (images.length === 0 && importingCount === 0) return null

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {importingCount > 0 ? (
        <Text color={theme.dimText} dimColor>{importingCount === 1 ? 'Importing image…' : `Importing ${importingCount} images…`}</Text>
      ) : null}
      {images.map((image, index) => (
        <Text key={image.ref.id} color={theme.dimText}>
          {formatDraftAttachmentLine(index + 1, image)}
        </Text>
      ))}
      <Text color={theme.subtleText} dimColor>
        Images attach to your next message · /attachments remove &lt;n&gt; removes one · /paste-image adds one
      </Text>
    </Box>
  )
}
