import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('TUI entrypoint uses cursor parking render wrapper', async () => {
  const source = await readFile('src/tui/entrypoints/tui.tsx', 'utf8')

  assert.match(source, /import \{ render \} from '\.\.\/ink\.js'/)
  assert.doesNotMatch(source, /import \{ render \} from 'ink'/)
})

test('InputBox avoids Ink internal cursor context and declares parked cursor target', async () => {
  const source = await readFile('src/tui/components/InputBox.tsx', 'utf8')
  const wrapperSource = await readFile('src/tui/ink.tsx', 'utf8')

  assert.doesNotMatch(source, /CursorContext/)
  assert.doesNotMatch(source, /setCursorPosition/)
  assert.match(source, /useDeclaredCursor/)
  assert.match(source, /buildInputWindow/)
  assert.match(wrapperSource, /CursorContext/)
  assert.match(wrapperSource, /setCursorPosition/)
})

test('App renders welcome banner through static items instead of dynamic live tree', async () => {
  const source = await readFile('src/tui/components/App.tsx', 'utf8')

  assert.doesNotMatch(source, /<WelcomeBanner/)
  assert.match(source, /kind: 'welcome_banner'/)
  assert.match(source, /<Static/)
})

test('App pauses spinner rendering while modal overlays are active', async () => {
  const source = await readFile('src/tui/components/App.tsx', 'utf8')
  const spinnerSource = await readFile('src/tui/components/Spinner.tsx', 'utf8')
  const hookSource = await readFile('src/tui/hooks/useSpinner.ts', 'utf8')

  assert.match(source, /const showSpinner = !isOverlayActive/)
  assert.match(source, /active=\{showSpinner\}/)
  assert.doesNotMatch(source, /\{isStreaming && <Spinner/)
  assert.match(spinnerSource, /if \(!active\) return null/)
  assert.match(hookSource, /export function useSpinner\(active = true\)/)
  assert.match(hookSource, /if \(!active\) return/)
})
