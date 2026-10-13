// Before a compact, a copy of the whole transcript as a session of its own, so
// /resume can go back to the conversation as it was. Compaction keeps the old
// lines on disk but resumes from its summary; the copy resumes from the full text.
//
// The copy runs as a host command: transcripts that need compacting are often
// past the 4 MiB a plugin's $.fs read or write takes.

const POSIX = 'sed "s/$SC_OLD/$SC_NEW/g" "$SC_IN" > "$SC_OUT" && printf "%s" "$SC_TAIL" >> "$SC_OUT"'
const WINDOWS =
  "$ErrorActionPreference = 'Stop'; " +
  '$text = [IO.File]::ReadAllText($env:SC_IN).Replace($env:SC_OLD, $env:SC_NEW); ' +
  '[IO.File]::WriteAllText($env:SC_OUT, $text + $env:SC_TAIL)'

export type BackupPlan = { argv: string[]; env: Record<string, string>; out: string }

const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')

// The /resume list shows a custom title, so the copy says what it is and when.
export function backupTitle(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `Before compact ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

export function backupPlan(transcript: string, sessionId: string, newId: string, at: Date): BackupPlan {
  const ids = /^[0-9a-f-]{36}$/i
  if (!ids.test(sessionId) || !ids.test(newId)) {
    throw new Error(`smart-compact backup: unexpected session id ${sessionId}`)
  }

  const slash = Math.max(transcript.lastIndexOf('/'), transcript.lastIndexOf('\\'))
  if (slash === -1 || !transcript.endsWith('.jsonl')) {
    throw new Error(`smart-compact backup: no transcript file at ${transcript}`)
  }

  const out = `${transcript.slice(0, slash + 1)}${newId}.jsonl`
  const tail = `${JSON.stringify({ type: 'custom-title', customTitle: backupTitle(at), sessionId: newId })}\n`
  const env = { SC_IN: transcript, SC_OUT: out, SC_OLD: sessionId, SC_NEW: newId, SC_TAIL: tail }
  const argv = isWindowsPath(transcript)
    ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', WINDOWS]
    : ['sh', '-c', POSIX]

  return { argv, env, out }
}
