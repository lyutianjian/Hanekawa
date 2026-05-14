import React from 'react'
import { ThemedBox } from './ThemedBox.js'
import { ThemedText } from './ThemedText.js'

type Props = {
  children: React.ReactNode
  selected?: boolean
  indicator?: string
}

export function ListItem({ children, selected = false, indicator = '▸' }: Props) {
  return (
    <ThemedBox>
      <ThemedText color={selected ? 'success' : undefined} bold={selected}>
        {selected ? indicator : ' '}
      </ThemedText>
      <ThemedText bold={selected}>{children}</ThemedText>
    </ThemedBox>
  )
}
