import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'

type OverlayContextValue = {
  activeOverlays: Set<string>
  registerOverlay: (id: string) => void
  unregisterOverlay: (id: string) => void
}

const OverlayContext = createContext<OverlayContextValue | null>(null)

export function OverlayProvider({ children }: { children: React.ReactNode }) {
  const [activeOverlays, setActiveOverlays] = useState<Set<string>>(new Set())

  const registerOverlay = useCallback((id: string) => {
    setActiveOverlays(prev => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const unregisterOverlay = useCallback((id: string) => {
    setActiveOverlays(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  return (
    <OverlayContext.Provider value={{ activeOverlays, registerOverlay, unregisterOverlay }}>
      {children}
    </OverlayContext.Provider>
  )
}

export function useRegisterOverlay(id: string, enabled = true) {
  const ctx = useContext(OverlayContext)
  if (!ctx) throw new Error('useRegisterOverlay must be used within OverlayProvider')

  useEffect(() => {
    if (!enabled) return
    ctx.registerOverlay(id)
    return () => ctx.unregisterOverlay(id)
  }, [id, enabled, ctx.registerOverlay, ctx.unregisterOverlay])
}

export function useIsOverlayActive(): boolean {
  const ctx = useContext(OverlayContext)
  if (!ctx) return false
  return ctx.activeOverlays.size > 0
}

const NON_MODAL_OVERLAYS = new Set(['autocomplete'])

export function useIsModalOverlayActive(): boolean {
  const ctx = useContext(OverlayContext)
  if (!ctx) return false
  for (const id of ctx.activeOverlays) {
    if (!NON_MODAL_OVERLAYS.has(id)) return true
  }
  return false
}
