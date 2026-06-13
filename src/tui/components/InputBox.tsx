import { Box, Text, useStdout } from 'ink'
import { useDeclaredCursor } from '../ink.js'
import { buildInputWindow } from '../layout.js'
import { theme } from '../theme.js'

interface InputBoxProps {
  text: string
  cursorPos: number
  disabled?: boolean
}

export function InputBox({ text, cursorPos, disabled }: InputBoxProps) {
  const { stdout } = useStdout()
  const lineWidth = stdout.columns || 80
  const inputWidth = Math.max(1, lineWidth - 2)
  const separator = '─'.repeat(lineWidth)
  const window = buildInputWindow({ text, cursorPos, inputWidth })
  const declareCursor = useDeclaredCursor({
    line: 1 + window.cursorVisibleLine,
    column: 2 + window.cursorDisplayCol,
    active: !disabled,
  })

  if (disabled) {
    return (
      <Box flexDirection="column" ref={declareCursor}>
        <Text color={theme.subtleText}>{separator}</Text>
        {window.visibleLines.map((line, idx) => {
          const actualIndex = window.firstVisibleLine + idx
          return (
            <Box key={idx}>
              <Text color={theme.dimText}>{actualIndex === 0 ? '❯ ' : '  '}</Text>
              <Text color={theme.dimText} dimColor>
                {line.text || ' '}
              </Text>
            </Box>
          )
        })}
        <Text color={theme.subtleText}>{separator}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" ref={declareCursor}>
      <Text color={theme.subtleText}>{separator}</Text>
      {window.visibleLines.map((line, idx) => {
        const actualIndex = window.firstVisibleLine + idx
        const isCursorLine = actualIndex === window.cursorLine
        const cursorCharIndex = isCursorLine ? window.cursorCharIndex : 0
        return (
          <Box key={idx}>
            <Text color={theme.inputPrompt}>{actualIndex === 0 ? '❯ ' : '  '}</Text>
            {isCursorLine ? (
              <>
                <Text>{line.text.slice(0, cursorCharIndex)}</Text>
                <Text inverse>{line.text[cursorCharIndex] ?? ' '}</Text>
                <Text>{line.text.slice(cursorCharIndex + 1)}</Text>
              </>
            ) : (
              <Text>{line.text || ' '}</Text>
            )}
          </Box>
        )
      })}
      <Text color={theme.subtleText}>{separator}</Text>
    </Box>
  )
}
