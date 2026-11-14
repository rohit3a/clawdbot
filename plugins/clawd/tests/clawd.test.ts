import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const HOME = '/home/t'
const CWD = `${HOME}/proj`
const SESSION = 'S1'
const CONTROL = `${HOME}/.clawd/control/${SESSION}.json`

type Wait = (script: string) => { exitCode: number; stdout?: string }

// The engine beneath the mod: an in-memory disk, a session, and the shell calls the mod makes.
function engine(on: On, files: Map<string, string>, wait: Wait) {
  const run = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('session.id', () => ({ value: SESSION }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.model', () => ({ value: 'sonnet' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
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
    if (cmd === 'sh' && args[1]?.includes('printf %s "$HOME"')) return run(0, HOME)
    if (cmd === 'sh' && args[1]?.includes('seq 540')) {
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
