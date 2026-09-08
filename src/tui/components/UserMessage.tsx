import { Box, Text } from 'ink'
import { pathToFileURL } from 'node:url'
import type { ImageAttachmentRef } from '../../media/types.js'
import { attachmentSendVersionPath } from '../../services/imageAttachments/imageAttachmentService.js'
import { supportsHyperlinks, createHyperlink } from '../hyperlink.js'
import { AnsiText } from '../ansi.js'
import { theme } from '../theme.js'
import { formatImageAttachmentSummary } from '../utils/imageDrafts.js'

interface UserMessageProps {
  content: string
  /** Image refs the message carried; rendered as numbered attachment lines. */
  images?: ImageAttachmentRef[]
  /** Project root the attachment store lives under; defaults to the process cwd. */
  cwd?: string
  /** Overrides the OSC 8 probe so both modes are testable. */
  hyperlinks?: boolean
}

/**
 * One transcript attachment line for an image ref: the numbered summary, as
 * an OSC 8 file link on terminals that support it, or with the copyable path
 * spelled out on the rest. Pure so both modes are testable without a TTY.
 */
export function imageAttachmentLine(
  index: number,
  ref: ImageAttachmentRef,
  options: { cwd: string; hyperlinks: boolean },
): string {
  const label = `[${formatImageAttachmentSummary(index, ref)}]`
  const filePath = attachmentSendVersionPath(options.cwd, ref)
  return options.hyperlinks
    ? createHyperlink(pathToFileURL(filePath).href, label)
    : `${label} ${filePath}`
}

export function UserMessage({
  content,
  images,
  cwd = process.cwd(),
  hyperlinks = supportsHyperlinks(),
}: UserMessageProps) {
  // A pure-image message still needs words in the transcript; the session
  // title derives the same fallback, so the two never disagree.
  const displayContent = content.trim() === '' && images && images.length > 0
    ? `图片：${images[0]!.name}${images.length > 1 ? `（共 ${images.length} 张）` : ''}`
    : content

  return (
    <Box marginBottom={1} flexDirection="column">
      <Box backgroundColor="#2d2d2d" width="100%">
        <Text color="white">{'❯ '}{displayContent}</Text>
      </Box>
      {images?.map((image, index) => (
        <Box key={image.id} paddingLeft={2}>
          {hyperlinks
            ? <AnsiText>{imageAttachmentLine(index + 1, image, { cwd, hyperlinks: true })}</AnsiText>
            : (
              <Text color={theme.dimText} dimColor>
                {imageAttachmentLine(index + 1, image, { cwd, hyperlinks: false })}
              </Text>
            )}
        </Box>
      ))}
    </Box>
  )
}
