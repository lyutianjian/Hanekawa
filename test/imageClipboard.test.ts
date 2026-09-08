import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import {
  CLIPBOARD_IMAGE_FALLBACK_HINT,
  MACOS_NO_IMAGE_MARKER,
  MAX_CLIPBOARD_IMAGE_BYTES,
  WINDOWS_NO_IMAGE_EXIT_CODE,
  captureClipboardImage,
  hasImageClipboardType,
  isClipboardEmptyError,
  macOSClipboardCommand,
  parseOfferedClipboardTypes,
  resolveClipboardPlatform,
  selectClipboardImageType,
  waylandListTypesCommand,
  waylandReadTypeCommand,
  windowsClipboardCommand,
  x11ListTargetsCommand,
  x11ReadTypeCommand,
} from '../src/tui/utils/imageClipboard.js'
import type {
  ClipboardCommand,
  ClipboardProcessOutcome,
  ClipboardProcessRunner,
} from '../src/tui/utils/imageClipboard.js'
import { sniffImage } from '../src/tools/imageFile.js'
import { loadFixtureBytes, makeBmpBytes } from './helpers/imageFixtures.js'

/**
 * S13: the TUI clipboard capture module. Command construction and output
 * parsing are pure; the capture paths run against a scripted process runner so
 * every platform's success and no-dependency behaviour is testable from any
 * OS. Real-machine capture stays an S26 item.
 */

const here = path.dirname(fileURLToPath(import.meta.url))

type ScriptedOutcome = (
  command: ClipboardCommand,
  call: number,
) => Partial<ClipboardProcessOutcome> | Promise<Partial<ClipboardProcessOutcome>>

/** A runner that answers from a script and records every command it saw. */
function fakeRunner(script: ScriptedOutcome): ClipboardProcessRunner & { commands: ClipboardCommand[] } {
  const commands: ClipboardCommand[] = []
  let calls = 0
  const runner = async (command: ClipboardCommand): Promise<ClipboardProcessOutcome> => {
    commands.push(command)
    const outcome = await script(command, calls++)
    return { status: 0, stdout: Buffer.alloc(0), stderr: '', notFound: false, timedOut: false, ...outcome }
  }
  return Object.assign(runner, { commands })
}

async function makeTiffBytes(): Promise<Buffer> {
  return sharp({ create: { width: 4, height: 3, channels: 3, background: { r: 200, g: 100, b: 50 } } })
    .tiff()
    .toBuffer()
}

describe('clipboard platform resolution', () => {
  it('maps each supported platform', () => {
    assert.equal(resolveClipboardPlatform('win32', {}), 'windows')
    assert.equal(resolveClipboardPlatform('darwin', {}), 'macos')
    assert.equal(resolveClipboardPlatform('linux', { WAYLAND_DISPLAY: 'wayland-0' }), 'linux-wayland')
    assert.equal(resolveClipboardPlatform('linux', { DISPLAY: ':0' }), 'linux-x11')
  })

  it('prefers Wayland when both displays are set and reports no-display as unavailable', () => {
    assert.equal(
      resolveClipboardPlatform('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }),
      'linux-wayland',
    )
    assert.equal(resolveClipboardPlatform('linux', {}), 'unavailable')
    assert.equal(resolveClipboardPlatform('freebsd', { DISPLAY: ':0' }), 'unavailable')
  })
})

describe('capture command construction', () => {
  it('builds the Windows PowerShell STA command with the script as one arg', () => {
    const command = windowsClipboardCommand()
    assert.equal(command.file, 'powershell.exe')
    assert.deepEqual(
      command.args.slice(0, 4),
      ['-NoProfile', '-NonInteractive', '-STA', '-Command'],
    )
    const script = command.args[4]!
    assert.match(script, /\[System\.Windows\.Forms\.Clipboard\]::GetImage\(\)/)
    assert.match(script, /\[System\.Drawing\.Imaging\.ImageFormat\]::Png/)
    assert.match(script, new RegExp(`exit ${WINDOWS_NO_IMAGE_EXIT_CODE}`))
    for (const arg of command.args) {
      assert.equal(typeof arg, 'string')
    }
  })

  it('builds the macOS osascript command with the temp path as its own argument', () => {
    const tempPath = '/tmp/hanekawa-clip-X/clipboard-image'
    const command = macOSClipboardCommand(tempPath)
    assert.equal(command.file, 'osascript')
    assert.equal(command.args.length, 3)
    assert.equal(command.args[0], '-e')
    assert.equal(command.args[2], tempPath)
    const script = command.args[1]!
    assert.match(script, /the clipboard as «class PNGf»/)
    assert.match(script, /the clipboard as «class TIFFf»/)
    assert.ok(script.includes(MACOS_NO_IMAGE_MARKER))
    assert.match(script, /on run argv/)
  })

  it('builds the Wayland and X11 list and read commands', () => {
    assert.deepEqual(waylandListTypesCommand(), { file: 'wl-paste', args: ['--list-types'] })
    assert.deepEqual(waylandReadTypeCommand('image/png'), {
      file: 'wl-paste',
      args: ['--type', 'image/png'],
    })
    assert.deepEqual(x11ListTargetsCommand(), {
      file: 'xclip',
      args: ['-selection', 'clipboard', '-output', '-target', 'TARGETS'],
    })
    assert.deepEqual(x11ReadTypeCommand('image/jpeg'), {
      file: 'xclip',
      args: ['-selection', 'clipboard', '-output', '-target', 'image/jpeg'],
    })
  })

  it('never routes a capture through a shell string', async () => {
    const source = await readFile(path.join(here, '..', 'src', 'tui', 'utils', 'imageClipboard.ts'), 'utf8')
    assert.ok(!source.includes('shell:'), 'capture must not opt into a shell')
    assert.ok(!source.includes('execSync'))
    assert.ok(!source.includes('spawnSync'))
    assert.ok(!/\bexec\(/.test(source))
  })
})

describe('offered clipboard types', () => {
  it('parses type lists line by line, trimming and dropping blanks', () => {
    assert.deepEqual(
      parseOfferedClipboardTypes('image/png\r\nimage/jpeg\n\n  text/plain  \n'),
      ['image/png', 'image/jpeg', 'text/plain'],
    )
  })

  it('prefers PNG, then the other pass-through formats, then convertible bitmaps', () => {
    assert.deepEqual(selectClipboardImageType(['image/jpeg', 'image/png']), {
      mimeType: 'image/png',
      passthrough: true,
    })
    assert.deepEqual(selectClipboardImageType(['image/jpeg', 'image/webp', 'image/gif']), {
      mimeType: 'image/jpeg',
      passthrough: true,
    })
    assert.deepEqual(selectClipboardImageType(['image/tiff']), {
      mimeType: 'image/tiff',
      passthrough: false,
    })
    assert.deepEqual(selectClipboardImageType(['image/heic']), {
      mimeType: 'image/heic',
      passthrough: false,
    })
  })

  it('does not select undecodable bitmap types but still recognizes them as images', () => {
    assert.equal(selectClipboardImageType(['text/plain', 'image/bmp']), null)
    assert.equal(hasImageClipboardType(['text/plain', 'image/bmp']), true)
    assert.equal(hasImageClipboardType(['text/plain']), false)
    assert.equal(selectClipboardImageType(['text/plain']), null)
  })

  it('classifies empty-clipboard stderr from the Linux list helpers', () => {
    assert.equal(isClipboardEmptyError('Error: target TARGETS not available'), true)
    assert.equal(isClipboardEmptyError('error: nothing to paste'), true)
    assert.equal(isClipboardEmptyError('Error: Can\'t open display: :0'), false)
  })
})

describe('captureClipboardImage on Windows', () => {
  const options = { platform: 'win32' as const, env: {} }

  it('captures a PNG clipboard image unchanged', async () => {
    const png = await loadFixtureBytes('transparent.png')
    const runner = fakeRunner(() => ({ stdout: png }))
    const result = await captureClipboardImage({ ...options, runProcess: runner })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(result.ok)
    assert.equal(result.format, 'png')
    assert.equal(result.sourceFormat, 'png')
    assert.equal(result.converted, false)
    assert.deepEqual(result.bytes, png)
    assert.equal(runner.commands[0]!.file, 'powershell.exe')
  })

  it('passes GIF through as-is', async () => {
    const gif = await loadFixtureBytes('single-frame.gif')
    const result = await captureClipboardImage({
      ...options,
      runProcess: fakeRunner(() => ({ stdout: gif })),
    })
    assert.ok(result.ok)
    assert.equal(result.format, 'gif')
    assert.equal(result.converted, false)
  })

  it('reports the reserved exit code as no-image with the fallback hint', async () => {
    const result = await captureClipboardImage({
      ...options,
      runProcess: fakeRunner(() => ({ status: WINDOWS_NO_IMAGE_EXIT_CODE })),
    })
    assert.equal(result.ok, false)
    assert.ok(!result.ok)
    assert.equal(result.reason, 'no-image')
    assert.ok(result.message.includes(CLIPBOARD_IMAGE_FALLBACK_HINT))
  })

  it('reports a missing PowerShell as dependency-missing', async () => {
    const result = await captureClipboardImage({
      ...options,
      runProcess: fakeRunner(() => ({ notFound: true })),
    })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'dependency-missing')
    assert.match(result.message, /powershell\.exe/)
  })

  it('reports tool failure with exit code and stderr excerpt', async () => {
    const result = await captureClipboardImage({
      ...options,
      runProcess: fakeRunner(() => ({ status: 1, stderr: 'something broke' })),
    })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'read-failed')
    assert.match(result.message, /exit code 1/)
    assert.match(result.message, /something broke/)
  })

  it('reports a killed process as a read failure', async () => {
    const result = await captureClipboardImage({
      ...options,
      runProcess: fakeRunner(() => ({ status: null, timedOut: true })),
    })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'read-failed')
    assert.match(result.message, /terminated/)
  })

  it('rejects output that is not an image', async () => {
    const result = await captureClipboardImage({
      ...options,
      runProcess: fakeRunner(() => ({ stdout: Buffer.from('plain text', 'utf8') })),
    })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'read-failed')
    assert.match(result.message, /not a recognizable image/)
  })

  it('rejects clipboard images over the per-image input cap', async () => {
    const result = await captureClipboardImage({
      ...options,
      runProcess: fakeRunner(() => ({ stdout: Buffer.alloc(MAX_CLIPBOARD_IMAGE_BYTES + 1, 7) })),
    })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'image-too-large')
    assert.match(result.message, /per-image input limit/)
  })

  it('reports BMP bytes as an unsupported clipboard format', async () => {
    const result = await captureClipboardImage({
      ...options,
      runProcess: fakeRunner(() => ({ stdout: makeBmpBytes() })),
    })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'unsupported-clipboard-format')
    assert.match(result.message, /BMP/)
  })
})

describe('captureClipboardImage on macOS', () => {
  const options = { platform: 'darwin' as const, env: {} }

  it('converts a TIFF clipboard export to PNG and cleans up the temp file', async () => {
    const tiff = await makeTiffBytes()
    let exportedPath: string | null = null
    const runner = fakeRunner(async (command) => {
      assert.equal(command.file, 'osascript')
      exportedPath = command.args[2]!
      await writeFile(exportedPath, tiff)
      return { status: 0 }
    })
    const result = await captureClipboardImage({ ...options, runProcess: runner })
    assert.ok(result.ok, JSON.stringify(result))
    assert.equal(result.format, 'png')
    assert.equal(result.sourceFormat, 'tiff')
    assert.equal(result.converted, true)
    assert.equal(sniffImage(result.bytes)?.format, 'png')
    assert.notEqual(exportedPath, null)
    await assert.rejects(stat(exportedPath!), /ENOENT/)
  })

  it('passes a PNG clipboard export through unchanged', async () => {
    const png = await loadFixtureBytes('transparent.png')
    const runner = fakeRunner(async (command) => {
      await writeFile(command.args[2]!, png)
      return { status: 0 }
    })
    const result = await captureClipboardImage({ ...options, runProcess: runner })
    assert.ok(result.ok)
    assert.equal(result.format, 'png')
    assert.equal(result.converted, false)
    assert.deepEqual(result.bytes, png)
  })

  it('maps the AppleScript no-image marker to no-image', async () => {
    const result = await captureClipboardImage({
      ...options,
      runProcess: fakeRunner(() => ({
        status: 1,
        stderr: `execution error: ${MACOS_NO_IMAGE_MARKER} (-2700)`,
      })),
    })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'no-image')
    assert.ok(result.message.includes(CLIPBOARD_IMAGE_FALLBACK_HINT))
  })

  it('reports a finished export with no file as a read failure', async () => {
    const result = await captureClipboardImage({
      ...options,
      runProcess: fakeRunner(() => ({ status: 0 })),
    })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'read-failed')
    assert.match(result.message, /produced no file/)
  })

  it('reports a missing osascript as dependency-missing', async () => {
    const result = await captureClipboardImage({
      ...options,
      runProcess: fakeRunner(() => ({ notFound: true })),
    })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'dependency-missing')
    assert.match(result.message, /osascript/)
  })
})

describe('captureClipboardImage on Linux', () => {
  const wayland = { platform: 'linux' as const, env: { WAYLAND_DISPLAY: 'wayland-0' } }
  const x11 = { platform: 'linux' as const, env: { DISPLAY: ':0' } }

  it('lists Wayland types, then reads the chosen one as-is', async () => {
    const png = await loadFixtureBytes('transparent.png')
    const runner = fakeRunner((command) => {
      if (command.file === 'wl-paste' && command.args[0] === '--list-types') {
        return { stdout: Buffer.from('text/plain\nimage/png\n', 'utf8') }
      }
      return { stdout: png }
    })
    const result = await captureClipboardImage({ ...wayland, runProcess: runner })
    assert.ok(result.ok, JSON.stringify(result))
    assert.equal(result.format, 'png')
    assert.equal(result.converted, false)
    assert.deepEqual(result.bytes, png)
    assert.deepEqual(runner.commands[1]!.args, ['--type', 'image/png'])
  })

  it('converts a TIFF-only Wayland clipboard to PNG', async () => {
    const tiff = await makeTiffBytes()
    const runner = fakeRunner((command) => {
      if (command.args[0] === '--list-types') {
        return { stdout: Buffer.from('image/tiff\n', 'utf8') }
      }
      return { stdout: tiff }
    })
    const result = await captureClipboardImage({ ...wayland, runProcess: runner })
    assert.ok(result.ok)
    assert.equal(result.format, 'png')
    assert.equal(result.sourceFormat, 'tiff')
    assert.equal(result.converted, true)
  })

  it('reads a JPEG off the X11 clipboard among non-image targets', async () => {
    const jpeg = await loadFixtureBytes('exif-orientation.jpg')
    const runner = fakeRunner((command) => {
      if (command.args.includes('TARGETS')) {
        return { stdout: Buffer.from('TIMESTAMP\nMULTIPLE\nUTF8_STRING\nimage/jpeg\n', 'utf8') }
      }
      return { stdout: jpeg }
    })
    const result = await captureClipboardImage({ ...x11, runProcess: runner })
    assert.ok(result.ok)
    assert.equal(result.format, 'jpeg')
    assert.equal(result.converted, false)
    assert.deepEqual(
      runner.commands[1]!.args,
      ['-selection', 'clipboard', '-output', '-target', 'image/jpeg'],
    )
  })

  it('reports a missing clipboard tool as dependency-missing with its package name', async () => {
    const result = await captureClipboardImage({
      ...wayland,
      runProcess: fakeRunner(() => ({ notFound: true })),
    })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'dependency-missing')
    assert.match(result.message, /wl-paste/)
    assert.match(result.message, /wl-clipboard/)

    const x11Result = await captureClipboardImage({
      ...x11,
      runProcess: fakeRunner(() => ({ notFound: true })),
    })
    assert.ok(!x11Result.ok)
    assert.equal(x11Result.reason, 'dependency-missing')
    assert.match(x11Result.message, /xclip/)
  })

  it('reports a text-only clipboard as no-image', async () => {
    const runner = fakeRunner(() => ({ stdout: Buffer.from('text/plain\nUTF8_STRING\n', 'utf8') }))
    const result = await captureClipboardImage({ ...wayland, runProcess: runner })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'no-image')
  })

  it('maps an empty-clipboard list failure to no-image', async () => {
    const runner = fakeRunner(() => ({ status: 1, stderr: 'Error: target TARGETS not available' }))
    const result = await captureClipboardImage({ ...x11, runProcess: runner })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'no-image')
  })

  it('reports other list failures as read failures with the stderr detail', async () => {
    const runner = fakeRunner(() => ({ status: 1, stderr: "Error: Can't open display: :99" }))
    const result = await captureClipboardImage({ ...x11, runProcess: runner })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'read-failed')
    assert.match(result.message, /Can't open display/)
  })

  it('reports a BMP-only clipboard as an unsupported format naming what was offered', async () => {
    const runner = fakeRunner(() => ({ stdout: Buffer.from('image/bmp\n', 'utf8') }))
    const result = await captureClipboardImage({ ...wayland, runProcess: runner })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'unsupported-clipboard-format')
    assert.match(result.message, /image\/bmp/)
    assert.ok(result.message.includes(CLIPBOARD_IMAGE_FALLBACK_HINT))
  })

  it('reports a failed image read as a read failure naming the type', async () => {
    const runner = fakeRunner((command, call) => (
      call === 0
        ? { stdout: Buffer.from('image/png\n', 'utf8') }
        : { status: 1, stderr: 'paste failed' }
    ))
    const result = await captureClipboardImage({ ...wayland, runProcess: runner })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'read-failed')
    assert.match(result.message, /image\/png/)
  })

  it('points a display-less Linux session (SSH/WSL) at the path entry', async () => {
    const result = await captureClipboardImage({
      platform: 'linux',
      env: {},
      runProcess: fakeRunner(() => { throw new Error('must not spawn anything') }),
    })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'dependency-missing')
    assert.match(result.message, /SSH or in WSL/)
    assert.ok(result.message.includes(CLIPBOARD_IMAGE_FALLBACK_HINT))
  })
})

describe('captureClipboardImage on other platforms', () => {
  it('reports unsupported platforms without spawning anything', async () => {
    const result = await captureClipboardImage({
      platform: 'freebsd',
      env: {},
      runProcess: fakeRunner(() => { throw new Error('must not spawn anything') }),
    })
    assert.ok(!result.ok)
    assert.equal(result.reason, 'dependency-missing')
    assert.match(result.message, /freebsd/)
  })
})
