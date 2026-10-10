import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { boundaryOf, cacheWarningDelayMs, formatTokens } from '../hooks/signals'

const TOOL = 'mcp__smart-compact__request_compact'
const SURFACES = ['terminal', 'desktop'] as const
const BAND = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4 }, view: {} }
const TURN = { answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' } as const

// The world beneath the plugin: a context window at `percent`, a compaction
// that records what it was told, and Bash calls that succeed.
function world(on: On, percent: number) {
  const compactions: (string | undefined)[] = []
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: percent * 2000, window: 200_000, percent }, rateLimits: [] },
  }) as never)
  on('session.compact', (_$, e) => {
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
})
