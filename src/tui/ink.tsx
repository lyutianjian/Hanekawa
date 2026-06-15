import process from 'node:process'
import React, { useCallback, useContext, useEffect, useRef } from 'react'
import { render as inkRender } from 'ink'
import type { DOMElement, Instance, RenderOptions } from 'ink'
// @ts-ignore - Ink exposes cursor positioning only through this internal context.
import CursorContext from '../../node_modules/ink/build/components/CursorContext.js'
// @ts-ignore - Ink's public surface does not expose layout listeners.
import { addLayoutListener } from '../../node_modules/ink/build/dom.js'
// @ts-ignore - Ink stores live instances keyed by stdout stream.
import instances from '../../node_modules/ink/build/instances.js'
import { CursorParkingController } from './cursorParking.js'

export * from 'ink'
export type * from 'ink'

type InkInternalInstance = {
  log?: {
    reset?: () => void
    sync?: (value: string) => void
    setCursorPosition?: (position: CursorPosition | undefined) => void
  }
  cursorPosition?: CursorPosition
  lastOutput?: string
  lastOutputToRender?: string
  lastOutputHeight?: number
  fullStaticOutput?: string
}

type InternalRootNode = DOMElement & {
  onImmediateRender?: () => void
}

interface CursorPosition {
  x: number
  y: number
}

export interface InkFrameSnapshot {
  cursorPosition?: CursorPosition
  lastOutput: string
  lastOutputToRender: string
  lastOutputHeight: number
  fullStaticOutput: string
}

// ---------------------------------------------------------------------------
// Ink frame state snapshot/restore
// ---------------------------------------------------------------------------
// AlternateScreen renders disposable transcript content into the terminal's
// alternate buffer. Ink still updates its live frame bookkeeping while that
// happens. Snapshot the prompt frame before entering the alternate buffer, then
// restore it after returning to the primary buffer so the next prompt render can
// diff against the real primary-screen contents instead of replaying history.
// ---------------------------------------------------------------------------

export function snapshotInkFrameForStdout(stdout: NodeJS.WriteStream): InkFrameSnapshot | undefined {
  const inkInstance = instances.get(stdout) as InkInternalInstance | undefined
  if (!inkInstance) return undefined

  return {
    cursorPosition: inkInstance.cursorPosition
      ? { ...inkInstance.cursorPosition }
      : undefined,
    lastOutput: inkInstance.lastOutput ?? '',
    lastOutputToRender: inkInstance.lastOutputToRender ?? '',
    lastOutputHeight: inkInstance.lastOutputHeight ?? 0,
    fullStaticOutput: inkInstance.fullStaticOutput ?? '',
  }
}

export function restoreInkFrameForStdout(
  stdout: NodeJS.WriteStream,
  snapshot: InkFrameSnapshot | undefined,
): void {
  if (!snapshot) return
  const inkInstance = instances.get(stdout) as InkInternalInstance | undefined
  if (!inkInstance) return

  inkInstance.cursorPosition = snapshot.cursorPosition
    ? { ...snapshot.cursorPosition }
    : undefined

  inkInstance.lastOutput = snapshot.lastOutput
  inkInstance.lastOutputToRender = snapshot.lastOutputToRender
  inkInstance.lastOutputHeight = snapshot.lastOutputHeight
  inkInstance.fullStaticOutput = snapshot.fullStaticOutput

  // log.sync() is the only public-ish way to update log-update's private
  // previousOutput/line-count/cursor bookkeeping. Suppress its cursor write:
  // after EXIT_ALT_SCREEN the terminal has already restored the primary-screen
  // cursor, and writing a suffix that assumes "cursor at bottom" can drift.
  const outputToSync = snapshot.lastOutputToRender || `${snapshot.lastOutput}\n`
  withSuppressedStdoutWrites(stdout, () => {
    inkInstance.log?.setCursorPosition?.(inkInstance.cursorPosition)
    inkInstance.log?.sync?.(outputToSync)
  })
}

export function suspendInkStaticOutputForStdout(stdout: NodeJS.WriteStream): void {
  const inkInstance = instances.get(stdout) as InkInternalInstance | undefined
  if (!inkInstance) return
  inkInstance.fullStaticOutput = ''
}

function withSuppressedStdoutWrites(stdout: NodeJS.WriteStream, callback: () => void): void {
  const originalWrite = stdout.write
  stdout.write = function suppressedWrite(
    _chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    done?.()
    return true
  } as NodeJS.WriteStream['write']

  try {
    callback()
  } finally {
    stdout.write = originalWrite
  }
}

// ---------------------------------------------------------------------------
// useDeclaredCursor
// ---------------------------------------------------------------------------

export function useDeclaredCursor({
  line,
  column,
  active,
}: {
  line: number
  column: number
  active: boolean
}): (node: DOMElement | null) => void {
  const cursorContext = useContext(CursorContext)
  const nodeRef = useRef<DOMElement | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const latestRef = useRef({ line, column, active })
  latestRef.current = { line, column, active }

  const syncCursor = useCallback(() => {
    const node = nodeRef.current
    const latest = latestRef.current
    if (!latest.active || !node) {
      cursorContext.setCursorPosition(undefined)
      return
    }

    const offset = absoluteLayoutOffset(node)
    cursorContext.setCursorPosition({
      x: offset.x + Math.max(0, latest.column),
      y: offset.y + Math.max(0, latest.line),
    })
  }, [cursorContext])

  const setNode = useCallback((node: DOMElement | null) => {
    cleanupRef.current?.()
    cleanupRef.current = null
    nodeRef.current = node

    if (!node) {
      cursorContext.setCursorPosition(undefined)
      return
    }

    const root = findRootNode(node)
    if (!root) {
      cursorContext.setCursorPosition(undefined)
      return
    }

    cleanupRef.current = addLayoutListener(root, syncCursor)
    // Sync cursor position immediately on mount.  addLayoutListener only
    // fires on *changes* — if the layout was already computed before the
    // listener was attached (common after an alt-screen round-trip), the
    // initial position would be lost without this call.
    syncCursor()
    queueMicrotask(() => {
      if (nodeRef.current !== node) return
      if (!latestRef.current.active) return
      if (findRootNode(node) !== root) return
      const internalRoot = root as InternalRootNode
      internalRoot.onImmediateRender?.()
    })
  }, [cursorContext, syncCursor])

  useEffect(() => {
    return () => {
      cursorContext.setCursorPosition(undefined)
      cleanupRef.current?.()
      cleanupRef.current = null
    }
  }, [cursorContext])

  return setNode
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

export function render(node: React.ReactNode, options?: NodeJS.WriteStream | RenderOptions): Instance {
  const stdout = resolveStdout(options)
  const controller = new CursorParkingController(stdout)
  controller.patch()

  const instance = inkRender(node, options)

  return {
    ...instance,
    rerender(nextNode: React.ReactNode) {
      instance.rerender(nextNode)
    },
    unmount(error?: Error) {
      try {
        instance.unmount(error)
      } finally {
        controller.unpatch()
      }
    },
    async waitUntilExit() {
      try {
        return await instance.waitUntilExit()
      } finally {
        controller.unpatch()
      }
    },
    cleanup() {
      try {
        instance.cleanup()
      } finally {
        controller.unpatch()
      }
    },
  }
}

function resolveStdout(options?: NodeJS.WriteStream | RenderOptions): NodeJS.WriteStream {
  if (options && typeof (options as NodeJS.WriteStream).write === 'function') {
    return options as NodeJS.WriteStream
  }
  return (options as RenderOptions | undefined)?.stdout ?? process.stdout
}

function findRootNode(node: DOMElement): DOMElement | null {
  let current: DOMElement | undefined = node
  while (current.parentNode) {
    current = current.parentNode
  }
  return current.nodeName === 'ink-root' ? current : null
}

function absoluteLayoutOffset(node: DOMElement): { x: number; y: number } {
  let x = 0
  let y = 0
  let current: DOMElement | undefined = node

  while (current && current.nodeName !== 'ink-root') {
    const layout = current.yogaNode?.getComputedLayout()
    x += layout?.left ?? 0
    y += layout?.top ?? 0
    current = current.parentNode
  }

  return { x, y }
}
