import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, ResolveInput, Timer } from 'claude-code'

import type { Suggestion } from '../types'
import { backupPlan } from './backup'
import { boundaryOf, cacheWarningDelayMs, formatTokens } from './signals'
import type { Boundary } from './signals'

const TOOL = 'request_compact'
const TOOL_ID = 'mcp__smart-compact__request_compact'
const DIALOG = 'smart-compact'

const suggestion = atom({ plugin: 'smart-compact', key: 'suggestion' } as const, null)

const DESCRIPTION = [
  'Ask to compact the conversation once this turn ends.',
  'Call it at a natural boundary: a task is finished and committed, a plan is',
  'written down, or the work is about to switch to an unrelated topic, and the',
  'details so far will not be needed verbatim. Do not call it mid-task.',
  'Put what the summary must keep (open TODOs, file paths, decisions) in',
  '`instructions`. The person may approve it with one click or it may run on its own.',
].join(' ')

// $-taking helpers live at the top level: the validator follows $ only into
// functions declared here.
async function percentNow($: Engine) {
  const { context } = await $.session.usage()
  return { percent: context.percent ?? 0, tokens: context.tokens }
}

// Offers it in a small dialog that takes the keyboard (arrows pick, Enter
// confirms, Esc hands the keys back). Where the surface will not place one, the
// band above the prompt carries the same buttons.
async function suggest($: Engine, next: Suggestion) {
  await update($, suggestion, () => next)
  const opened = await $.ui.open({ id: DIALOG, title: 'smart-compact', focus: true, closeOnEscape: true, rows: 1 })
  if (opened.isPlaced) await update($, suggestion, s => (s === null ? s : { ...s, inDialog: true }))
}

async function dismiss($: Engine) {
  await update($, suggestion, () => null)
  // A dialog that will not close must not stand between the person and the compact.
  await $.ui.close({ id: DIALOG }).catch((error: unknown) => $.ui.toast(`smart-compact: ${String(error)}`))
}

async function compact($: Engine, instructions?: string) {
  await dismiss($)
  try {
    const done = await $.session.compact(instructions ? { instructions } : undefined)
    if (done.skip !== undefined) $.ui.toast(`smart-compact: skipped (${done.skip})`)
  } catch {
    await compactAsCommand($, instructions)
  }
}

// A headless session (the desktop app's Code tab, the SDK) compacts only inside
// a turn, so it gets the person's own /compact, queued until the session is idle.
async function compactAsCommand($: Engine, instructions?: string) {
  try {
    await $.command.run({ command: 'compact', args: instructions ?? '' })
  } catch (error) {
    $.ui.toast(`smart-compact: could not compact, type /compact (${String(error)})`)
  }
}

function offer($: Engine, e: ResolveInput, current: Suggestion) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const lead = current.source === 'claude' ? 'Claude wants to compact' : 'Good moment to compact'

  return (
    <Box key="smart-compact" flexDirection="row" gap={1}>
      <Text>
        <Text bold>{lead}</Text>
        <Text dimColor>
          {' '}
          � {current.reason} � context {current.percent}%
        </Text>
      </Text>
      <Button
        key="compact"
        label="Compact now"
        hotkey="c"
        variant="primary"
        autoFocus
        onPress={() => compact($, current.instructions)}
      />
      <Button key="dismiss" label="Not now" hotkey="n" onPress={() => dismiss($)} />
    </Box>
  )
}

// A copy of the transcript as its own session before the compact replaces it.
// A failed copy is said out loud and the compact goes ahead: the old lines stay on disk.
async function backUp($: Engine, transcript: string, sessionId: string) {
  const plan = backupPlan(transcript, sessionId, crypto.randomUUID(), new Date(await $.clock.now()))
  const ran = await $.process.run(plan.argv, { env: plan.env, timeoutMs: 60_000 })
  if (ran.exitCode !== 0) {
    throw new Error(`exit ${ran.exitCode}: ${ran.stderr.trim().slice(0, 200)}`)
  }
}

export const register: Register = (on, options) => {
  const onRequest = options.onRequest === 'auto' ? 'auto' : 'ask'
  const minPercent = Number(options.minPercent ?? 40)
  const ttlMinutes = Number(options.cacheTtlMinutes ?? 5)
  const idleCompact = options.idleCompact === true
  const backup = options.backup !== false

  // Per turn: what landed during it, and what Claude asked for.
  let boundary: Boundary | null = null
  let requested: { reason: string; instructions?: string } | null = null
  let cacheTimer: Timer | null = null

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL,
      description: DESCRIPTION,
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'One line: why now is a good moment.' },
          instructions: { type: 'string', description: 'What the summary must keep.' },
        },
        required: ['reason'],
      },
    })
    return next(e)
  })

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    const input = e as unknown as { reason?: unknown; instructions?: unknown }
    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    const instructions =
      typeof input.instructions === 'string' && input.instructions.trim() !== ''
        ? input.instructions.trim()
        : undefined

    if (reason === '') {
      return { deny: 'request_compact needs a `reason`.' }
    }

    const { percent } = await percentNow($)
    if (percent < minPercent) {
      return {
        result: `Not queued: context is only ${percent}% full (threshold ${minPercent}%). Keep working.`,
      }
    }

    requested = { reason, instructions }
    const what =
      onRequest === 'auto'
        ? 'The conversation will compact as soon as this turn ends.'
        : 'The person will be offered a one-click compact when this turn ends.'
    return {
      result: `Queued at ${percent}% context. ${what} Finish the turn with a short status line.`,
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'smart-compact: request_compact failed; carry on.' },
  )

  // Both shells land work the same way; a subagent's commits are its own business.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !e.agentId) {
      boundary = boundaryOf(e.command, ran.isError === true) ?? boundary
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && !e.agentId) {
      boundary = boundaryOf(e.command, ran.isError === true) ?? boundary
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    cacheTimer?.cancel()
    cacheTimer = null
    boundary = null
    requested = null
    await dismiss($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId || e.isAborted) return done

    const { percent, tokens } = await percentNow($)
    const asked = requested
    const landed = boundary
    requested = null
    boundary = null

    if (asked) {
      if (onRequest === 'auto') {
        // session.compact rejects while a turn runs; this fires once it has ended.
        $.clock.after(300, () => void compact($, asked.instructions))
      } else {
        await suggest($, { source: 'claude', percent, ...asked })
      }
      return done
    }

    if (percent < minPercent) return done

    if (landed) {
      await suggest($, { source: 'boundary', percent, reason: landed === 'committed' ? 'You just committed' : 'Tests just went green' })
    }

    cacheTimer?.cancel()
    cacheTimer = $.clock.after(cacheWarningDelayMs(ttlMinutes), () => {
      cacheTimer = null
      if (idleCompact) {
        void compact($)
        return
      }
      void suggest($, {
        source: 'cache',
        percent,
        reason: `Prompt cache expires in ~1 min, then ${formatTokens(tokens)} re-send at full price`,
      })
    })

    return done
  })

  // Every compact, the person's /compact and auto-compact included, not only ours.
  on('classic.PreCompact', async ($, e, next) => {
    if (backup) {
      await backUp($, e.transcript_path, e.session_id).catch((error: unknown) =>
        $.ui.toast(`smart-compact: no backup this time (${error instanceof Error ? error.message : String(error)})`),
      )
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Esc on the dialog means not now.
  on('ui.close', { id: DIALOG }, async ($, e, next) => {
    await update($, suggestion, () => null)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: DIALOG }, async ($, e, next) => {
    const current = await read($, suggestion)
    if (current === null) return next(e)
    return offer($, e, current)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, suggestion)
    if (current === null || current.inDialog || e.props.hasSurvey) return next(e)
    return offer($, e, current)
  })
}
