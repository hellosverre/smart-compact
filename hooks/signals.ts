// Reads a finished Bash call for a "work just landed" moment: the points where
// the conversation behind it is least likely to be needed verbatim again.

const COMMIT = /\bgit\s+(-C\s+\S+\s+)?commit\b/
const TESTS =
  /\b(vitest|jest|pytest|mocha|playwright\s+test|cargo\s+(test|nextest)|go\s+test|dotnet\s+test|(npm|pnpm|yarn|bun)\s+(run\s+)?test)\b(?![.\w-])/
// A command that only reads or prints: naming a runner or a commit is not running it.
const READS = /^\s*(cat|grep|rg|head|tail|less|ls|echo|which|sed|awk|find|fd|Select-String|Get-Content|Write-Output)\b/i
// After a pipe or a `;` the exit code is the last command's, not the tests'.
const HIDES_EXIT = /[|;\n]/

export type Boundary = 'committed' | 'tests passed'

export function boundaryOf(command: string, isError: boolean): Boundary | null {
  if (isError || READS.test(command)) return null
  if (COMMIT.test(command)) return 'committed'
  if (TESTS.test(command) && !HIDES_EXIT.test(command)) return 'tests passed'
  return null
}

// One minute before expiry: late enough that the person has likely moved on,
// early enough that the summarizer still reads the context from cache.
export function cacheWarningDelayMs(ttlMinutes: number): number {
  const ttlMs = Math.max(1, ttlMinutes) * 60_000
  return Math.max(30_000, ttlMs - 60_000)
}

// A timer that fires after the cache's whole lifetime (the machine slept through
// its moment) finds the cache gone: acting then re-reads the context at full price.
export function cacheExpired(elapsedMs: number, ttlMinutes: number): boolean {
  return elapsedMs >= Math.max(1, ttlMinutes) * 60_000
}

export function formatTokens(tokens: number | undefined): string {
  if (tokens === undefined) return 'the whole context'
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k tokens` : `${tokens} tokens`
}
