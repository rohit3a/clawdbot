#!/usr/bin/env node
// clawdctl: drive Claude Code sessions on this machine for a bot (Clawd Bot), as a CLI or an MCP server.
// No dependencies, Node 18+. State lives in ~/.clawd, shared with the clawd mod inside each session.

import { execFile, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.3.0';
const HOME = os.homedir();
const DIR = process.env.CLAWD_HOME || path.join(HOME, '.clawd');
const PUSH_GAP_MS = 20_000;
const MAX_OUTBOX = 200;
const USER_PATH = process.env.PATH ?? '';
process.env.PATH = [path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(path.delimiter);
const CLAUDE = process.env.CLAUDE_BIN || 'claude';

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

// ---------- files ----------

const sub = (...p) => path.join(DIR, ...p);
function ensureDirs() {
  for (const d of ['control', 'claims', 'inbox', 'asks', 'answers', 'live', 'outbox']) fs.mkdirSync(sub(d), { recursive: true, mode: 0o700 });
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}
function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  fs.renameSync(tmp, file);
}
function listJson(dir) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
}
const config = () => readJson(sub('config.json')) ?? {};
const machine = () => config().machine || os.hostname().split('.')[0];

// ---------- sessions ----------

function agents(all = false) {
  try {
    const out = execFileSync(CLAUDE, ['agents', '--json', ...(all ? ['--all'] : [])], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
  } catch {
    return [];
  }
}

function controlOf(sessionId) {
  const c = readJson(sub('control', `${sessionId}.json`));
  return c?.takenOver ? c : undefined;
}

function openAsks() {
  return listJson(sub('asks')).map((n) => readJson(sub('asks', n))).filter(Boolean);
}

function describe(a, asks) {
  const control = controlOf(a.sessionId);
  const live = control ? readJson(sub('live', `${a.sessionId}.json`)) : undefined;
  const pending = asks.filter((k) => k.sessionId === a.sessionId);
  return {
    session: a.sessionId,
    shortId: a.kind === 'background' ? a.id : undefined,
    name: a.name ?? null,
    folder: a.cwd,
    kind: a.kind,
    status: pending.length ? `waiting on ${pending[0].kind}` : a.status === 'waiting' ? `waiting: ${a.waitingFor ?? 'input'}` : a.status,
    startedAt: a.startedAt ? new Date(a.startedAt).toISOString() : undefined,
    takenOver: !!control,
    mode: control?.mode,
    reportEveryMin: control?.reportEveryMin,
    model: control?.model ?? live?.model,
    effort: control?.effort,
    permissions: control?.permissions,
    asks: pending.map((k) => k.id),
    lastAnswer: live?.lastAnswer ? live.lastAnswer.slice(0, 600) : undefined,
  };
}

function resolve(ref) {
  if (!ref) refuse('Name a session: its id, the start of its id, its short id or its name.');
  const list = agents(true);
  const r = String(ref).toLowerCase();
  const exact = list.filter((a) => a.sessionId === ref || a.id === ref || a.name?.toLowerCase() === r);
  const loose = exact.length ? exact : list.filter((a) => (r.length >= 4 && a.sessionId?.startsWith(r)) || a.name?.toLowerCase().includes(r));
  if (loose.length === 1) return loose[0];
  if (loose.length > 1) refuse(`"${ref}" matches ${loose.length} sessions: ${loose.map((a) => `${a.name ?? a.sessionId} (${a.sessionId.slice(0, 8)})`).join(', ')}. Be more specific.`);
  refuse(`No session matches "${ref}". List sessions first.`);
}

function requireTaken(a) {
  if (!controlOf(a.sessionId)) refuse(`Session ${a.name ?? a.sessionId} is not taken over. Take it over first.`);
}

// ---------- commands ----------

const commands = {
  info() {
    let claude = 'unknown';
    try { claude = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim(); } catch {}
    const plugin = installed();
    return { machine: machine(), platform: process.platform, claude, clawdctl: VERSION, installed: plugin && { version: plugin.version, commit: plugin.gitCommitSha }, webhook: !!config().webhook?.url };
  },

  sessions({ all }) {
    const asks = openAsks();
    return { machine: machine(), sessions: agents(!!all).map((a) => describe(a, asks)) };
  },

  async start({ folder, prompt, name, model, effort, mode, permissionMode }) {
    if (!folder) refuse('Give the folder to start in.');
    const given = path.resolve(folder.replace(/^~(?=$|\/)/, HOME));
    if (!fs.existsSync(given)) refuse(`No folder at ${given}.`);
    const cwd = fs.realpathSync(given);
    const label = (name || `clawd-${path.basename(cwd)}`).replace(/[^\w.-]+/g, '-').slice(0, 60);
    const claimed = { takenOver: true, mode: mode === 'babysit' ? 'babysit' : 'handle', by: 'bot', since: Date.now() };
    // --bg hands the session to a pre-started process with its own id, so the new session takes this claim in its first turn
    const claim = sub('claims', `${Date.now()}-${randomBytes(3).toString('hex')}.json`);
    writeJson(claim, { ...claimed, cwd, at: Date.now() });
    const args = ['--bg', '--remote-control', label, '-n', label];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (permissionMode) args.push('--permission-mode', permissionMode);
    if (prompt) args.push(prompt);
    let out;
    try {
      out = execFileSync(CLAUDE, args, { cwd, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      fs.rmSync(claim, { force: true });
      const why = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
      refuse(why.includes('not trusted') ? `${cwd} is not trusted yet. Open Claude there once and accept the trust prompt, then try again.` : `Claude did not start: ${why.slice(0, 400)}`);
    }
    const shortId = /backgrounded\s*·\s*(\S+)/.exec(out)?.[1];
    let sessionId;
    for (let i = 0; shortId && !sessionId && i < 10; i++) {
      sessionId = agents(true).find((a) => a.id === shortId)?.sessionId;
      if (!sessionId) await new Promise((r) => setTimeout(r, 1000));
    }
    if (sessionId && !controlOf(sessionId)) writeJson(sub('control', `${sessionId}.json`), claimed);
    if (sessionId) fs.rmSync(claim, { force: true });
    const remoteUrl = shortId ? await remoteLink(shortId) : undefined;
    return { machine: machine(), session: sessionId ?? null, shortId, name: label, folder: cwd, takenOver: true, remoteUrl, attach: shortId ? `claude attach ${shortId}` : undefined, resume: sessionId ? `claude --resume ${sessionId}` : undefined };
  },

  take_over({ session, mode }) {
    const a = resolve(session);
    const now = controlOf(a.sessionId);
    writeJson(sub('control', `${a.sessionId}.json`), { takenOver: true, mode: mode === 'babysit' ? 'babysit' : mode === 'handle' ? 'handle' : now?.mode ?? 'handle', by: 'bot', since: now?.since ?? Date.now(), reportEveryMin: now?.reportEveryMin });
    return { session: a.sessionId, name: a.name, takenOver: true, note: 'The session mod picks this up within a few seconds. Questions and permissions now come to you.' };
  },

  release({ session }) {
    const a = resolve(session);
    writeJson(sub('control', `${a.sessionId}.json`), { takenOver: false });
    return { session: a.sessionId, name: a.name, takenOver: false, note: 'Released. Prompts show at the machine again; a question you were holding goes back to the local dialog.' };
  },

  set_mode({ session, mode }) {
    if (mode !== 'handle' && mode !== 'babysit') refuse('Mode is handle or babysit.');
    const a = resolve(session);
    const c = controlOf(a.sessionId) ?? refuse('Take the session over first.');
    writeJson(sub('control', `${a.sessionId}.json`), { ...c, mode });
    return { session: a.sessionId, mode };
  },

  set_report({ session, minutes }) {
    const a = resolve(session);
    const c = controlOf(a.sessionId) ?? refuse('Take the session over first.');
    const every = minutes === 'off' || !minutes ? undefined : Math.max(1, Number(minutes));
    writeJson(sub('control', `${a.sessionId}.json`), { ...c, reportEveryMin: every });
    return { session: a.sessionId, reportEveryMin: every ?? 'off' };
  },

  asks({ session }) {
    const asks = openAsks().filter((k) => !session || k.sessionId === session || k.sessionId.startsWith(session));
    return { machine: machine(), asks };
  },

  answer({ ask, decision, reason, pick, answers }) {
    const k = readJson(sub('asks', `${ask}.json`)) ?? refuse(`No open ask ${ask}. It may already be answered or withdrawn.`);
    let body;
    if (k.kind === 'permission') {
      if (decision !== 'allow' && decision !== 'deny') refuse('A permission is answered with decision allow or deny.');
      body = { decision, ...(reason ? { reason } : {}) };
    } else {
      const parsed = typeof answers === 'string' ? JSON.parse(answers) : answers;
      const questions = k.questions ?? [];
      const out = {};
      if (parsed && typeof parsed === 'object') {
        for (const [q, v] of Object.entries(parsed)) {
          const match = questions.find((x) => x.question === q) ?? questions[Number(q)];
          if (!match) refuse(`"${q}" is not one of this ask's questions.`);
          out[match.question] = String(v);
        }
      } else if (pick !== undefined) {
        if (questions.length !== 1) refuse('This ask has several questions; answer with answers, one per question.');
        out[questions[0].question] = String(pick);
      } else refuse('A question is answered with pick (one question) or answers (question text to answer).');
      body = { answers: out };
    }
    writeJson(sub('answers', `${ask}.json`), body);
    return { ask, answered: body };
  },

  send({ session, text }) {
    if (!text) refuse('Give the message text.');
    return steer(session, { type: 'message', text });
  },
  interrupt({ session }) { return steer(session, { type: 'interrupt' }); },
  set_model({ session, model }) {
    if (!model) refuse('Give a model, e.g. sonnet, opus, haiku, or "default" for the session\'s own.');
    return setRuns(session, { model: model === 'default' ? undefined : model });
  },
  set_permissions({ session, permissions }) {
    const allowed = ['default', 'acceptEdits', 'dontAsk'];
    if (!allowed.includes(permissions)) refuse(`Permission mode is one of ${allowed.join(', ')}. plan, auto and bypass are not offered: set them at the computer.`);
    return setRuns(session, { permissions: permissions === 'default' ? undefined : permissions });
  },
  set_effort({ session, effort }) {
    if (!EFFORTS.includes(effort) && effort !== 'default') refuse(`Effort is one of ${EFFORTS.join(', ')}, or "default".`);
    return setRuns(session, { effort: effort === 'default' ? undefined : effort });
  },

  stop({ session }) {
    const a = resolve(session);
    if (a.kind !== 'background') refuse('Only background sessions can be stopped from here. Interrupt and release an interactive one instead.');
    execFileSync(CLAUDE, ['stop', a.id], { encoding: 'utf8', timeout: 30_000 });
    fs.rmSync(sub('control', `${a.sessionId}.json`), { force: true });
    return { session: a.sessionId, stopped: true, resume: `claude --resume ${a.sessionId}` };
  },

  peek({ session, count }) {
    const a = resolve(session);
    const n = Math.min(50, Math.max(1, Number(count) || 8));
    const file = transcriptOf(a.sessionId);
    const messages = file ? lastMessages(file, n) : [];
    return { ...describe(a, openAsks()), messages };
  },

  async flush({ quiet }) {
    ensureDirs();
    const lock = sub('push.lock');
    try {
      fs.mkdirSync(lock);
    } catch {
      const age = Date.now() - (fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0);
      if (age > 60_000) fs.rmSync(lock, { recursive: true, force: true });
      return quiet ? undefined : { sent: 0, note: 'Another push is running.' };
    }
    try {
      const state = readJson(sub('push-state.json')) ?? {};
      const names = listJson(sub('outbox'));
      if (!names.length) return quiet ? undefined : { sent: 0 };
      for (const n of names.splice(0, Math.max(0, names.length - MAX_OUTBOX))) fs.rmSync(sub('outbox', n), { force: true });
      const hook = config().webhook;
      if (!hook?.url) return quiet ? undefined : { sent: 0, note: 'No webhook set. Run clawdctl config webhook.' };
      if (Date.now() - (state.lastPushAt ?? 0) < PUSH_GAP_MS) return quiet ? undefined : { sent: 0, note: 'Waiting out the gap between pushes.' };
      const events = names.map((n) => readJson(sub('outbox', n))).filter(Boolean);
      const byId = new Map(agents(true).map((a) => [a.sessionId, a]));
      for (const e of events) e.name = byId.get(e.sessionId)?.name ?? null;
      writeJson(sub('push-state.json'), { lastPushAt: Date.now() });
      const res = await post(hook, events);
      if (!res.ok) return quiet ? undefined : { sent: 0, status: res.status };
      for (const n of names) fs.rmSync(sub('outbox', n), { force: true });
      return quiet ? undefined : { sent: events.length };
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  },
};

function post(hook, events) {
  const auth = hook.auth ?? (hook.key ? `Bearer ${hook.key}` : undefined);
  return fetch(hook.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify({ machine: machine(), sentAt: new Date().toISOString(), events, text: events.map(line).join('\n') }),
    signal: AbortSignal.timeout(15_000),
  });
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function setRuns(ref, change) {
  const a = resolve(ref);
  const c = controlOf(a.sessionId) ?? refuse(`Session ${a.name ?? a.sessionId} is not taken over. Take it over first.`);
  const next = { ...c, ...change };
  writeJson(sub('control', `${a.sessionId}.json`), next);
  return { session: a.sessionId, model: next.model ?? 'session default', effort: next.effort ?? 'session default', permissions: next.permissions ?? 'session default', note: 'Applies from the next request, for as long as the bot has the session.' };
}

function steer(ref, item) {
  const a = resolve(ref);
  requireTaken(a);
  writeJson(sub('inbox', a.sessionId, `${Date.now()}-${randomBytes(3).toString('hex')}.json`), item);
  return { session: a.sessionId, queued: item.type, note: 'The session picks this up within a few seconds.' };
}

function line(e) {
  const who = `[${machine()}] ${e.name ?? path.basename(e.cwd ?? '') ?? e.sessionId?.slice(0, 8)}`;
  if (e.kind === 'ask' && e.ask === 'permission') return `${who} wants permission for ${e.tool}: ${e.summary} (ask ${e.askId}, mode ${e.mode})`;
  if (e.kind === 'ask') return `${who} asks: ${(e.questions ?? []).map((q) => `${q.question} [${(q.options ?? []).map((o) => o.label).join(' / ')}]`).join(' ')} (ask ${e.askId}, mode ${e.mode})`;
  if (e.kind === 'turn_done' && e.reason === 'aborted') return `${who} was interrupted. It had got to: ${(e.answer ?? '').slice(0, 300)}`;
  if (e.kind === 'turn_done') return `${who} finished a turn: ${(e.answer ?? '').slice(0, 300)}`;
  if (e.kind === 'takeover') return `${who}: Clawd Bot has this session now (${e.by === 'you' ? 'handed over at the machine' : 'taken over by the bot'}, mode ${e.mode}).`;
  if (e.kind === 'released') return `${who} is back with the person at the machine. Its asks show there again.`;
  if (e.kind === 'test') return `[${machine()}] Clawd Bot is connected.`;
  if (e.kind === 'ended') return `${who} ended.`;
  if (e.kind === 'steer_failed') return `${who} could not run on ${[e.model, e.effort].filter(Boolean).join(' ')}; it went back to its own model and effort.`;
  if (e.kind === 'failed') return `${who} failed (${e.reason}): ${(e.answer ?? '').slice(0, 300)}`;
  if (e.kind === 'progress') return `${who} progress: ${e.busy ? 'working' : 'idle'}${e.holding ? `, waiting on ${e.holding}` : ''}. Last: ${(e.lastAnswer ?? '').slice(0, 300)}`;
  return `${who} ${e.kind}`;
}

async function remoteLink(shortId) {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const logs = execFileSync(CLAUDE, ['logs', shortId], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/.exec(logs.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
      if (m) return m[0];
    } catch {}
  }
  return undefined;
}

function transcriptOf(sessionId) {
  const root = path.join(HOME, '.claude', 'projects');
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return undefined;
}

function lastMessages(file, n) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const len = Math.min(size, 2_000_000);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  const out = [];
  for (const raw of buf.toString('utf8').split('\n').reverse()) {
    if (out.length >= n) break;
    let row;
    try { row = JSON.parse(raw); } catch { continue; }
    if ((row.type !== 'user' && row.type !== 'assistant') || row.isMeta || row.isSidechain) continue;
    const c = row.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
    if (!text.trim() || text.startsWith('<')) continue;
    out.push({ role: row.type, at: row.timestamp, text: text.slice(0, 1500) });
  }
  return out.reverse();
}

// ---------- MCP ----------

const S = { type: 'string' };
const TOOLS = [
  ['machine_info', 'This machine: its name, platform, Claude Code version, and whether pushes to your webhook are set up.', {}, [], 'info'],
  ['list_sessions', 'Every Claude Code session running on this machine: id, name, folder, status (busy, idle, waiting on a question or permission), whether you have taken it over, its mode, open asks, and the last answer of a taken-over session.', { all: { type: 'boolean', description: 'Also list finished background sessions.' } }, [], 'sessions'],
  ['start_session', 'Start a new Claude Code session in the background, already taken over by you, with Remote Control on so the person can open it on their phone, the web or the Claude app. Always pass model and effort; Opus at high effort is costly for small jobs. Returns the Remote Control link and the attach command.', { folder: { ...S, description: 'Absolute folder, or ~/…' }, prompt: { ...S, description: 'The first message.' }, name: S, model: { ...S, description: 'e.g. sonnet, opus, haiku' }, effort: { ...S, description: 'low, medium, high, xhigh or max' }, mode: { ...S, enum: ['handle', 'babysit'] }, permissionMode: { ...S, enum: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'] } }, ['folder', 'prompt'], 'start'],
  ['take_over', 'Take over a running session: from now its questions and permissions come to you instead of the screen, and you can steer it. Ask the person first unless they told you to.', { session: S, mode: { ...S, enum: ['handle', 'babysit'] } }, ['session'], 'take_over'],
  ['release', 'Give a session back to the person at the machine. Any question you were holding goes back to the local dialog.', { session: S }, ['session'], 'release'],
  ['set_mode', 'handle: you answer routine questions and permissions yourself and ask the person when unsure or risky (pushing, deleting, deploying, anything leaving the machine). babysit: every ask goes to the person.', { session: S, mode: { ...S, enum: ['handle', 'babysit'] } }, ['session', 'mode'], 'set_mode'],
  ['list_asks', 'Open questions and permission requests from taken-over sessions on this machine.', { session: S }, [], 'asks'],
  ['answer', 'Answer an open ask. A permission takes decision allow or deny (and a reason the session will read). A question takes pick (the option label, for one question) or answers (an object from question text to answer).', { ask: S, decision: { ...S, enum: ['allow', 'deny'] }, reason: S, pick: S, answers: { type: 'object' } }, ['ask'], 'answer'],
  ['send_message', 'Send a message to a taken-over session, as if the person typed it. It runs when the session is next idle.', { session: S, text: S }, ['session', 'text'], 'send'],
  ['interrupt', 'Stop what a taken-over session is doing right now (like pressing Esc).', { session: S }, ['session'], 'interrupt'],
  ['set_model', 'Change the model of a taken-over session from its next request on, while you have it. "default" goes back to its own.', { session: S, model: S }, ['session', 'model'], 'set_model'],
  ['set_effort', 'Change the reasoning effort (low, medium, high, xhigh, max) of a taken-over session from its next request on, while you have it. "default" goes back to its own.', { session: S, effort: S }, ['session', 'effort'], 'set_effort'],
  ['set_permissions', 'Set how a taken-over session handles permission prompts while you have it: acceptEdits allows file edits inside its folder without asking, dontAsk denies anything not pre-approved, default goes back to asking you.', { session: S, permissions: { ...S, enum: ['default', 'acceptEdits', 'dontAsk'] } }, ['session', 'permissions'], 'set_permissions'],
  ['set_report', 'Push a short progress report for a taken-over session every N minutes, or "off".', { session: S, minutes: S }, ['session', 'minutes'], 'set_report'],
  ['peek', 'The last messages of a session and its state, to summarise it for the person.', { session: S, count: { type: 'number' } }, ['session'], 'peek'],
  ['stop_session', 'Stop a background session. Its conversation is kept and can be resumed.', { session: S }, ['session'], 'stop'],
].map(([name, description, properties, required, command]) => ({ name, description, inputSchema: { type: 'object', properties, required }, command }));

const INSTRUCTIONS = 'Clawd drives Claude Code sessions on this machine. Sessions are idle until taken over; once taken over, their questions and permissions come to you as asks, and you answer them with answer. In handle mode decide routine asks yourself and ask the person when unsure or when the action is risky; in babysit mode relay every ask to the person. Never approve something the person refused. Release a session when the person wants it back.';

async function rpc(msg) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return ok({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'clawd', version: VERSION }, instructions: INSTRUCTIONS });
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: TOOLS.map(({ command, ...t }) => t) });
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${params?.name}` } };
    try {
      const result = await commands[tool.command]({ ...(params.arguments ?? {}) });
      return ok({ content: [{ type: 'text', text: JSON.stringify(result ?? {}, null, 2) }] });
    } catch (e) {
      return ok({ isError: true, content: [{ type: 'text', text: e instanceof Refusal ? e.message : `Failed: ${e.message}` }] });
    }
  }
  if (id === undefined) return undefined;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method ${method}` } };
}

function mcpStdio() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      const reply = await rpc(msg);
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  });
}

function serveKey() {
  const file = sub('serve.key');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, randomBytes(32).toString('base64url'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

function tailnetAddress() {
  try { return execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 5000 }).split('\n')[0].trim() || undefined; } catch { return undefined; }
}

function serve({ host, port }) {
  const key = Buffer.from(serveKey());
  const bind = host || tailnetAddress() || refuse('No tailnet address found. Pass --host to choose where to listen.');
  const p = Number(port) || 7477;
  const server = http.createServer(async (req, res) => {
    const given = Buffer.from(/^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '');
    if (given.length !== key.length || !timingSafeEqual(given, key)) { res.writeHead(401).end(); return; }
    if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) { res.writeHead(405, { allow: 'POST' }).end(); return; }
    let body = '';
    for await (const c of req) { body += c; if (body.length > 1_000_000) { res.writeHead(413).end(); return; } }
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    const replies = (await Promise.all((Array.isArray(msg) ? msg : [msg]).map(rpc))).filter(Boolean);
    if (!replies.length) { res.writeHead(202).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(msg) ? replies : replies[0]));
  });
  server.listen(p, bind, () => process.stderr.write(`clawd MCP listening on http://${bind}:${p}/mcp\n`));
}

// what `claude plugin install` put on this machine, the copy each session's mod runs from
function installed() {
  const cfg = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
  const rows = readJson(path.join(cfg, 'plugins', 'installed_plugins.json'))?.plugins?.['clawd@clawdbot'];
  return Array.isArray(rows) ? rows.find(r => r.scope === 'user') ?? rows[0] : undefined;
}

// The shim runs the installed copy of clawdctl, found afresh on every run, so it always matches the mod
// after `claude plugin update`; plugin-root is the fallback for a copy run from its folder.
const LAUNCHER = `import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const home = os.homedir();
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return undefined; } };
let root;
try {
  const rows = JSON.parse(read(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'plugins', 'installed_plugins.json')) ?? '{}').plugins?.['clawd@clawdbot'] ?? [];
  root = (rows.find(r => r.scope === 'user') ?? rows[0])?.installPath;
} catch {}
const roots = [root, read(path.join(process.env.CLAWD_HOME || path.join(home, '.clawd'), 'plugin-root'))?.trim()];
const found = roots.map(r => r && path.join(r, 'bin', 'clawdctl.mjs')).find(f => f && fs.existsSync(f));
if (!found) { process.stderr.write('clawd is not installed: run claude plugin install clawd@clawdbot\\n'); process.exit(1); }
await import(pathToFileURL(found).href);
`;

function link() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  fs.writeFileSync(sub('plugin-root'), root);
  fs.writeFileSync(sub('launch.mjs'), LAUNCHER);
  const bin = path.join(HOME, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, 'clawdctl');
  fs.rmSync(shim, { force: true });
  fs.writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' "\${CLAWD_HOME:-$HOME/.clawd}/launch.mjs" "$@"\n`, { mode: 0o755 });
  const onPath = USER_PATH.split(path.delimiter).includes(bin);
  return { linked: shim, runs: installed()?.installPath ?? root, note: onPath ? 'Run clawdctl from any shell.' : `Add ${bin} to your PATH.` };
}

// ---------- CLI ----------

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) flags[k] = true;
      else { flags[k] = v; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

const USAGE = `clawdctl ${VERSION}: drive Claude Code sessions on this machine for your bot.

  clawdctl info | sessions [--all] | asks [--session <s>]
  clawdctl start --folder <dir> --prompt <text> [--name n] [--model m] [--effort e] [--mode handle|babysit]
  clawdctl take-over <session> [--mode handle|babysit] | release <session> | mode <session> handle|babysit
  clawdctl answer <ask> --decision allow|deny [--reason r] | --pick <label> | --answers '<json>'
  clawdctl send <session> <text> | interrupt <session> | model <session> <m> | effort <session> <e>
  clawdctl permissions <session> default|acceptEdits|dontAsk
  clawdctl report <session> <minutes|off> | peek <session> [--count n] | stop <session>
  clawdctl config webhook (asks for the two lines) | config webhook --test | config webhook --off | config machine <name> | config show
  clawdctl link           put clawdctl on your PATH (~/.local/bin); it runs the installed version
  clawdctl mcp            MCP over stdio (for a local agent, or ssh host clawdctl mcp)
  clawdctl serve [--host ip] [--port 7477]   MCP over HTTP on your tailnet, key in ~/.clawd/serve.key`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parse(rest);
  ensureDirs();
  const run = async () => {
    switch (cmd) {
      case 'info': return commands.info();
      case 'sessions': return commands.sessions(flags);
      case 'asks': return commands.asks(flags);
      case 'start': return commands.start({ ...flags, prompt: flags.prompt ?? pos.join(' ') });
      case 'take-over': return commands.take_over({ session: pos[0], mode: flags.mode });
      case 'release': return commands.release({ session: pos[0] });
      case 'mode': return commands.set_mode({ session: pos[0], mode: pos[1] });
      case 'answer': return commands.answer({ ask: pos[0], ...flags });
      case 'send': return commands.send({ session: pos[0], text: pos.slice(1).join(' ') });
      case 'interrupt': return commands.interrupt({ session: pos[0] });
      case 'model': return commands.set_model({ session: pos[0], model: pos[1] });
      case 'effort': return commands.set_effort({ session: pos[0], effort: pos[1] });
      case 'permissions': return commands.set_permissions({ session: pos[0], permissions: pos[1] });
      case 'report': return commands.set_report({ session: pos[0], minutes: pos[1] });
      case 'peek': return commands.peek({ session: pos[0], count: flags.count });
      case 'stop': return commands.stop({ session: pos[0] });
      case 'flush': return commands.flush(flags);
      case 'config': return configure(pos, flags);
      case 'mcp': mcpStdio(); return undefined;
      case 'serve': serve(flags); return undefined;
      case 'link': return link();
      case 'serve-key': process.stdout.write(`${serveKey()}\n`); return undefined;
      default: process.stdout.write(`${USAGE}\n`); return undefined;
    }
  };
  try {
    const result = await run();
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Refusal ? e.message : e.stack}\n`);
    process.exitCode = 1;
  }
}

async function configure(pos, flags) {
  const c = config();
  if (pos[0] === 'webhook' && flags.off) {
    const { webhook: _gone, ...rest } = c;
    writeJson(sub('config.json'), rest);
    return { webhook: null };
  }
  if (pos[0] === 'webhook' && flags.test) {
    const hook = c.webhook ?? refuse('No webhook set yet.');
    const res = await post(hook, [{ id: `test-${Date.now().toString(36)}`, at: Date.now(), kind: 'test' }]).catch(() => undefined);
    if (!res?.ok) refuse(`The webhook ${res ? `answered ${res.status}` : 'could not be reached'}. Run clawdctl config webhook again and paste both lines.`);
    return { test: 'OK' };
  }
  if (pos[0] === 'webhook' && flags.url) {
    let key;
    if (flags.keyStdin) { key = ''; for await (const chunk of process.stdin) key += chunk; key = key.trim(); }
    writeJson(sub('config.json'), { ...c, webhook: { url: flags.url, ...(key ? { auth: `Bearer ${key}` } : {}) } });
    return { webhook: flags.url, key: key ? 'saved' : 'none' };
  }
  if (pos[0] === 'webhook') {
    // pasted by the person at the machine, so the key never passes through the bot or its chat
    const rl = (await import('node:readline')).createInterface({ input: process.stdin });
    const lines = rl[Symbol.asyncIterator]();
    const ask = async (prompt) => { process.stdout.write(prompt); const r = await lines.next(); return (r.value ?? '').trim(); };
    const url = await ask('Line 1: Webhook URL starting https://\n> ');
    if (!/^https:\/\/\S+$/.test(url)) { rl.close(); refuse('That is not a webhook URL. Run clawdctl config webhook again.'); }
    const header = await ask('Line 2: Authorization header (the whole line, or just the key)\n> ');
    rl.close();
    // the routine panel's line is "Authorization: Bearer <key>"; a bare key gets the Bearer scheme
    const value = header.replace(/^authorization:\s*/i, '');
    const auth = value && !/\s/.test(value) ? `Bearer ${value}` : value;
    if (!auth) refuse('No Authorization line. Run clawdctl config webhook again.');
    writeJson(sub('config.json'), { ...c, webhook: { url, auth } });
    const res = await post({ url, auth }, [{ id: `test-${Date.now().toString(36)}`, at: Date.now(), kind: 'test' }]).catch(() => undefined);
    return { saved: true, test: res?.ok ? 'OK' : `failed (${res?.status ?? 'no answer'}): paste both lines again` };
  }
  if (pos[0] === 'machine') { writeJson(sub('config.json'), { ...c, machine: pos[1] }); return { machine: pos[1] }; }
  return { machine: machine(), webhook: c.webhook?.url ? 'set' : null, key: c.webhook?.auth || c.webhook?.key ? 'set' : 'none' };
}

main();
