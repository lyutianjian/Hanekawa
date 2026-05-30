import process from 'node:process'
import React, { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef } from 'react'
import { render as inkRender, useBoxMetrics } from 'ink'
import type { DOMElement, Instance, RenderOptions } from 'ink'
import { CursorParkingController, type CursorTarget } from './cursorParking.js'

export * from 'ink'
export type * from 'ink'

type CursorDeclaration = CursorTarget & {
  node: DOMElement
}

type CursorDeclarationSetter = (
  declaration: CursorDeclaration | null,
  clearIfNode?: DOMElement | null,
) => void

const CursorDeclarationContext = createContext<CursorDeclarationSetter>(() => {})

export function useDeclaredCursor({
  line,
  column,
  active,
}: {
  line: number
  column: number
  active: boolean
}): (node: DOMElement | null) => void {
  const setCursorDeclaration = useContext(CursorDeclarationContext)
  const nodeRef = useRef<DOMElement | null>(null)
  const metrics = useBoxMetrics(nodeRef)

  const setNode = useCallback((node: DOMElement | null) => {
    nodeRef.current = node
  }, [])

  useLayoutEffect(() => {
    const node = nodeRef.current
    if (active && node && metrics.hasMeasured) {
      setCursorDeclaration({
        x: metrics.left + Math.max(0, column),
        y: metrics.top + Math.max(0, line),
        node,
      })
    } else {
      setCursorDeclaration(null, node)
    }
  })

  useLayoutEffect(() => {
    return () => {
      setCursorDeclaration(null, nodeRef.current)
    }
  }, [setCursorDeclaration])

  return setNode
}

export function render(node: React.ReactNode, options?: NodeJS.WriteStream | RenderOptions): Instance {
  const stdout = resolveStdout(options)
  const controller = new CursorParkingController(stdout)
  controller.patch()

  const wrappedNode = (
    <CursorDeclarationProvider controller={controller}>
      {node}
    </CursorDeclarationProvider>
  )
  const instance = inkRender(wrappedNode, options)

  return {
    ...instance,
    rerender(nextNode: React.ReactNode) {
      instance.rerender(
        <CursorDeclarationProvider controller={controller}>
          {nextNode}
        </CursorDeclarationProvider>,
      )
    },
    unmount(error?: Error) {
      controller.unpatch()
      instance.unmount(error)
    },
    async waitUntilExit() {
      try {
        return await instance.waitUntilExit()
      } finally {
        controller.unpatch()
      }
    },
    cleanup() {
      controller.unpatch()
      instance.cleanup()
    },
  }
}

function CursorDeclarationProvider({
  controller,
  children,
}: {
  controller: CursorParkingController
  children: React.ReactNode
}) {
  const activeNodeRef = useRef<DOMElement | null>(null)
  const setDeclaration = useCallback<CursorDeclarationSetter>((declaration, clearIfNode) => {
    if (declaration) {
      activeNodeRef.current = declaration.node
      controller.setTarget(declaration)
      return
    }

    if (clearIfNode !== undefined && activeNodeRef.current !== clearIfNode) {
      return
    }

    activeNodeRef.current = null
    controller.setTarget(null)
  }, [controller])
  const value = useMemo(() => setDeclaration, [setDeclaration])

  return (
    <CursorDeclarationContext.Provider value={value}>
      {children}
    </CursorDeclarationContext.Provider>
  )
}

function resolveStdout(options?: NodeJS.WriteStream | RenderOptions): NodeJS.WriteStream {
  if (options && typeof (options as NodeJS.WriteStream).write === 'function') {
    return options as NodeJS.WriteStream
  }
  return (options as RenderOptions | undefined)?.stdout ?? process.stdout
}
