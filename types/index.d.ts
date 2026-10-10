export type Suggestion = {
  source: 'claude' | 'boundary' | 'cache'
  reason: string
  instructions?: string
  percent: number
}

declare module 'claude-code' {
  interface PluginState {
    'smart-compact': { suggestion: Suggestion | null }
  }
}
