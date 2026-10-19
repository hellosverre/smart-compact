import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { backupPlan, backupTitle } from '../hooks/backup'
import { boundaryOf, cacheWarningDelayMs, formatTokens } from '../hooks/signals'

const TOOL = 'mcp__smart-compact__request_compact'
const SURFACES = ['terminal', 'desktop'] as const
const BAND = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const TURN = { answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as const

// The world beneath the plugin: a context window at `percent`, a compaction
// that records what it was told, and Bash calls that succeed.
function world(on: On, percent: number | (() => number), dialog = false, headless = false) {
  const compactions: (string | undefined)[] = []
  on('session.usage', () => {
    const now = typeof percent === 'function' ? percent() : percent
    return { value: { startedAt: 0, context: { tokens: now * 2000, window: 200_000, percent: now }, rateLimits: [] } } as never
  })
  on('session.compact', (_$, e) => {
    if (headless) throw new Error('not available in a headless (-p / SDK) session yet')
    compactions.push(e.instructions)
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__smart-compact__${e.name}` } }) as never)
  on('session.start', (_$, e) => e as never)
  const ran = () => ({ result: { stdout: '', stderr: '', interrupted: false } as never })
  on('tool.call', { tool: 'Bash' }, ran)
  on('tool.call', { tool: 'PowerShell' }, ran)
  on('turn.complete', (_$, e) => ({ text: e.answer }) as never)
  on('prompt.submit', (_$, e) => e as never)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Box', children: [] }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: dialog ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.render', { component: 'Pane' }, () => ({ type: 'Box', children: [] }) as never)
  return compactions
}

async function start($: Engine) {
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
}

async function band($: Engine, surface: (typeof SURFACES)[number]) {
  return $.ui.mount({ plugin: 'smart-compact', surface, component: 'AbovePrompt', props: BAND })
}

describe('signals', () => {
  test('reads commits and green test runs as boundaries', () => {
    expect(boundaryOf('git commit -m "feat: x"', false)).toBe('committed')
    expect(boundaryOf('git -C repo commit -am wip', false)).toBe('committed')
    expect(boundaryOf('pnpm exec vitest run', false)).toBe('tests passed')
    expect(boundaryOf('cargo test --all', false)).toBe('tests passed')
    expect(boundaryOf('pnpm test', true)).toBe(null)
    expect(boundaryOf('git status', false)).toBe(null)
  })

  test('warns a minute before the cache expires, never sooner than 30s', () => {
    expect(cacheWarningDelayMs(5)).toBe(240_000)
    expect(cacheWarningDelayMs(60)).toBe(3_540_000)
    expect(cacheWarningDelayMs(1)).toBe(30_000)
    expect(formatTokens(184_300)).toBe('184k tokens')
  })
})

describe('request_compact', () => {
  test('turns a request down while the context is small', async ($, on) => {
    world(on, 12)
    await start($)
    const r = await $.tool.call({ tool: TOOL, reason: 'done' } as never)
    expect(r.text ?? String(r.result)).toMatch(/Not queued/)
  })

  for (const surface of SURFACES) {
    test(`ask mode offers a one-click band on ${surface}`, async ($, on) => {
      const compactions = world(on, 70)
      await start($)
      await $.tool.call({ tool: TOOL, reason: 'auth refactor shipped', instructions: 'keep TODOs' } as never)
      await $.turn.complete(TURN)

      const ui = await band($, surface)
      expect((await ui.find({ type: 'Text', text: /Claude wants to compact/ })) !== undefined).toBe(true)
      await ui.press({ key: 'compact' })
      expect(compactions).toEqual(['keep TODOs'])
    })
  }

  test('auto mode compacts once the turn has ended', { options: { onRequest: 'auto' } }, async ($, on) => {
    const clock = mock.clock(on)
    const compactions = world(on, 70)
    await start($)
    await $.tool.call({ tool: TOOL, reason: 'switching topic' } as never)
    await $.turn.complete(TURN)
    expect(compactions).toEqual([])
    await clock.advance(500)
    expect(compactions).toEqual([undefined])
  })
})

describe('dialog', () => {
  test('opens a focused dialog with the buttons, and the band stays clear', async ($, on) => {
    const compactions = world(on, 70, true)
    await start($)
    await $.tool.call({ tool: TOOL, reason: 'shipped', instructions: 'keep TODOs' } as never)
    await $.turn.complete(TURN)

    expect(await (await band($, 'terminal')).find({ key: 'compact' })).toBe(undefined)
    const dialog = await $.ui.mount({ plugin: 'smart-compact', surface: 'terminal', component: 'Pane', requestId: 'smart-compact', props: {} } as never)
    expect((await dialog.find({ key: 'dismiss' })) !== undefined).toBe(true)
    await dialog.press({ key: 'compact' })
    expect(compactions).toEqual(['keep TODOs'])
  })
})

describe('headless', () => {
  test('falls back to a queued /compact where session.compact is not available', async ($, on) => {
    world(on, 70, true, true)
    const commands: string[] = []
    on('command.run', (_$, e) => {
      commands.push(`/${e.command} ${e.args}`)
      return { text: 'compacted' }
    })
    await start($)
    await $.tool.call({ tool: TOOL, reason: 'shipped', instructions: 'keep TODOs' } as never)
    await $.turn.complete(TURN)

    const dialog = await $.ui.mount({ plugin: 'smart-compact', surface: 'desktop', component: 'Pane', requestId: 'smart-compact', props: {} } as never)
    await dialog.press({ key: 'compact' })
    expect(commands).toEqual(['/compact keep TODOs'])
  })
})

describe('smart timing', () => {
  test('suggests compacting after a commit', async ($, on) => {
    world(on, 55)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: done"' } as never)
    await $.turn.complete(TURN)
    const ui = await band($, 'terminal')
    expect((await ui.find({ type: 'Text', text: /You just committed/ })) !== undefined).toBe(true)
  })

  test('reads a green test run in PowerShell too', async ($, on) => {
    world(on, 55)
    await start($)
    await $.tool.call({ tool: 'PowerShell', command: 'pnpm exec vitest run' } as never)
    await $.turn.complete(TURN)
    const ui = await band($, 'terminal')
    expect((await ui.find({ type: 'Text', text: /Tests just went green/ })) !== undefined).toBe(true)
  })

  test('stays quiet after a commit when the context is small', async ($, on) => {
    world(on, 20)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)
    await $.turn.complete(TURN)
    const ui = await band($, 'terminal')
    expect(await ui.find({ key: 'compact' })).toBe(undefined)
  })

  test('stays quiet after a commit or green tests when suggestAfterWork is off', { options: { suggestAfterWork: false } }, async ($, on) => {
    world(on, 55)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: done"' } as never)
    await $.tool.call({ tool: 'Bash', command: 'pnpm test' } as never)
    await $.turn.complete(TURN)
    const ui = await band($, 'terminal')
    expect(await ui.find({ key: 'compact' })).toBe(undefined)
  })

  test('still warns before the cache expires when suggestAfterWork is off', { options: { suggestAfterWork: false } }, async ($, on) => {
    const clock = mock.clock(on)
    world(on, 60)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'git commit -m x' } as never)
    await $.turn.complete(TURN)
    await clock.advance(240_000)
    const ui = await band($, 'terminal')
    expect((await ui.find({ type: 'Text', text: /cache expires/ })) !== undefined).toBe(true)
  })

  test('still offers Claude\'s own request when suggestAfterWork is off', { options: { suggestAfterWork: false } }, async ($, on) => {
    world(on, 70)
    await start($)
    await $.tool.call({ tool: TOOL, reason: 'shipped' } as never)
    await $.turn.complete(TURN)
    const ui = await band($, 'terminal')
    expect((await ui.find({ type: 'Text', text: /Claude wants to compact/ })) !== undefined).toBe(true)
  })

  test('warns before the prompt cache expires', async ($, on) => {
    const clock = mock.clock(on)
    world(on, 60)
    await start($)
    await $.turn.complete(TURN)
    await clock.advance(240_000)
    const ui = await band($, 'terminal')
    expect((await ui.find({ type: 'Text', text: /cache expires/ })) !== undefined).toBe(true)
  })

  test('idle mode compacts before the cache expires', { options: { idleCompact: true } }, async ($, on) => {
    const clock = mock.clock(on)
    const compactions = world(on, 60)
    await start($)
    await $.turn.complete(TURN)
    await clock.advance(240_000)
    expect(compactions).toEqual([undefined])
  })

  test('a new prompt cancels the cache timer and clears the band', async ($, on) => {
    const clock = mock.clock(on)
    const compactions = world(on, 60)
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'pnpm test' } as never)
    await $.turn.complete(TURN)
    await $.prompt.submit({ text: 'next thing' } as never)
    await clock.advance(300_000)
    const ui = await band($, 'terminal')
    expect(await ui.find({ key: 'compact' })).toBe(undefined)
    expect(compactions).toEqual([])
  })

  test('a compact in between cancels the timer, so it does not compact twice', { options: { idleCompact: true, backup: false } }, async ($, on) => {
    const clock = mock.clock(on)
    const compactions = world(on, 60)
    on('classic.PreCompact', () => ({}) as never)
    await start($)
    await $.turn.complete(TURN)
    await $.classic.PreCompact({ trigger: 'manual', custom_instructions: null, transcript_path: '/p/t.jsonl', session_id: 's' })
    await clock.advance(300_000)
    expect(compactions).toEqual([])
  })

  test('the timer stays quiet when the context has shrunk below the threshold', { options: { idleCompact: true } }, async ($, on) => {
    const clock = mock.clock(on)
    let level = 60
    const compactions = world(on, () => level)
    await start($)
    await $.turn.complete(TURN)
    level = 5
    await clock.advance(300_000)
    const ui = await band($, 'terminal')
    expect(compactions).toEqual([])
    expect(await ui.find({ key: 'compact' })).toBe(undefined)
  })
})

describe('backup', () => {
  const ID = '263bc84a-6364-40f8-8898-b4aacc857e80'
  const NEW = '11111111-2222-3333-4444-555555555555'
  const AT = new Date(2026, 9, 13, 9, 5)

  test('copies beside the transcript under a new id, titled for /resume', () => {
    const plan = backupPlan(`/home/a/.claude/projects/x/${ID}.jsonl`, ID, NEW, AT)
    expect(plan.out).toBe(`/home/a/.claude/projects/x/${NEW}.jsonl`)
    expect(plan.argv.slice(0, 2)).toEqual(['sh', '-c'])
    expect(plan.env.SC_OLD).toBe(ID)
    expect(plan.env.SC_NEW).toBe(NEW)
    expect(JSON.parse(plan.env.SC_TAIL)).toEqual({ type: 'custom-title', customTitle: 'Before compact 2026-10-13 09:05', sessionId: NEW })
    expect(backupTitle(AT)).toBe('Before compact 2026-10-13 09:05')
  })

  test('uses PowerShell for a Windows path', () => {
    const plan = backupPlan(`C:\\Users\\a\\.claude\\projects\\x\\${ID}.jsonl`, ID, NEW, AT)
    expect(plan.argv[0]).toBe('powershell')
    expect(plan.out).toBe(`C:\\Users\\a\\.claude\\projects\\x\\${NEW}.jsonl`)
  })

  test('refuses an id that could break the copy', () => {
    expect(() => backupPlan(`/p/${ID}.jsonl`, 'x/g;e', NEW, AT)).toThrow()
    expect(() => backupPlan('/p/notes.txt', ID, NEW, AT)).toThrow()
  })

  test('backs up before the compact runs, and a failed copy does not stop it', async ($, on) => {
    const runs: string[][] = []
    const toasts: string[] = []
    let exitCode = 0
    on('process.run', (_$, e) => {
      runs.push([...e.argv])
      return { value: { exitCode, stdout: '', stderr: exitCode === 0 ? '' : 'disk full' } } as never
    })
    on('ui.toast', (_$, e) => {
      toasts.push(e.text)
      return { value: undefined } as never
    })
    on('clock.now', () => ({ value: AT.getTime() }) as never)
    on('classic.PreCompact', () => ({}) as never)

    await $.classic.PreCompact({ trigger: 'manual', custom_instructions: null, transcript_path: `/p/${ID}.jsonl`, session_id: ID })
    expect(toasts).toEqual([])
    expect(runs).toHaveLength(1)
    expect(toasts).toHaveLength(0)

    exitCode = 1
    await $.classic.PreCompact({ trigger: 'auto', custom_instructions: null, transcript_path: `/p/${ID}.jsonl`, session_id: ID })
    expect(runs).toHaveLength(2)
    expect(toasts[0]).toContain('no backup this time (exit 1: disk full)')
  })
})
