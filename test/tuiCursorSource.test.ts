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

test('App disables TUI animations while the permission dialog is visible', async () => {
  const source = await readFile('src/tui/components/App.tsx', 'utf8')
  const spinnerSource = await readFile('src/tui/components/Spinner.tsx', 'utf8')
  const animationFrameSource = await readFile('src/tui/hooks/useAnimationFrame.ts', 'utf8')
  const rowSource = await readFile('src/tui/components/Spinner/SpinnerAnimationRow.tsx', 'utf8')
  const messageListSource = await readFile('src/tui/components/MessageList.tsx', 'utf8')
  const toolCallSource = await readFile('src/tui/components/ToolCallBlock.tsx', 'utf8')
  const taskListSource = await readFile('src/tui/components/TaskListBlock.tsx', 'utf8')

  assert.match(source, /const animationsEnabled = !permState\.visible/)
  assert.match(source, /const showSpinner = animationsEnabled && !isOverlayActive/)
  assert.match(source, /active=\{showSpinner\}/)
  assert.match(source, /animationsEnabled=\{animationsEnabled\}/)
  assert.doesNotMatch(source, /\{isStreaming && <Spinner/)
  assert.match(spinnerSource, /if \(!active\) return null/)
  assert.match(spinnerSource, /animationsEnabled=\{active\}/)
  // Hiding the spinner unmounts the animation row; its keepAlive clock
  // subscription drops, so the global tick stops entirely while overlays
  // are visible.
  assert.match(animationFrameSource, /keepAlive: true/)
  assert.match(animationFrameSource, /intervalMs === null/)
  assert.match(rowSource, /useAnimationFrame\(50\)/)
  // Overlay pause time is accumulated so elapsed survives the hidden window.
  assert.match(spinnerSource, /pauseStartTimeRef/)
  assert.match(messageListSource, /animationsEnabled = true/)
  assert.match(messageListSource, /<ToolCallBlock item=\{item\} expanded=\{isExpanded\} animationsEnabled=\{animationsEnabled\}/)
  assert.match(toolCallSource, /useBlink\(animationsEnabled && runningOrApproved\)/)
  assert.match(taskListSource, /animationsEnabled = true/)
  assert.match(taskListSource, /if \(!animationsEnabled\) return/)
})
