import type { EngineInterface, Register } from 'claude-code'

type $ = EngineInterface

type Mode = 'handle' | 'babysit'
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type Permissions = 'acceptEdits' | 'dontAsk'
type Control = { takenOver: boolean; mode: Mode; by: 'bot' | 'you'; since: number; reportEveryMin?: number; model?: string; effort?: Effort; permissions?: Permissions }
type Steer = { type: 'message'; text: string } | { type: 'interrupt' }
type PermissionAnswer = { decision: 'allow' | 'deny'; reason?: string }
type QuestionAnswer = { answers: Record<string, string> }
type Held<A> = { kind: 'answered'; answer: A } | { kind: 'released' }

const TICK_MS = 2000
const WAIT_STEP_S = 540
// the Claude desktop app ends a turn that sends nothing for about 15 minutes; a line in the transcript keeps it going
const KEEPALIVE_STEP_S = 480
const FLUSH_EVERY_MS = 5000
const FLUSH_BACKOFF_MAX_MS = 300_000
const ANSWER_CHARS = 1500

let home: string | undefined
let sessionId: string | undefined
let cwd = ''
let control: Control | undefined
// what the bot was last told about this session; hooks refresh control, only tick moves this
let announced: Control | undefined
let busy = false
let turnId: string | undefined
let lastAnswer = ''
let lastTurnAt = 0
let lastReportAt = 0
let lastFlushAt = 0
let flushGap = FLUSH_EVERY_MS
let holding: string | undefined
let ticking = false
// events still in the outbox; a released session keeps flushing until they are gone, then is idle
let unsent = false
let claimChecked = false

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

let pid: number | undefined

async function dir($: $): Promise<string> {
  if (!home) {
    // the shell's parent is this session's process; its pid lets clawdctl tell a live ask from one left by a dead session
    const [h = '', p = ''] = (await $.process.run(['sh', '-c', 'printf "%s\\n%s" "$HOME" "$PPID"'])).stdout.split('\n')
    home = h
    pid = Number(p) || undefined
  }
  return `${home}/.clawd`
}

async function myId($: $): Promise<string> {
  if (!sessionId) sessionId = await $.session.id()
  return sessionId
}

async function readJson<T>($: $, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

async function readControl($: $): Promise<Control | undefined> {
  const c = await readJson<Control>($, `${await dir($)}/control/${await myId($)}.json`)
  return c?.takenOver ? c : undefined
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

async function emit($: $, kind: string, details: object): Promise<void> {
  const base = await dir($)
  const id = newId(kind)
  const event = { id, at: Date.now(), kind, sessionId: await myId($), cwd, mode: control?.mode, ...details }
  await $.fs.write(`${base}/outbox/${id}.json`, JSON.stringify(event))
  await flush($, true)
}

async function flush($: $, soon: boolean): Promise<void> {
  const now = Date.now()
  if (!soon && now - lastFlushAt < flushGap) return
  lastFlushAt = now
  await $.process.run(['node', `${$.plugin.root}/bin/clawdctl.mjs`, 'flush', '--quiet'], { timeoutMs: 20_000 }).catch(() => undefined)
  const left = await $.fs.list(`${await dir($)}/outbox`).catch(() => [])
  unsent = left.some(f => f.name.endsWith('.json'))
  // a webhook that keeps failing is tried less and less often, not every few seconds
  flushGap = unsent ? Math.min(flushGap * 2, FLUSH_BACKOFF_MAX_MS) : FLUSH_EVERY_MS
}

async function writeLive($: $): Promise<void> {
  const base = await dir($)
  await $.fs.write(
    `${base}/live/${await myId($)}.json`,
    JSON.stringify({ sessionId: await myId($), cwd, busy, holding: holding ?? null, lastAnswer, lastTurnAt, updatedAt: Date.now(), model: await $.session.model().catch(() => undefined) }),
  )
}

async function removeFiles($: $, paths: string[]): Promise<void> {
  if (paths.length) await $.process.run(['rm', '-f', ...paths])
}

function showStatus($: $): void {
  if (!control) return $.ui.status(undefined)
  const mode = control.mode === 'babysit' ? 'babysit' : 'handle it'
  const runs = [control.model, control.effort, control.permissions].filter(Boolean).join(' ')
  $.ui.status(`Clawd Bot has this session · ${holding ? `waiting on ${holding}` : mode}${runs ? ` · ${runs}` : ''}`)
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// the bot's permission mode for this session, applied where Claude would ask; the user's own default mode is left alone
function byPermissions(c: Control, tool: string, input: unknown): { decision: 'allow' | 'deny'; reason: string } | undefined {
  if (c.permissions === 'dontAsk') return { decision: 'deny', reason: 'Not pre-approved, and Clawd Bot set this session to not ask. Find another way or say what you need.' }
  if (c.permissions !== 'acceptEdits' || !EDIT_TOOLS.has(tool)) return undefined
  const i = (input ?? {}) as Record<string, unknown>
  const file = typeof i.file_path === 'string' ? i.file_path : typeof i.notebook_path === 'string' ? i.notebook_path : ''
  const inside = cwd !== '' && file.startsWith(`${cwd.replace(/\/+$/, '')}/`) && !file.includes('/../')
  return inside ? { decision: 'allow', reason: 'Edits in this folder are accepted while Clawd Bot has the session.' } : undefined
}

function summarize(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  if (tool === 'Bash' && typeof i.command === 'string') return i.command.slice(0, 500)
  if (typeof i.file_path === 'string') {
    const size = typeof i.content === 'string' ? ` (${i.content.length} chars)` : ''
    return `${i.file_path}${size}`
  }
  const text = JSON.stringify(input) ?? ''
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

async function hold<A>($: $, kind: 'permission' | 'question', body: object, label: string): Promise<Held<A>> {
  const base = await dir($)
  const id = newId(kind)
  const session = await myId($)
  const askFile = `${base}/asks/${id}.json`
  const answerFile = `${base}/answers/${id}.json`
  const controlFile = `${base}/control/${session}.json`
  await $.fs.write(askFile, JSON.stringify({ id, kind, sessionId: session, cwd, mode: control?.mode, createdAt: Date.now(), pid, ...body }))
  holding = label
  showStatus($)
  await writeLive($)
  await emit($, 'ask', { askId: id, ask: kind, ...body })
  const started = Date.now()
  // with no terminal (the desktop app, an SDK host) no status line is drawn and the host watches for silence
  const quietSurface = !(await $.session.surfaces().catch(() => [])).includes('terminal')
  if (quietSurface) $.ui.log(`Clawd Bot has this session: waiting on its answer to ${label}.`)
  const script = [
    `for i in $(seq ${quietSurface ? KEEPALIVE_STEP_S : WAIT_STEP_S}); do`,
    `  if [ -f ${sh(answerFile)} ]; then cat ${sh(answerFile)}; exit 0; fi`,
    `  if ! grep -qs '"takenOver": *true' ${sh(controlFile)}; then exit 4; fi`,
    '  sleep 1',
    'done',
    'exit 3',
  ].join('\n')
  try {
    for (;;) {
      const r = await $.process.run(['sh', '-c', script], { timeoutMs: (WAIT_STEP_S + 30) * 1000 })
      if (r.exitCode === 0) return { kind: 'answered', answer: JSON.parse(r.stdout) as A }
      if (r.exitCode === 4) return { kind: 'released' }
      if (quietSurface) $.ui.log(`Clawd Bot has this session: still waiting on its answer to ${label} (${Math.round((Date.now() - started) / 60_000)} min).`)
    }
  } finally {
    holding = undefined
    await removeFiles($, [askFile, answerFile])
    await tick($)
    showStatus($)
    if (control) await writeLive($)
  }
}

async function applySteer($: $, s: Steer): Promise<void> {
  if (s.type === 'message') void $.prompt.submit({ text: s.text })
  else if (s.type === 'interrupt') {
    if (busy && turnId) await $.turn.abort({ turnId }).catch(() => undefined)
  }
}

async function drainInbox($: $): Promise<void> {
  const box = `${await dir($)}/inbox/${await myId($)}`
  const entries = await $.fs.list(box).catch(() => [])
  const files = entries.map(e => e.name).filter(n => n.endsWith('.json')).sort()
  for (const name of files) {
    const path = `${box}/${name}`
    const steer = await readJson<Steer>($, path)
    await removeFiles($, [path])
    if (steer) await applySteer($, steer)
  }
}

async function tick($: $): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const was = announced
    control = await readControl($)
    announced = control
    if (!was && control) {
      showStatus($)
      await writeLive($)
      await emit($, 'takeover', { by: control.by })
    } else if (was && !control) {
      showStatus($)
      await removeFiles($, [`${await dir($)}/live/${await myId($)}.json`])
      await emit($, 'released', {})
      return
    } else if (control && (was?.mode !== control.mode || was?.model !== control.model || was?.effort !== control.effort || was?.permissions !== control.permissions)) showStatus($)
    if (!control) {
      if (unsent) await flush($, false)
      return
    }
    await drainInbox($)
    const every = control.reportEveryMin
    if (every && every > 0 && Date.now() - Math.max(lastReportAt, control.since) >= every * 60_000) {
      lastReportAt = Date.now()
      await emit($, 'progress', { busy, holding: holding ?? null, lastAnswer, lastTurnAt })
    }
    await flush($, false)
  } finally {
    ticking = false
  }
}

// clawdctl start leaves a claim for its folder; the new session takes it before its first prompt runs
async function takeClaim($: $): Promise<void> {
  const base = await dir($)
  const entries = await $.fs.list(`${base}/claims`).catch(() => [])
  if (!entries.length) return
  const here = await $.session.cwd()
  for (const { name } of entries.filter(f => f.name.endsWith('.json')).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = `${base}/claims/${name}`
    const c = await readJson<Control & { cwd: string; at: number }>($, path)
    if (!c || c.cwd !== here || Date.now() - c.at > 180_000) continue
    const mine = `${base}/control/${await myId($)}.json`
    if ((await $.process.run(['mv', path, `${mine}.claim`])).exitCode !== 0) continue
    const { cwd: _cwd, at: _at, ...claimed } = c
    await $.fs.write(mine, JSON.stringify(claimed, null, 2))
    await removeFiles($, [`${mine}.claim`])
    return
  }
}

async function setClaim($: $, next: Control | undefined): Promise<void> {
  const path = `${await dir($)}/control/${await myId($)}.json`
  await $.fs.write(path, JSON.stringify(next ?? { takenOver: false }, null, 2))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    const base = await dir($)
    const left = await $.fs.list(`${base}/outbox`).catch(() => [])
    unsent = left.some(f => f.name.endsWith('.json'))
    $.clock.every(TICK_MS, () => void tick($).catch(() => undefined))
    await $.command.register({
      name: 'clawd',
      description: 'Hand this session to your bot, or take it back: on, off, babysit, handle, status',
      argumentHint: 'on | off | babysit | handle | status',
    })
    return next(e)
  })

  on('command.run', { command: 'clawd' }, async ($, e) => {
    const word = e.args.trim().toLowerCase() || 'status'
    const now = await readControl($)
    if (word === 'on' || word === 'babysit' || word === 'handle') {
      const mode: Mode = word === 'babysit' ? 'babysit' : word === 'handle' ? 'handle' : now?.mode ?? 'handle'
      await setClaim($, { takenOver: true, mode, by: now?.by ?? 'you', since: now?.since ?? Date.now(), reportEveryMin: now?.reportEveryMin, model: now?.model, effort: now?.effort, permissions: now?.permissions })
      await tick($)
      return { text: `Clawd Bot has this session (${mode === 'babysit' ? 'babysit: every ask goes to you' : 'handle it: the bot decides, asks you when unsure'}). /clawd off takes it back.` }
    }
    if (word === 'off') {
      await setClaim($, undefined)
      await tick($)
      return { text: 'You have this session again. Questions and permissions show here.' }
    }
    const id = await myId($)
    return { text: now ? `Clawd Bot has this session ${id} (${now.mode}).` : `Clawd is idle in session ${id}. /clawd on hands it to your bot.` }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (!claimChecked) {
        claimChecked = true
        await takeClaim($).catch(() => undefined)
        await tick($)
      }
      busy = true
      turnId = e.turnId
      if (control) await writeLive($)
    }
    return next(e)
  })

  // the bot's model and effort apply per request, so no /model dialog opens in a session nobody is watching
  on('turn.step', async function* ($, e, next) {
    const c = e.agentId === undefined ? await readControl($) : undefined
    let req = e
    if (c?.model && c.model !== e.model) req = { ...req, model: c.model }
    if (c?.effort && c.effort !== e.effort) req = { ...req, effort: c.effort as typeof e.effort }
    const res = yield* next(req)
    if (req !== e && res.stopReason === null && control) {
      const failed = { model: control.model, effort: control.effort }
      control = { ...control, model: undefined, effort: undefined }
      await setClaim($, control)
      showStatus($)
      await emit($, 'steer_failed', { ...failed, note: 'The session went back to its own model and effort.' })
    }
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      busy = false
      lastTurnAt = Date.now()
      lastAnswer = (e.answer ?? '').slice(0, ANSWER_CHARS)
      if (control) {
        await writeLive($)
        const failed = e.reason === 'error' || e.reason === 'refusal'
        await emit($, failed ? 'failed' : 'turn_done', { reason: e.reason, answer: lastAnswer, durationMs: e.durationMs })
      }
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    if (control) {
      await emit($, 'ended', {}).catch(() => undefined)
      await removeFiles($, [`${await dir($)}/live/${await myId($)}.json`]).catch(() => undefined)
    }
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (r.decision !== 'ask' || e.tool === 'AskUserQuestion' || e.tool === 'AskPerson') return r
    control = await readControl($)
    if (!control) return r
    const set = byPermissions(control, e.tool, e.input)
    if (set) return set
    const held = await hold<PermissionAnswer>($, 'permission', { tool: e.tool, summary: summarize(e.tool, e.input), reason: r.reason ?? null, subagent: e.agentId ?? null }, `${e.tool} permission`)
    if (held.kind === 'released') return r
    const { decision, reason } = held.answer
    return { decision: decision === 'allow' ? 'allow' : 'deny', reason: reason ?? (decision === 'allow' ? 'Allowed through Clawd Bot' : 'Denied through Clawd Bot') }
  })

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    control = await readControl($)
    if (!control) return next(e)
    const held = await hold<QuestionAnswer>($, 'question', { questions: e.questions }, 'a question')
    if (held.kind === 'released') return next(e)
    return { result: { questions: e.questions, answers: held.answer.answers } }
  })

  on('tool.list', async ($, e, next) => {
    const listed = await next(e)
    if (listed.value === undefined || listed.value.some(t => t.name === 'AskUserQuestion')) return listed
    return {
      value: [
        ...listed.value,
        {
          name: 'AskPerson',
          description: 'Ask the person running this session one to four multiple-choice questions and wait for the answers. Use it whenever you would ask the user to choose.',
          mcp: false,
          inputSchema: {
            type: 'object',
            properties: {
              questions: {
                type: 'array',
                minItems: 1,
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    question: { type: 'string' },
                    header: { type: 'string' },
                    options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] } },
                    multiSelect: { type: 'boolean' },
                  },
                  required: ['question', 'options'],
                },
              },
            },
            required: ['questions'],
          },
        },
      ],
    }
  })

  on('tool.call', { tool: /^AskPerson$/ }, async ($, e: any) => {
    control = await readControl($)
    if (!control) return { deny: 'Nobody can answer questions in this session. Decide yourself, or say what you need in your reply.' }
    const held = await hold<QuestionAnswer>($, 'question', { questions: e.questions }, 'a question')
    if (held.kind === 'released') return { deny: 'The person took this session back before answering.' }
    return { result: JSON.stringify({ answers: held.answer.answers }) }
  })
}
