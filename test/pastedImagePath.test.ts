import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  parseStandaloneImagePath,
  expandHomePath,
  resolvePastedPath,
} from '../src/tui/utils/pastedImagePath.js'

const WIN = { platform: 'win32' as const }
const POSIX = { platform: 'linux' as const }

test('quoted Windows path with spaces parses standalone', () => {
  assert.deepEqual(
    parseStandaloneImagePath('"C:\\Users\\Miyano\\Pictures\\my screenshot.png"', WIN),
    { path: 'C:\\Users\\Miyano\\Pictures\\my screenshot.png' },
  )
})

test('POSIX paste with escaped spaces parses with the escapes merged', () => {
  assert.deepEqual(
    parseStandaloneImagePath('/home/miyano/Pictures/my\\ screenshot.png', POSIX),
    { path: '/home/miyano/Pictures/my screenshot.png' },
  )
})

test('unquoted Windows backslash path parses without escape processing', () => {
  // A UNC path keeps its leading double backslash: on win32, backslashes are
  // separators, never terminal drop escapes.
  assert.deepEqual(
    parseStandaloneImagePath('\\\\server\\share\\diagram.png', WIN),
    { path: '\\\\server\\share\\diagram.png' },
  )
  assert.deepEqual(
    parseStandaloneImagePath('C:\\Users\\miyano\\shot.png', WIN),
    { path: 'C:\\Users\\miyano\\shot.png' },
  )
})

test('quoted and unquoted POSIX paths parse', () => {
  assert.deepEqual(parseStandaloneImagePath('/tmp/img.png', POSIX), { path: '/tmp/img.png' })
  assert.deepEqual(parseStandaloneImagePath('\'/tmp/my image.png\'', POSIX), { path: '/tmp/my image.png' })
})

test('relative paths with a separator parse; home-anchored paths parse', () => {
  assert.deepEqual(parseStandaloneImagePath('screenshots/shot.png', POSIX), { path: 'screenshots/shot.png' })
  assert.deepEqual(parseStandaloneImagePath('~/Pictures/shot.png', POSIX), { path: '~/Pictures/shot.png' })
})

test('a bare filename without a separator stays text', () => {
  assert.equal(parseStandaloneImagePath('screenshot.png', POSIX), null)
  assert.equal(parseStandaloneImagePath('photo.JPG', WIN), null)
})

test('sentences, code blocks, and path-bearing long text stay text', () => {
  assert.equal(parseStandaloneImagePath('see /tmp/img.png for details', POSIX), null)
  assert.equal(parseStandaloneImagePath('const p = "/tmp/img.png"', POSIX), null)
  assert.equal(parseStandaloneImagePath('run npm install in ./docs/img.png then', POSIX), null)
  assert.equal(parseStandaloneImagePath('/tmp/a.png\n/tmp/b.png', POSIX), null)
  assert.equal(parseStandaloneImagePath('first line\nsee /tmp/img.png', POSIX), null)
})

test('non-image and missing extensions stay text', () => {
  assert.equal(parseStandaloneImagePath('/tmp/index.ts', POSIX), null)
  assert.equal(parseStandaloneImagePath('/tmp/noext', POSIX), null)
  assert.equal(parseStandaloneImagePath('/tmp/.hidden', POSIX), null)
  assert.equal(parseStandaloneImagePath('/tmp/archive.tar.gz', POSIX), null)
})

test('known-unsupported image extensions are candidates so the pipeline can fail loudly', () => {
  assert.deepEqual(parseStandaloneImagePath('/tmp/scan.bmp', POSIX), { path: '/tmp/scan.bmp' })
  assert.deepEqual(parseStandaloneImagePath('/tmp/photo.heic', POSIX), { path: '/tmp/photo.heic' })
})

test('extension match is case-insensitive', () => {
  assert.deepEqual(parseStandaloneImagePath('/tmp/SHOT.PNG', POSIX), { path: '/tmp/SHOT.PNG' })
})

test('unquoted spaces without POSIX escapes stay text', () => {
  assert.equal(parseStandaloneImagePath('C:\\Users\\miyano\\my shot.png', WIN), null)
  assert.equal(parseStandaloneImagePath('/tmp/my shot.png', POSIX), null)
})

test('quote fragments that do not wrap the whole paste stay text', () => {
  assert.equal(parseStandaloneImagePath('"C:\\a\\b.png" trailing', WIN), null)
  assert.equal(parseStandaloneImagePath('say "hi" /tmp/a.png', POSIX), null)
  // A quote inside the quoted span means the quotes were part of the text.
  assert.equal(parseStandaloneImagePath('"C:\\a\\"b".png"', WIN), null)
})

test('empty and whitespace-only pastes stay text', () => {
  assert.equal(parseStandaloneImagePath('', POSIX), null)
  assert.equal(parseStandaloneImagePath('   ', POSIX), null)
})

test('very long pastes stay text', () => {
  assert.equal(parseStandaloneImagePath(`/tmp/${'a'.repeat(5000)}.png`, POSIX), null)
})

test('expandHomePath expands only a leading tilde', () => {
  assert.equal(expandHomePath('~', '/home/u'), '/home/u')
  assert.equal(expandHomePath('~/Pictures/a.png', '/home/u'), path.join('/home/u', 'Pictures/a.png'))
  assert.equal(expandHomePath('~\\Pictures\\a.png', '/home/u'), path.join('/home/u', 'Pictures\\a.png'))
  assert.equal(expandHomePath('/tmp/a.png', '/home/u'), '/tmp/a.png')
  assert.equal(expandHomePath('/tmp/~not-home.png', '/home/u'), '/tmp/~not-home.png')
})

test('resolvePastedPath anchors relative paths and expands home', () => {
  const options = { cwd: '/project', homedir: '/home/u' }
  assert.equal(resolvePastedPath('screenshots/a.png', options), path.resolve('/project', 'screenshots/a.png'))
  assert.equal(resolvePastedPath('/abs/a.png', options), path.resolve('/abs/a.png'))
  assert.equal(resolvePastedPath('~/a.png', options), path.resolve('/project', path.join('/home/u', 'a.png')))
})

test('path parsing never routes the paste through a shell', async () => {
  const source = await readFile(
    path.resolve('src/tui/utils/pastedImagePath.ts'),
    'utf8',
  )
  assert.equal(source.includes('child_process'), false)
  assert.equal(/\b(?:spawn|spawnSync|exec|execSync)\s*\(/.test(source), false)
})
