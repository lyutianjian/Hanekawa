export interface SuggestionItem<TMetadata = unknown> {
  id: string
  displayText: string
  description?: string
  metadata?: TMetadata
}

export type SuggestionType = 'command' | 'none'
