import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  IMAGE_PROCESS_DEFAULTS,
  convertImageBytesToPng,
  sniffImage,
} from '../../tools/imageFile.js'
import type { SniffedImageFormat } from '../../tools/imageFile.js'

/**
 * System-clipboard image capture for the TUI (design doc §6.2, session S13).
 *
 * Acquisition only: this module turns "the user asked to paste an image" into
 * pipeline-ready bytes. It is called exclusively from user-triggered actions
 * (the `/paste-image` command and the Ctrl+V hook arrive with S14) and never
 * polls, samples, or reads the clipboard on its own.
 *
 * Platform capture (design doc §6.2 table):
 *
 *  - Windows: the *system* Windows PowerShell in an STA process, reading the
 *    clipboard through the .NET `Clipboard` API — not `Get-Clipboard`, whose
 *    image handling differs across PowerShell versions. `GetImage` converts
 *    whatever bitmap the clipboard holds (DIB/BMP included) and the script
 *    saves PNG, so the bitmap→PNG conversion happens on the capture side
 *    before Node ever sees bytes.
 *  - macOS: `osascript` running a fixed AppleScript that writes the clipboard
 *    as PNG (falling back to TIFF) to a fresh temp file.
 *  - Linux Wayland: `wl-paste`; Linux X11: `xclip`. Both list the offered
 *    types first, then read the best one — PNG preferred, and TIFF/AVIF/HEIC
 *    re-encoded as PNG via `convertImageBytesToPng` before the pipeline sees
 *    them.
 *
 * Every command is spawned as `(file, args)` with an argument array — never a
 * shell string — so no clipboard content is ever parsed by a shell. Failure
 * modes are structured and distinguishable (`no-image`,
 * `dependency-missing`, `read-failed`, `unsupported-clipboard-format`,
 * `image-too-large`), each message ending with the fallback that always works:
 * paste a full image path or use an in-project `@image` mention.
 */

/** Every failure message ends with this: the path entry is the way out when
 * the clipboard cannot be read at all (WSL, SSH, missing tools). */
export const CLIPBOARD_IMAGE_FALLBACK_HINT =
  'Paste the full path of an image file instead, or reference a project image with @path/to/image.'

export const CLIPBOARD_CAPTURE_ERROR_REASONS = [
  /** The clipboard was readable but holds no image. */
  'no-image',
  /** The platform tool or display server this capture needs is absent. */
  'dependency-missing',
  /** The tool ran and failed, or its output was not a decodable image. */
  'read-failed',
  /** The clipboard holds an image only in formats nothing here can decode. */
  'unsupported-clipboard-format',
  /** The clipboard image exceeds the raw per-image input cap. */
  'image-too-large',
] as const

export type ClipboardCaptureErrorReason = typeof CLIPBOARD_CAPTURE_ERROR_REASONS[number]

/** Formats a finished capture can hand to the import pipeline. */
export type CapturedImageFormat = 'png' | 'jpeg' | 'webp' | 'gif'

export type ClipboardCaptureResult =
  | {
      ok: true
      /** Image bytes ready for `ImageAttachmentService.importImage`. */
      bytes: Buffer
      /** Format of `bytes` after capture-side normalization. */
      format: CapturedImageFormat
      /** Format the clipboard itself held; equals `format` unless converted. */
      sourceFormat: SniffedImageFormat
      /** True when a bitmap was re-encoded as PNG on the capture side. */
      converted: boolean
    }
  | { ok: false; reason: ClipboardCaptureErrorReason; message: string }

/** The capture-side cap matches the pipeline's raw-input cap (design doc §8):
 * anything bigger can never be imported, so it fails here with a clear reason
 * instead of dying later in the store. */
export const MAX_CLIPBOARD_IMAGE_BYTES = IMAGE_PROCESS_DEFAULTS.maxInputBytes

/** One spawned capture helper: a program plus its argument vector. */
export interface ClipboardCommand {
  file: string
  args: readonly string[]
}

// ---------------------------------------------------------------------------
// Platform selection (pure)
// ---------------------------------------------------------------------------

export type ClipboardPlatform =
  | 'windows'
  | 'macos'
  | 'linux-wayland'
  | 'linux-x11'
  | 'unavailable'

/** Wayland wins when both displays are set: the native Wayland clipboard is
 * what `wl-paste` reads, and XWayland selections sync into it. */
export function resolveClipboardPlatform(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): ClipboardPlatform {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') {
    if (env.WAYLAND_DISPLAY) return 'linux-wayland'
    if (env.DISPLAY) return 'linux-x11'
  }
  return 'unavailable'
}

// ---------------------------------------------------------------------------
// Command construction (pure)
// ---------------------------------------------------------------------------

/** Exit status the Windows script reserves for "clipboard readable, no image". */
export const WINDOWS_NO_IMAGE_EXIT_CODE = 3

const WINDOWS_CAPTURE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$image = [System.Windows.Forms.Clipboard]::GetImage()',
  'if ($null -eq $image) { exit 3 }',
  '$memory = New-Object System.IO.MemoryStream',
  '$image.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)',
  '$stdout = [Console]::OpenStandardOutput()',
  '$stdout.Write($memory.ToArray(), 0, $memory.Length)',
  '$stdout.Flush()',
  'exit 0',
].join('\n')

export function windowsClipboardCommand(): ClipboardCommand {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_CAPTURE_SCRIPT],
  }
}

/** stderr marker the AppleScript raises when the clipboard holds no image. */
export const MACOS_NO_IMAGE_MARKER = 'HANEKAWA_NO_CLIPBOARD_IMAGE'

const MACOS_CAPTURE_APPLESCRIPT = [
  'on run argv',
  '\tset clipData to missing value',
  '\ttry',
  '\t\tset clipData to (the clipboard as «class PNGf»)',
  '\tend try',
  '\tif clipData is missing value then',
  '\t\ttry',
  '\t\t\tset clipData to (the clipboard as «class TIFFf»)',
  '\t\tend try',
  '\tend if',
  '\tif clipData is missing value then',
  `\t\terror "${MACOS_NO_IMAGE_MARKER}"`,
  '\tend if',
  '\tset fileRef to open for access (POSIX file (item 1 of argv)) with write permission',
  '\twrite clipData to fileRef',
  '\tclose access fileRef',
  'end run',
].join('\n')

/**
 * macOS: AppleScript writes the clipboard (PNG first, TIFF fallback) to a
 * caller-chosen temp file — `osascript` cannot emit raw binary on stdout. The
 * temp path arrives as its own `on run` argument, never interpolated into the
 * script text.
 */
export function macOSClipboardCommand(tempFilePath: string): ClipboardCommand {
  return { file: 'osascript', args: ['-e', MACOS_CAPTURE_APPLESCRIPT, tempFilePath] }
}

export function waylandListTypesCommand(): ClipboardCommand {
  return { file: 'wl-paste', args: ['--list-types'] }
}

export function waylandReadTypeCommand(mimeType: string): ClipboardCommand {
  return { file: 'wl-paste', args: ['--type', mimeType] }
}

export function x11ListTargetsCommand(): ClipboardCommand {
  return { file: 'xclip', args: ['-selection', 'clipboard', '-output', '-target', 'TARGETS'] }
}

export function x11ReadTypeCommand(mimeType: string): ClipboardCommand {
  return { file: 'xclip', args: ['-selection', 'clipboard', '-output', '-target', mimeType] }
}

// ---------------------------------------------------------------------------
// Offered-type parsing and selection (pure)
// ---------------------------------------------------------------------------

/** MIME types a clipboard may offer that pass straight to the pipeline. The
 * list order is the preference order; PNG first keeps screenshots lossless. */
const PASSTHROUGH_CLIPBOARD_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** Types the capture side re-encodes as PNG before the pipeline sees them. */
const CONVERTIBLE_CLIPBOARD_MIME_TYPES = ['image/tiff', 'image/avif', 'image/heic', 'image/heif'] as const

export function parseOfferedClipboardTypes(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

export function hasImageClipboardType(offered: readonly string[]): boolean {
  return offered.some((type) => type.startsWith('image/'))
}

export function selectClipboardImageType(
  offered: readonly string[],
): { mimeType: string; passthrough: boolean } | null {
  const types = new Set(offered)
  for (const mimeType of PASSTHROUGH_CLIPBOARD_MIME_TYPES) {
    if (types.has(mimeType)) return { mimeType, passthrough: true }
  }
  for (const mimeType of CONVERTIBLE_CLIPBOARD_MIME_TYPES) {
    if (types.has(mimeType)) return { mimeType, passthrough: false }
  }
  return null
}

/** stderr fragments the Linux list helpers emit when the clipboard is simply
 * empty — those are "no image", not a read failure. */
const EMPTY_CLIPBOARD_STDERR = /nothing to paste|no data source|not available|empty clipboard/i

export function isClipboardEmptyError(stderr: string): boolean {
  return EMPTY_CLIPBOARD_STDERR.test(stderr)
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

export interface ClipboardProcessOutcome {
  /** Exit status; `null` when the process was killed or never started. */
  status: number | null
  stdout: Buffer
  stderr: string
  /** The program could not be spawned (not installed / not on PATH). */
  notFound: boolean
  timedOut: boolean
}

export type ClipboardProcessRunner = (command: ClipboardCommand) => Promise<ClipboardProcessOutcome>

export const CLIPBOARD_CAPTURE_TIMEOUT_MS = 15_000

/**
 * Default runner: a direct `spawn(file, args)` with an argument vector, never
 * a shell string. Kills the child after {@link CLIPBOARD_CAPTURE_TIMEOUT_MS};
 * an absent program surfaces as `notFound` rather than a thrown error.
 */
async function spawnClipboardProcess(command: ClipboardCommand): Promise<ClipboardProcessOutcome> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command.file, command.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ status: null, stdout: Buffer.alloc(0), stderr: '', notFound: true, timedOut: false })
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, CLIPBOARD_CAPTURE_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        status: null,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
        notFound: (error as NodeJS.ErrnoException).code === 'ENOENT',
        timedOut,
      })
    })
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        status: code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
        notFound: false,
        timedOut,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface CaptureClipboardImageOptions {
  /** Overrides `process.platform`; tests drive every platform from any OS. */
  platform?: NodeJS.Platform
  /** Overrides `process.env`; decides Wayland vs X11 on Linux. */
  env?: Readonly<Record<string, string | undefined>>
  /** Replaces the process runner; tests inject scripted outcomes. */
  runProcess?: ClipboardProcessRunner
}

/**
 * Read the system clipboard's image once, on the user's explicit behalf.
 * Returns pipeline-ready bytes — PNG (converted when the clipboard offered a
 * bitmap) or a format the pipeline accepts as-is — or a structured failure
 * whose message already names the fallback that works everywhere.
 */
export async function captureClipboardImage(
  options: CaptureClipboardImageOptions = {},
): Promise<ClipboardCaptureResult> {
  const run = options.runProcess ?? spawnClipboardProcess
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  switch (resolveClipboardPlatform(platform, env)) {
    case 'windows':
      return captureFromWindows(run)
    case 'macos':
      return captureFromMacos(run)
    case 'linux-wayland':
      return captureFromLinux(run, waylandListTypesCommand, waylandReadTypeCommand, {
        tool: 'wl-paste',
        install: 'wl-clipboard',
        server: 'Wayland',
      })
    case 'linux-x11':
      return captureFromLinux(run, x11ListTargetsCommand, x11ReadTypeCommand, {
        tool: 'xclip',
        install: 'xclip',
        server: 'X11',
      })
    case 'unavailable':
    default:
      if (platform === 'linux') {
        return failure(
          'dependency-missing',
          'No display server was found (neither WAYLAND_DISPLAY nor DISPLAY), so the system clipboard cannot be read. This is expected over SSH or in WSL without an X server; clipboard sync across machines is not attempted.',
        )
      }
      return failure(
        'dependency-missing',
        `Clipboard image capture is not available on ${platform}.`,
      )
  }
}

async function captureFromWindows(run: ClipboardProcessRunner): Promise<ClipboardCaptureResult> {
  const outcome = await run(windowsClipboardCommand())
  if (outcome.notFound) {
    return failure(
      'dependency-missing',
      'Windows PowerShell (powershell.exe) was not found; it ships with Windows, so check PATH.',
    )
  }
  if (outcome.status === WINDOWS_NO_IMAGE_EXIT_CODE) {
    return failure('no-image', 'The clipboard does not contain an image.')
  }
  if (outcome.status !== 0) {
    return failure('read-failed', `Reading the image clipboard ${describeExit(outcome.status)}${stderrDetail(outcome.stderr)}.`)
  }
  return finalizeCapturedBytes(outcome.stdout, 'the clipboard image')
}

async function captureFromMacos(run: ClipboardProcessRunner): Promise<ClipboardCaptureResult> {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'hanekawa-clip-'))
  try {
    const tempFilePath = path.join(tempDir, 'clipboard-image')
    const outcome = await run(macOSClipboardCommand(tempFilePath))
    if (outcome.notFound) {
      return failure('dependency-missing', 'osascript was not found; it ships with macOS, so check PATH.')
    }
    if (outcome.status !== 0) {
      if (outcome.stderr.includes(MACOS_NO_IMAGE_MARKER)) {
        return failure('no-image', 'The clipboard does not contain an image.')
      }
      return failure('read-failed', `Reading the image clipboard ${describeExit(outcome.status)}${stderrDetail(outcome.stderr)}.`)
    }
    let bytes: Buffer
    try {
      bytes = await readFile(tempFilePath)
    } catch {
      return failure('read-failed', 'The clipboard export finished but produced no file.')
    }
    return finalizeCapturedBytes(bytes, 'the clipboard image')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

interface LinuxToolFacts {
  tool: string
  install: string
  server: string
}

async function captureFromLinux(
  run: ClipboardProcessRunner,
  listCommand: () => ClipboardCommand,
  readCommand: (mimeType: string) => ClipboardCommand,
  facts: LinuxToolFacts,
): Promise<ClipboardCaptureResult> {
  const listOutcome = await run(listCommand())
  if (listOutcome.notFound) {
    return failure(
      'dependency-missing',
      `${facts.tool} was not found; install ${facts.install} to read the ${facts.server} clipboard.`,
    )
  }
  if (listOutcome.status !== 0) {
    if (isClipboardEmptyError(listOutcome.stderr)) {
      return failure('no-image', 'The clipboard does not contain an image.')
    }
    return failure(
      'read-failed',
      `Listing the clipboard types ${describeExit(listOutcome.status)}${stderrDetail(listOutcome.stderr)}.`,
    )
  }
  const offered = parseOfferedClipboardTypes(listOutcome.stdout.toString('utf8'))
  const selected = selectClipboardImageType(offered)
  if (selected === null) {
    if (hasImageClipboardType(offered)) {
      const imageTypes = offered.filter((type) => type.startsWith('image/')).join(', ')
      return failure(
        'unsupported-clipboard-format',
        `The clipboard image is only available as ${imageTypes}, which cannot be decoded here. Copy the image again as PNG or JPEG, or save it to a file.`,
      )
    }
    return failure('no-image', 'The clipboard does not contain an image.')
  }
  const readOutcome = await run(readCommand(selected.mimeType))
  if (readOutcome.status !== 0) {
    return failure(
      'read-failed',
      `Reading the clipboard image (${selected.mimeType}) ${describeExit(readOutcome.status)}${stderrDetail(readOutcome.stderr)}.`,
    )
  }
  return finalizeCapturedBytes(readOutcome.stdout, `the clipboard image (${selected.mimeType})`)
}

/** Shared tail of every capture path: size-cap, sniff, and (for bitmaps the
 * pipeline rejects) the capture-side PNG conversion. */
async function finalizeCapturedBytes(
  bytes: Buffer,
  what: string,
): Promise<ClipboardCaptureResult> {
  if (bytes.byteLength === 0) {
    return failure('read-failed', `Reading ${what} produced no bytes.`)
  }
  if (bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
    return failure(
      'image-too-large',
      `${capitalize(what)} is ${bytes.byteLength.toLocaleString('en-US')} bytes; the per-image input limit is ${MAX_CLIPBOARD_IMAGE_BYTES.toLocaleString('en-US')} bytes. Crop or downscale the image before copying it.`,
    )
  }
  const sniffed = sniffImage(bytes)
  if (sniffed === null) {
    return failure('read-failed', `${capitalize(what)} is not a recognizable image.`)
  }
  const passthrough = PASSTHROUGH_FORMATS[sniffed.format]
  if (sniffed.supported && passthrough !== undefined) {
    return { ok: true, bytes, format: passthrough, sourceFormat: sniffed.format, converted: false }
  }
  const converted = await convertImageBytesToPng(bytes, what)
  if (!converted.ok) {
    // A bitmap nothing here can decode (BMP, HEIC on builds without libheif,
    // SVG…): the message names the format and the way out.
    return failure(
      converted.reason === 'unsupported-format' ? 'unsupported-clipboard-format' : 'read-failed',
      converted.message,
    )
  }
  if (converted.bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
    return failure(
      'image-too-large',
      `The PNG conversion of ${what} is ${converted.bytes.byteLength.toLocaleString('en-US')} bytes; the per-image input limit is ${MAX_CLIPBOARD_IMAGE_BYTES.toLocaleString('en-US')} bytes. Crop or downscale the image before copying it.`,
    )
  }
  return { ok: true, bytes: converted.bytes, format: 'png', sourceFormat: sniffed.format, converted: true }
}

const PASSTHROUGH_FORMATS: Readonly<Record<string, CapturedImageFormat>> = {
  png: 'png',
  jpeg: 'jpeg',
  webp: 'webp',
  gif: 'gif',
}

function failure(reason: ClipboardCaptureErrorReason, detail: string): ClipboardCaptureResult {
  return { ok: false, reason, message: `${detail} ${CLIPBOARD_IMAGE_FALLBACK_HINT}` }
}

function describeExit(status: number | null): string {
  return status === null
    ? 'was terminated before finishing (timed out)'
    : `failed with exit code ${status}`
}

function stderrDetail(stderr: string): string {
  const trimmed = stderr.trim()
  return trimmed === '' ? '' : `: ${trimmed.slice(0, 300)}`
}

function capitalize(text: string): string {
  return text === '' ? text : text[0]!.toUpperCase() + text.slice(1)
}
