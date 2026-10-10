import type { CoordinatorNote } from './types.js'

export const NOTE_QUEUE_MAX = 32

/** Appends `note`, replacing any older note from the same thread; oldest dropped past the cap. */
export function enqueueNote(notes: readonly CoordinatorNote[], note: CoordinatorNote): CoordinatorNote[] {
  const next = [...notes.filter((n) => n.threadId !== note.threadId), note]
  return next.length > NOTE_QUEUE_MAX ? next.slice(next.length - NOTE_QUEUE_MAX) : next
}

export function takeNotes(notes: readonly CoordinatorNote[]): { taken: CoordinatorNote[]; rest: CoordinatorNote[] } {
  return { taken: [...notes], rest: [] }
}
