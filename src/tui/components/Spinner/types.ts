export type SpinnerMode =
  | 'requesting'
  | 'thinking'
  | 'tool-input'
  | 'tool-use'
  | 'responding'
  | 'waiting'

export interface RGBColor {
  r: number
  g: number
  b: number
}