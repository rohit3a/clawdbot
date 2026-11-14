import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const HOME = '/home/t'
const CWD = `${HOME}/proj`
const SESSION = 'S1'
const CONTROL = `${HOME}/.clawd/control/${SESSION}.json`

type Wait = (script: string) => { exitCode: number; stdout?: string }

// The engine beneath the mod: an in-memory disk, a session, and the shell calls the mod makes.
function engine(on: On, files: Map<string, string>, wait: Wait, surfaces: string[] = ['terminal'], logs: string[] = []) {
  const run = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.model', () => ({ value: 'sonnet' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.surfaces', () => ({ value: surfaces as never }))
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'clawd' } }))
  on('fs.read', (_, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: `no file ${e.path}` }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => ({
    value: [...files.keys()].filter(f => f.startsWith(`${e.path}/`) && !f.slice(e.path.length + 1).includes('/')).map(f => ({ name: f.slice(e.path.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', (_, e) => {
    const [cmd, ...args] = e.argv
    if (cmd === 'sh' && args[1]?.includes('"$HOME" "$PPID"')) return run(0, `${HOME}\n4242`)
    if (cmd === 'sh' && /seq \d+/.test(args[1] ?? '')) {
      const r = wait(args[1])
      return run(r.exitCode, r.stdout ?? '')
    }
    if (cmd === 'rm') {
      for (const f of args.filter(a => a !== '-f')) files.delete(f)
      return run(0)
    }
    if (cmd === 'mv') {
      const [from = '', to = ''] = args
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      return run(0)
    }
    return run(0) // clawdctl flush
  })
}

const takenOver = (extra: object = {}) => JSON.stringify({ takenOver: true, mode: 'handle', by: 'bot', since: 1, ...extra })
const outbox = (files: Map<string, string>) =>
  [...files.entries()].filter(([f]) => f.startsWith(`${HOME}/.clawd/outbox/`)).map(([, v]) => JSON.parse(v) as { kind: string })
const noWait: Wait = () => {
  throw new Error('the mod held an ask it should not have')
}

test('an idle session leaves permission prompts to the screen', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files, noWait)
  on('tool.check', () => ({ decision: 'ask' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  const r = await $.tool.check({ tool: 'Write', input: { file_path: `${CWD}/a.txt`, content: 'a' } })

  expect(r.decision).toBe('ask')
  expect(outbox(files)).toEqual([])
})

test('a taken-over session waits for the bot and takes its answer', async ($, on) => {
  const files = new Map([[CONTROL, takenOver()]])
  engine(on, files, () => ({ exitCode: 0, stdout: '{"decision":"allow","reason":"ok from chat"}' }))
  on('tool.check', () => ({ decision: 'ask' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  const r = await $.tool.check({ tool: 'Bash', input: { command: 'npm test' } })

  expect(r.decision).toBe('allow')
  expect(outbox(files).map(e => e.kind)).toContain('ask')
  expect([...files.keys()].some(f => f.includes('/.clawd/asks/'))).toBe(false)
})

test('with no terminal the hold writes a line, and again each step, so the desktop app sees it alive', async ($, on) => {
  const files = new Map([[CONTROL, takenOver()]])
  const logs: string[] = []
  let steps = 0
  engine(on, files, () => (++steps < 3 ? { exitCode: 3 } : { exitCode: 0, stdout: '{"decision":"allow"}' }), [], logs)
  on('tool.check', () => ({ decision: 'ask' }))
  await $.session.start({ cwd: CWD, surface: null, isInteractive: false })

  const r = await $.tool.check({ tool: 'Bash', input: { command: 'npm test' } })

  expect(r.decision).toBe('allow')
  expect(logs.length).toBe(3)
  expect(logs[0]).toContain('waiting on its answer to Bash permission')
  expect(logs[1]).toContain('still waiting')
})

test('in a terminal the hold writes no lines; the status line says it', async ($, on) => {
  const files = new Map([[CONTROL, takenOver()]])
  const logs: string[] = []
  engine(on, files, () => ({ exitCode: 0, stdout: '{"decision":"allow"}' }), ['terminal'], logs)
  on('tool.check', () => ({ decision: 'ask' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  await $.tool.check({ tool: 'Bash', input: { command: 'npm test' } })

  expect(logs).toEqual([])
})

test('releasing a session mid-ask hands the ask back to the screen', async ($, on) => {
  const files = new Map([[CONTROL, takenOver()]])
  engine(on, files, () => ({ exitCode: 4 }))
  on('tool.check', () => ({ decision: 'ask' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  const r = await $.tool.check({ tool: 'Bash', input: { command: 'npm test' } })

  expect(r.decision).toBe('ask')
})

test('the bot answers a question in a taken-over session', async ($, on) => {
  const files = new Map([[CONTROL, takenOver()]])
  engine(on, files, () => ({ exitCode: 0, stdout: '{"answers":{"Tea or coffee?":"Tea"}}' }))
  on('tool.call', () => ({ result: 'the screen answered' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  const r = await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Tea or coffee?', header: 'Drink', multiSelect: false, options: [{ label: 'Tea', description: '' }, { label: 'Coffee', description: '' }] }],
  })

  expect(JSON.stringify(r)).toContain('Tea')
  expect(JSON.stringify(r)).not.toContain('the screen answered')
})

test('accept edits allows edits inside the folder and still asks outside it', async ($, on) => {
  const files = new Map([[CONTROL, takenOver({ permissions: 'acceptEdits' })]])
  let waited = 0
  engine(on, files, () => {
    waited++
    return { exitCode: 0, stdout: '{"decision":"deny"}' }
  })
  on('tool.check', () => ({ decision: 'ask' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  const inside = await $.tool.check({ tool: 'Write', input: { file_path: `${CWD}/a.txt`, content: 'a' } })
  const escaping = await $.tool.check({ tool: 'Write', input: { file_path: `${CWD}/../b.txt`, content: 'b' } })
  const outside = await $.tool.check({ tool: 'Write', input: { file_path: '/tmp/c.txt', content: 'c' } })

  expect(inside.decision).toBe('allow')
  expect(escaping.decision).toBe('deny')
  expect(outside.decision).toBe('deny')
  expect(waited).toBe(2)
})

test('dont ask denies without holding anything', async ($, on) => {
  const files = new Map([[CONTROL, takenOver({ permissions: 'dontAsk' })]])
  engine(on, files, noWait)
  on('tool.check', () => ({ decision: 'ask' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  const r = await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })

  expect(r.decision).toBe('deny')
})

test('the bot model and effort reach each request, and only while it has the session', async ($, on) => {
  const files = new Map([[CONTROL, takenOver({ model: 'haiku', effort: 'low' })]])
  engine(on, files, noWait)
  const seen: { model: string; effort?: unknown }[] = []
  on('turn.step', async function* (_, e) {
    seen.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  const step = { turnId: 't1', index: 0, model: 'sonnet', effort: 'high' as const, messageCount: 1 }
  for await (const _ of $.turn.step(step)) void _
  files.set(CONTROL, JSON.stringify({ takenOver: false }))
  for await (const _ of $.turn.step({ ...step, index: 1 })) void _

  expect(seen).toEqual([
    { model: 'haiku', effort: 'low' },
    { model: 'sonnet', effort: 'high' },
  ])
})

test('a turn that errors is pushed as failed, one that answers as done', async ($, on) => {
  const files = new Map([[CONTROL, takenOver()]])
  engine(on, files, noWait)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  await $.turn.complete({ turnId: 't1', answer: 'API error: overloaded', durationMs: 5, isAborted: false, reason: 'error' })
  await $.turn.complete({ turnId: 't2', answer: 'All done', durationMs: 5, isAborted: false, reason: 'answer' })

  expect(outbox(files).map(e => e.kind)).toEqual(expect.arrayContaining(['failed', 'turn_done']))
})

test('a long answer is cut at 8000 characters and the event says so', async ($, on) => {
  const files = new Map([[CONTROL, takenOver()]])
  engine(on, files, noWait)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  await $.turn.complete({ turnId: 't1', answer: 'x'.repeat(9000), durationMs: 5, isAborted: false, reason: 'answer' })
  await $.turn.complete({ turnId: 't2', answer: 'short', durationMs: 5, isAborted: false, reason: 'answer' })

  const done = outbox(files) as unknown as { answer: string; truncated?: boolean; answerChars?: number }[]
  const long = done.find(e => (e.answer?.length ?? 0) > 5)!
  expect(long.answer.length).toBe(8001)
  expect(long.truncated).toBe(true)
  expect(long.answerChars).toBe(9000)
  expect(done.find(e => e.answer === 'short')!.truncated).toBe(undefined)
})

test('the question in the desktop app\'s closing box goes to the bot with the turn', async ($, on) => {
  const files = new Map([[CONTROL, takenOver()]])
  engine(on, files, noWait)
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'shown' }))
  await $.session.start({ cwd: CWD, surface: null, isInteractive: false })

  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'Fixed.', ask: 'Ship 0.4.3?', actions: [{ label: 'Yes, ship it' }, { action: 'commit' }] } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Here is the fix.', durationMs: 5, isAborted: false, reason: 'answer' })
  await $.turn.complete({ turnId: 't2', answer: 'Next turn.', durationMs: 5, isAborted: false, reason: 'answer' })

  const done = outbox(files) as unknown as { answer: string; decision?: unknown }[]
  expect(done.find(e => e.answer === 'Here is the fix.')!.decision).toEqual({ question: 'Ship 0.4.3?', options: ['Yes, ship it', 'commit'] })
  expect(done.find(e => e.answer === 'Next turn.')!.decision).toBe(undefined)
})

test('a turn passes on its links and the media it made', async ($, on) => {
  const files = new Map([[CONTROL, takenOver()]])
  engine(on, files, noWait)
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_, e: any) => ({ result: e.tool === 'Bash' ? 'Created https://github.com/o/r/pull/12 and see https://example.com/docs' : 'ok' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  await $.turn.start({ turnId: 't1', text: 'go' } as never)
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/out/chart.png`, content: 'x' } as never)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' } as never)
  await $.turn.complete({ turnId: 't1', answer: 'Done: see https://preview.example.app/x. The demo is in ./out/demo.gif.', durationMs: 5, isAborted: false, reason: 'answer' })

  const done = (outbox(files) as unknown as { kind: string; links?: string[]; media?: string[] }[]).find(e => e.kind === 'turn_done')!
  expect(done.links).toEqual(['https://preview.example.app/x', 'https://github.com/o/r/pull/12'])
  expect(done.media).toEqual([`${CWD}/out/chart.png`, './out/demo.gif'])
})

test('AskGrok stops at the hourly cap', async ($, on) => {
  const files = new Map([[`${HOME}/.clawd/grok/${SESSION}.json`, JSON.stringify({ enabled: true, perHour: 1 })]])
  engine(on, files, () => ({ exitCode: 0, stdout: '{"result":"ok"}' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'clawd', args: 'status', origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 } })
  await $.turn.start({ turnId: 't1', text: 'go' } as never)

  const first = await $.tool.call({ tool: 'AskGrok', task: 'one' } as never)
  const second = await $.tool.call({ tool: 'AskGrok', task: 'two' } as never)
  expect(JSON.stringify(first)).toContain('ok')
  expect(JSON.stringify(second)).toContain('1 requests an hour')
})

test('at its budget a taken-over session ends the turn before the next request', async ($, on) => {
  const files = new Map([[CONTROL, takenOver({ budgetUsd: 1 })]])
  engine(on, files, noWait)
  on('session.usage', () => ({ value: { startedAt: 0, context: {} as never, rateLimits: [], cost: { usd: 1.2 } } }))
  let asked = 0
  on('turn.step', async function* (_, e) {
    asked++
    return { turnId: e.turnId, index: e.index, answer: 'model ran', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  let res: unknown
  const gen = $.turn.step({ turnId: 't1', index: 0, model: 'sonnet', effort: 'high' as const, messageCount: 1 })
  for (;;) {
    const n = await gen.next()
    if (n.done) { res = n.value; break }
  }

  expect(asked).toBe(0)
  expect(JSON.stringify(res)).toContain('budget')
  const budget = (outbox(files) as unknown as { kind: string; level?: string }[]).find(e => e.kind === 'budget')!
  expect(budget.level).toBe('stopped')
})

test('allowed for the session, the same command is not held again; another one is', async ($, on) => {
  const files = new Map([[CONTROL, takenOver()]])
  let held = 0
  engine(on, files, () => {
    held++
    return { exitCode: 0, stdout: '{"decision":"allow","remember":true}' }
  })
  on('tool.check', () => ({ decision: 'ask' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  const a = await $.tool.check({ tool: 'Bash', input: { command: 'npm test' } })
  const b = await $.tool.check({ tool: 'Bash', input: { command: 'npm test' } })
  const c = await $.tool.check({ tool: 'Bash', input: { command: 'npm run build' } })

  expect([a.decision, b.decision, c.decision]).toEqual(['allow', 'allow', 'allow'])
  expect(held).toBe(2)
})

test('a plan for approval reaches the bot whole', async ($, on) => {
  const files = new Map([[CONTROL, takenOver()]])
  engine(on, files, () => ({ exitCode: 0, stdout: '{"decision":"allow"}' }))
  on('tool.check', () => ({ decision: 'ask' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const plan = `# Plan\n${'- step\n'.repeat(200)}`

  await $.tool.check({ tool: 'ExitPlanMode', input: { plan } })

  const ask = (outbox(files) as unknown as { kind: string; summary?: string }[]).find(e => e.kind === 'ask')!
  expect(ask.summary).toBe(plan)
})

test('a session near the end of its context says so once', async ($, on) => {
  const files = new Map([[CONTROL, takenOver()]])
  engine(on, files, noWait)
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { percent: 86 } as never, rateLimits: [] } }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  await $.turn.complete({ turnId: 't1', answer: 'a', durationMs: 5, isAborted: false, reason: 'answer' })
  await $.turn.complete({ turnId: 't2', answer: 'b', durationMs: 5, isAborted: false, reason: 'answer' })

  const kinds = outbox(files).map(e => e.kind)
  expect(kinds.filter(k => k === 'context').length).toBe(1)
})

test('an idle session pushes nothing when a turn fails', async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files, noWait)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  await $.turn.complete({ turnId: 't1', answer: 'API error', durationMs: 5, isAborted: false, reason: 'error' })

  expect(outbox(files)).toEqual([])
})

// tool.list is raised by the engine, not by a test, so a second plugin asks for the list the session would get
const lister = {
  name: 'lister',
  register: (on: On) => {
    on('command.run', { command: 'list-tools' }, async $ => {
      return { text: (await $.tool.list()).map(t => t.name).join(',') }
    })
  },
}

test('headless runs without AskUserQuestion get the AskPerson tool', { plugins: [lister] }, async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files, noWait)
  on('tool.list', () => ({ value: [{ name: 'Bash', description: 'run', mcp: false }] }))

  const r = await $.command.run({ command: 'list-tools', args: '', origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 } })

  expect(JSON.stringify(r)).toContain('AskPerson')
})

test('AskGrok is offered only when the person opts in, and returns the bot answer', { plugins: [lister] }, async ($, on) => {
  const files = new Map<string, string>()
  engine(on, files, () => ({ exitCode: 0, stdout: '{"result":"3 payments today"}' }))
  on('tool.list', () => ({ value: [{ name: 'AskUserQuestion', description: 'ask', mcp: false }] }))
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const names = async () => JSON.stringify(await $.command.run({ command: 'list-tools', args: '', origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 } }))

  expect(await names()).not.toContain('AskGrok')
  const off = await $.tool.call({ tool: 'AskGrok', task: 'Check Razorpay' } as never)
  expect(JSON.stringify(off)).toContain('AskGrok is off')

  await $.command.run({ command: 'clawd', args: 'grok on', origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(await names()).toContain('AskGrok')
  const r = await $.tool.call({ tool: 'AskGrok', task: 'Check Razorpay payments today' } as never)
  expect(JSON.stringify(r)).toContain('3 payments today')
  expect(outbox(files).map(e => e.kind)).toContain('request')
})
