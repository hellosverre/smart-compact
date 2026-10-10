// Reads a finished Bash call for a "work just landed" moment: the points where
// the conversation behind it is least likely to be needed verbatim again.

const COMMIT = /\bgit\s+(-C\s+\S+\s+)?commit\b/
const TESTS =
  /\b(vitest|jest|pytest|mocha|playwright\s+test|cargo\s+(test|nextest)|go\s+test|dotnet\s+test|(npm|pnpm|yarn|bun)\s+(run\s+)?test)\b/

export type Boundary = 'committed' | 'tests passed'

export function boundaryOf(command: string, isError: boolean): Boundary | null {
  if (isError) return null
  if (COMMIT.test(command)) return 'committed'
  if (TESTS.test(command)) return 'tests passed'
  return null
}

// One minute before expiry: late enough that the person has likely moved on,
// early enough that the summarizer still reads the context from cache.
export function cacheWarningDelayMs(ttlMinutes: number): number {
  const ttlMs = Math.max(1, ttlMinutes) * 60_000
  return Math.max(30_000, ttlMs - 60_000)
}

export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return 'the whole context'
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k tokens` : `${tokens} tokens`
}
