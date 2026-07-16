import { Box, Text, useWindowSize } from 'ink'
import { useDeclaredCursor } from '../ink.js'
import { buildInputWindow, calculateInputBoxGeometry } from '../layout.js'
import { theme } from '../theme.js'

interface InputBoxProps {
  text: string
  cursorPos: number
  disabled?: boolean
  isStreaming?: boolean
}

export function InputBox({ text, cursorPos, disabled, isStreaming = false }: InputBoxProps) {
  const { columns } = useWindowSize()
  const { inputWidth } = calculateInputBoxGeometry(columns)
  const window = buildInputWindow({ text, cursorPos, inputWidth })
  const declareCursor = useDeclaredCursor({
    line: 1 + window.cursorVisibleLine,
    column: 2 + window.cursorDisplayCol,
    active: !disabled,
  })

  if (disabled) {
    return (
      <Box flexDirection="column" width="100%" paddingRight={1} ref={declareCursor}>
        <InputSeparator />
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
        <InputSeparator />
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width="100%" paddingRight={1} ref={declareCursor}>
      <InputSeparator />
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
      <InputSeparator />
      {isStreaming ? <Text color={theme.dimText} dimColor>  Enter to queue</Text> : null}
    </Box>
  )
}

function InputSeparator() {
  return (
    <Box
      width="100%"
      borderStyle="single"
      borderColor={theme.subtleText}
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
    />
  )
}
