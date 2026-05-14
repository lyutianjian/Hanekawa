import { useState, useEffect } from 'react'
import { SessionStore, type SessionMeta } from '../../sessions/service.js'
export function useSessionManager(cwd: string, resumeSessionId?: string) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sessionMeta, setSessionMeta] = useState<SessionMeta | null>(null)
  const [store, setStore] = useState<SessionStore | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function init() {
      const newStore = new SessionStore(cwd)
      await newStore.init()

      if (cancelled) return

      setStore(newStore)

      if (resumeSessionId) {
        const existing = await newStore.resolve(resumeSessionId)
        if (cancelled) return

        if (!existing) {
          setError(`Session not found: ${resumeSessionId}`)
          return
        }
        setSessionMeta(existing)
        setSessionId(existing.id)
      } else {
        const session = await newStore.create()
        if (cancelled) return

        setSessionMeta(session)
        setSessionId(session.id)
      }
    }

    init().catch((err) => {
      if (!cancelled) {
        setError(err.message ?? String(err))
      }
    })

    return () => {
      cancelled = true
      setStore(null)
      setSessionId(null)
      setSessionMeta(null)
      setError(null)
    }
  }, [cwd, resumeSessionId])

  return {
    sessionId,
    sessionMeta,
    store,
    error,
  }
}
