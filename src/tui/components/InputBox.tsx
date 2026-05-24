import { useRef, useEffect, useContext } from 'react'
import { Box, Text, useStdout } from 'ink'
// @ts-ignore — accessing Ink internal for cursor timing (useCursor has wrong timing)
import CursorContext from '../../../node_modules/ink/build/components/CursorContext.js'
import stringWidth from 'string-width'
import { theme } from '../theme.js'

interface InputBoxProps {
  text: string
  cursorPos: number
  disabled?: boolean
}

function findRootNode(node: any): any {
  let current = node
  while (current?.parentNode) {
    current = current.parentNode
  }
  return current?.nodeName === 'ink-root' ? current : null
}

export function InputBox({ text, cursorPos, disabled }: InputBoxProps) {
  const { stdout } = useStdout()
  const lineWidth = stdout.columns || 80
  const inputWidth = Math.max(1, lineWidth - 2)
  const separator = '─'.repeat(lineWidth)

  // Wrap text into lines by display width (CJK chars are 2 columns wide)
  const lines: string[] = []
  if (text.length === 0) {
    lines.push('')
  } else {
    let i = 0
    while (i < text.length) {
      let end = i
      let width = 0
      while (end < text.length) {
        const charWidth = stringWidth(text[end]!)
        if (width + charWidth > inputWidth) break
        width += charWidth
        end++
      }
      if (end === i) end++
      lines.push(text.slice(i, end))
      i = end
    }
  }

  // Find which line the cursor is on and its display column offset
  let cursorLine = 0
  let cursorDisplayCol = 0
  let charCount = 0
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!
    if (charCount + line.length >= cursorPos) {
      cursorLine = lineIdx
      cursorDisplayCol = stringWidth(line.slice(0, cursorPos - charCount))
      break
    }
    charCount += line.length
  }
  const cursorCharIdx = cursorPos - charCount

  const boxRef = useRef(null)
  const cursorContext = useContext(CursorContext)

  // Store cursor info in ref — layout listener reads this at the correct time
  const cursorInfoRef = useRef({ linesBelow: 0, cursorDisplayCol: 0, disabled: false })
  const statusLineHeight = 1
  const linesBelow = (lines.length - cursorLine - 1) + 1 + statusLineHeight
  cursorInfoRef.current = { linesBelow, cursorDisplayCol, disabled: !!disabled }

  // Layout listener: fires after Yoga layout, before onRender
  useEffect(() => {
    const node = boxRef.current as any
    const rootNode = findRootNode(node)
    if (!rootNode) return

    const listener = () => {
      const info = cursorInfoRef.current
      if (info.disabled) {
        cursorContext.setCursorPosition(undefined)
        return
      }
      const rootHeight: number = rootNode.yogaNode?.getComputedHeight() ?? 0
      if (rootHeight <= 0) {
        cursorContext.setCursorPosition(undefined)
        return
      }
      const terminalRows = stdout.rows || 24
      const isFullscreen = rootHeight >= terminalRows
      const y = isFullscreen
        ? rootHeight - info.linesBelow
        : rootHeight - info.linesBelow - 1
      cursorContext.setCursorPosition({ x: 2 + info.cursorDisplayCol, y })
    }

    rootNode.internal_layoutListeners ??= new Set()
    rootNode.internal_layoutListeners.add(listener)
    listener()

    return () => {
      rootNode.internal_layoutListeners?.delete(listener)
      cursorContext.setCursorPosition(undefined)
    }
  })

  if (disabled) {
    return (
      <Box flexDirection="column" ref={boxRef}>
        <Text color={theme.border}>{separator}</Text>
        {lines.map((line, idx) => (
          <Box key={idx}>
            <Text color={theme.dimText}>{idx === 0 ? '> ' : '  '}</Text>
            <Text color={theme.dimText} dimColor>
              {line || ' '}
            </Text>
          </Box>
        ))}
        <Text color={theme.border}>{separator}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" ref={boxRef}>
      <Text color={theme.border}>{separator}</Text>
      {lines.map((line, idx) => (
        <Box key={idx}>
          <Text color={theme.inputPrompt}>{idx === 0 ? '> ' : '  '}</Text>
          {idx === cursorLine ? (
            <>
              <Text>{line.slice(0, cursorCharIdx)}</Text>
              <Text inverse>{line[cursorCharIdx] ?? ' '}</Text>
              <Text>{line.slice(cursorCharIdx + 1)}</Text>
            </>
          ) : (
            <Text>{line || ' '}</Text>
          )}
        </Box>
      ))}
      <Text color={theme.border}>{separator}</Text>
    </Box>
  )
}
