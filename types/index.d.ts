export type Suggestion = {
  source: 'claude' | 'boundary' | 'cache'
  reason: string
  instructions?: string
  percent: number
  // True once the dialog above the prompt holds it; the band stands in otherwise.
  inDialog?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'smart-compact': { suggestion: Suggestion | null }
  }
}
