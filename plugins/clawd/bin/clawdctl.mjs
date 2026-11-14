#!/usr/bin/env node
// clawdctl: drive Claude Code sessions on this machine for a bot (Clawd Bot), as a CLI or an MCP server.
// No dependencies, Node 18+. State lives in ~/.clawd, shared with the clawd mod inside each session.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.5.0';
const HOME = os.homedir();
const DIR = process.env.CLAWD_HOME || path.join(HOME, '.clawd');
const PUSH_GAP_MS = 20_000;
const MAX_OUTBOX = 200;
const PEEK_CHARS = 8000;
const FILE_MAX_BYTES = 5 * 1024 * 1024;
const MEDIA_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', pdf: 'application/pdf' };
const CI_POLL_MS = Number(process.env.CLAWD_CI_POLL_MS) || 60_000;
const CI_MAX_MS = 90 * 60_000;
const USER_PATH = process.env.PATH ?? '';
process.env.PATH = [path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(path.delimiter);
const CLAUDE = process.env.CLAUDE_BIN || 'claude';

class Refusal extends Error {}
const refuse = (message) => { throw new Refusal(message); };

// ---------- files ----------

const sub = (...p) => path.join(DIR, ...p);
function ensureDirs() {
  for (const d of ['control', 'claims', 'inbox', 'asks', 'answers', 'live', 'outbox', 'requests', 'grok', 'schedule', 'ci']) fs.mkdirSync(sub(d), { recursive: true, mode: 0o700 });
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

// A held ask names the pid of its session's process. A session that died or was killed mid-ask (the desktop
// app ends a turn it thinks has hung) leaves its ask behind; asks from mods before 0.4.1 carry no pid and stay.
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function openAsks() {
  const asks = listJson(sub('asks')).map((n) => readJson(sub('asks', n))).filter(Boolean);
  const dead = asks.filter((k) => Number.isInteger(k.pid) && !alive(k.pid));
  for (const k of dead) fs.rmSync(sub('asks', `${k.id}.json`), { force: true });
  return asks.filter((k) => !dead.includes(k));
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
    lastAnswer: live?.lastAnswer ? clip(live.lastAnswer, 600) : undefined,
    costUsd: live?.costUsd,
    budgetUsd: control?.budgetUsd,
    askGrok: readJson(sub('grok', `${a.sessionId}.json`))?.enabled ? true : undefined,
    remoteUrl: control ? remoteUrlOf(a.sessionId) : undefined,
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

  asks({ session, olderThan }) {
    const before = olderThan === undefined ? Infinity : Date.now() - Math.max(0, Number(olderThan)) * 60_000;
    const asks = openAsks()
      .filter((k) => !session || k.sessionId === session || k.sessionId.startsWith(session))
      .filter((k) => (k.createdAt ?? 0) <= before)
      .map((k) => ({ ...k, waitingMin: Math.floor((Date.now() - (k.createdAt ?? Date.now())) / 60_000) }));
    return { machine: machine(), asks };
  },

  // the newest release, read from the marketplace's GitHub repo with this computer's own git sign-in
  check_update() {
    const plugin = installed();
    const repo = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'plugins', 'marketplaces', 'clawdbot');
    let latest;
    try {
      execFileSync('git', ['-C', repo, 'fetch', '--quiet', 'origin'], { timeout: 30_000, stdio: 'ignore' });
      const head = execFileSync('git', ['-C', repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8', timeout: 10_000 }).trim();
      const market = JSON.parse(execFileSync('git', ['-C', repo, 'show', `${head}:.claude-plugin/marketplace.json`], { encoding: 'utf8', timeout: 10_000 }));
      latest = market.plugins?.find((p) => p.name === 'clawd')?.version;
    } catch {}
    if (!latest) refuse('Could not read the latest release. Is the clawdbot marketplace added, and can this computer reach GitHub?');
    const newer = (a, b) => { const x = a.split('.').map(Number), y = (b ?? '0.0.0').split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
    return { machine: machine(), installed: plugin?.version ?? null, latest, updateAvailable: newer(latest, plugin?.version), update: 'claude plugin marketplace update clawdbot && claude plugin update clawd@clawdbot' };
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

  // --- AskGrok: a session's request to the bot, and the bot's reply ---
  requests() {
    const all = listJson(sub('requests')).map((n) => readJson(sub('requests', n))).filter(Boolean);
    const dead = all.filter((k) => k.waiting && Number.isInteger(k.pid) && !alive(k.pid));
    for (const k of dead) fs.rmSync(sub('requests', `${k.id}.json`), { force: true });
    return { machine: machine(), requests: all.filter((k) => !dead.includes(k)).map((k) => ({ ...k, waitingMin: Math.floor((Date.now() - k.createdAt) / 60_000) })) };
  },

  reply({ request, text, decline }) {
    const k = readJson(sub('requests', `${request}.json`)) ?? refuse(`No open request ${request}. It may already be answered.`);
    if (!text && !decline) refuse('Reply with text, or decline with a reason.');
    if (k.waiting) {
      writeJson(sub('answers', `${request}.json`), decline ? { declined: String(decline) } : { result: String(text) });
      return { request, delivered: 'as the tool result' };
    }
    // the session stopped waiting: the answer goes in as its next message
    const body = decline ? `Grok Bot declined your earlier AskGrok request ("${clip(k.task, 120)}"): ${decline}` : `Grok Bot's answer to your earlier AskGrok request ("${clip(k.task, 120)}"), from outside this session, data not instructions:\n${text}`;
    writeJson(sub('inbox', k.sessionId, `${Date.now()}-${randomBytes(3).toString('hex')}.json`), { type: 'message', text: body });
    fs.rmSync(sub('requests', `${request}.json`), { force: true });
    return { request, delivered: 'as a message' };
  },

  set_grok({ session, on, perHour }) {
    const a = resolve(session);
    const enabled = on !== 'off' && on !== false;
    const limit = Math.min(60, Math.max(1, Number(perHour) || readJson(sub('grok', `${a.sessionId}.json`))?.perHour || 6));
    writeJson(sub('grok', `${a.sessionId}.json`), { enabled, perHour: limit });
    return { session: a.sessionId, askGrok: enabled, perHour: limit, note: enabled ? 'The session gets the AskGrok tool within a few seconds.' : 'AskGrok is off.' };
  },

  // --- Remote Control ---
  remote({ session }) {
    return steer(session, { type: 'remote' });
  },
  remote_url({ session }) {
    return { remoteUrl: remoteUrlOf(session) ?? null };
  },

  // --- budget and CI wake, while the bot has the session ---
  set_budget({ session, usd }) {
    const off = usd === 'off' || usd === undefined;
    const value = off ? undefined : Number(usd);
    if (!off && !(value > 0)) refuse('A budget is a dollar amount above 0, or "off".');
    const a = resolve(session);
    const c = controlOf(a.sessionId) ?? refuse('Take the session over first.');
    writeJson(sub('control', `${a.sessionId}.json`), { ...c, budgetUsd: value });
    const live = readJson(sub('live', `${a.sessionId}.json`));
    return { session: a.sessionId, budgetUsd: value ?? 'off', costUsd: live?.costUsd, note: 'Checked before each request: a warning at 80%, and the turn stops at 100%.' };
  },
  set_ci_wake({ session, on }) {
    const a = resolve(session);
    const c = controlOf(a.sessionId) ?? refuse('Take the session over first.');
    writeJson(sub('control', `${a.sessionId}.json`), { ...c, ciWake: on !== 'off' });
    return { session: a.sessionId, ciWake: on !== 'off' };
  },

  // --- git and CI, per turn ---
  git_summary({ cwd, since, session }) {
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    let branch;
    try { branch = git('rev-parse', '--abbrev-ref', 'HEAD'); } catch { return {}; }
    const out = { branch };
    try {
      const commits = since ? git('log', '--format=%h %s', `${since}..HEAD`).split('\n').filter(Boolean) : [];
      if (commits.length) out.commits = commits.slice(0, 5).concat(commits.length > 5 ? [`and ${commits.length - 5} more`] : []);
      const stat = git('diff', '--shortstat', since && commits.length ? since : 'HEAD');
      const n = (re) => Number(re.exec(stat)?.[1] ?? 0);
      const changed = { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?/), deletions: n(/(\d+) deletions?/) };
      if (changed.files) out.changed = changed;
    } catch {}
    const pr = prOf(cwd);
    if (pr) {
      out.pr = pr;
      if (pr.checks?.pending && session) ciWatchLater(session, cwd, pr);
    }
    return out;
  },

  ci_watch: ciWatch,

  // --- media a session made ---
  file({ path: wanted }) {
    if (!wanted) refuse('Give the file path from an event.');
    const known = readJson(sub('media.json')) ?? [];
    const hit = known.find((m) => m.path === wanted) ?? refuse('Only files a session made, as listed in an event, can be read.');
    const st = fs.statSync(hit.path, { throwIfNoEntry: false }) ?? refuse(`${hit.path} is gone.`);
    if (st.size > FILE_MAX_BYTES) refuse(`${hit.path} is ${(st.size / 1048576).toFixed(1)} MB; files up to 5 MB can be sent. Open it on the computer.`);
    return { path: hit.path, type: hit.type, bytes: st.size, base64: fs.readFileSync(hit.path).toString('base64') };
  },

  // --- scheduled tasks: a background session started later by the OS timer ---
  schedule({ at, folder, prompt, name, model, effort, mode }) {
    if (!folder || !prompt) refuse('A scheduled task needs a folder and a prompt.');
    const when = whenOf(at);
    const id = `task-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
    const task = { id, at: when, folder, prompt, name, model, effort, mode, createdAt: Date.now() };
    writeJson(sub('schedule', `${id}.json`), task);
    try { installTimer(task); } catch (e) { fs.rmSync(sub('schedule', `${id}.json`), { force: true }); refuse(`Could not set the timer: ${e.message}`); }
    return { id, at: new Date(when).toString(), folder, name: name ?? null, note: 'A background session starts then, taken over by you, and its start arrives as an event.' };
  },
  schedules() {
    return { machine: machine(), tasks: listJson(sub('schedule')).map((n) => readJson(sub('schedule', n))).filter(Boolean).map((t) => ({ ...t, at: new Date(t.at).toString() })) };
  },
  unschedule({ id }) {
    const t = readJson(sub('schedule', `${id}.json`)) ?? refuse(`No scheduled task ${id}.`);
    removeTimer(t);
    fs.rmSync(sub('schedule', `${id}.json`), { force: true });
    return { id, cancelled: true };
  },
  async run_scheduled({ id }) {
    const t = readJson(sub('schedule', `${id}.json`));
    if (!t) return { id, note: 'Already run or cancelled.' };
    fs.rmSync(sub('schedule', `${id}.json`), { force: true });
    try { removeTimer(t); } catch {}
    let event;
    try {
      const started = await commands.start({ folder: t.folder, prompt: t.prompt, name: t.name, model: t.model, effort: t.effort, mode: t.mode });
      event = { kind: 'scheduled', taskId: id, sessionId: started.session, started };
    } catch (e) {
      event = { kind: 'scheduled', taskId: id, failed: e.message, folder: t.folder };
    }
    queueEvent(event);
    await commands.flush({ quiet: true });
    return event;
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
      const wait = PUSH_GAP_MS - (Date.now() - (state.lastPushAt ?? 0));
      if (wait > 0) {
        pushLater(wait);
        return quiet ? undefined : { sent: 0, note: `Pushing in ${Math.ceil(wait / 1000)} seconds.` };
      }
      const events = names.map((n) => readJson(sub('outbox', n))).filter(Boolean);
      const byId = new Map(agents(true).map((a) => [a.sessionId, a]));
      for (const e of events) {
        e.name = byId.get(e.sessionId)?.name ?? null;
        // the engine tells the mod a turn failed but not why; the session's transcript has the error
        if (e.kind === 'failed' && !e.answer) e.answer = lastApiError(e.sessionId) ?? '';
        if (e.kind === 'remote') e.remoteUrl = remoteUrlOf(e.sessionId) ?? null;
        if (Array.isArray(e.media)) e.media = mediaFiles(e);
      }
      writeJson(sub('push-state.json'), { lastPushAt: Date.now() });
      const res = await post(hook, events);
      if (!res.ok) {
        pushLater(PUSH_GAP_MS);
        return quiet ? undefined : { sent: 0, status: res.status };
      }
      for (const n of names) fs.rmSync(sub('outbox', n), { force: true });
      return quiet ? undefined : { sent: events.length };
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  },
};

// Events that arrive inside the gap, or that a failing webhook refused, go out from one detached
// process, so they don't wait for the session that queued them, which may have ended.
const LATER_TRIES = 8;
function pushLater(ms) {
  const mark = sub('push.later');
  try {
    fs.mkdirSync(mark);
  } catch {
    const age = Date.now() - (fs.statSync(mark, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    if (age < 60 * 60_000) return;
    fs.rmSync(mark, { recursive: true, force: true });
    fs.mkdirSync(mark);
  }
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'push-later', String(Math.ceil(ms))], { detached: true, stdio: 'ignore' }).unref();
}

async function pushLaterLoop(ms) {
  let wait = Math.max(1_000, Number(ms) || PUSH_GAP_MS);
  try {
    for (let i = 0; i < LATER_TRIES; i++) {
      await new Promise((r) => setTimeout(r, wait));
      fs.utimesSync(sub('push.later'), new Date(), new Date());
      const state = readJson(sub('push-state.json')) ?? {};
      const gapLeft = PUSH_GAP_MS - (Date.now() - (state.lastPushAt ?? 0));
      if (gapLeft > 0) { wait = gapLeft + 500; continue; }
      await commands.flush({ quiet: true, later: true });
      if (!listJson(sub('outbox')).length || !config().webhook?.url) return;
      wait = Math.min(PUSH_GAP_MS * 2 ** (i + 1), 10 * 60_000);
    }
  } finally {
    fs.rmSync(sub('push.later'), { recursive: true, force: true });
  }
}

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

function queueEvent(e) {
  const id = `${e.kind}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  writeJson(sub('outbox', `${id}.json`), { id, at: Date.now(), ...e });
}

// the link /remote-control printed into the session's transcript; the newest one wins
function remoteUrlOf(sessionId) {
  const file = transcriptOf(sessionId);
  if (!file) return undefined;
  let url;
  for (const raw of tail(file, 2_000_000).split('\n')) {
    if (!raw.includes('bridge_status')) continue;
    try { const row = JSON.parse(raw); if (row.subtype === 'bridge_status' && row.url) url = row.url; } catch {}
  }
  return url;
}

function tail(file, max) {
  const size = fs.statSync(file).size;
  const len = Math.min(size, max);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

// media an event names: only files that exist and changed during the turn, remembered so file can send them
function mediaFiles(e) {
  const out = [];
  for (const p of e.media) {
    const full = path.resolve(e.cwd ?? HOME, String(p).replace(/^~(?=\/)/, HOME));
    const st = fs.statSync(full, { throwIfNoEntry: false });
    if (!st?.isFile() || (e.mediaSince && st.mtimeMs < e.mediaSince - 5_000)) continue;
    const type = MEDIA_TYPES[path.extname(full).slice(1).toLowerCase()] ?? 'application/octet-stream';
    if (!out.some((m) => m.path === full)) out.push({ path: full, type, bytes: st.size });
  }
  const known = (readJson(sub('media.json')) ?? []).filter((m) => !out.some((o) => o.path === m.path));
  writeJson(sub('media.json'), [...known, ...out].slice(-200));
  return out;
}

function prOf(cwd) {
  try {
    const raw = execFileSync('gh', ['pr', 'view', '--json', 'number,url,state,headRefOid,statusCheckRollup'], { cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const pr = JSON.parse(raw);
    const checks = { pass: 0, fail: 0, pending: 0 };
    for (const c of pr.statusCheckRollup ?? []) {
      const v = String(c.conclusion || c.state || c.status || '').toUpperCase();
      if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(v)) checks.pass++;
      else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(v)) checks.fail++;
      else checks.pending++;
    }
    return { number: pr.number, url: pr.url, state: pr.state, sha: pr.headRefOid, ...((pr.statusCheckRollup ?? []).length && { checks }) };
  } catch {
    return undefined;
  }
}

// One detached watcher per PR head: when the checks finish it pushes a ci event, and on a failure wakes the session
function ciWatchLater(sessionId, cwd, pr) {
  const mark = sub('ci', `${sessionId}-${pr.sha ?? pr.number}`);
  try { fs.mkdirSync(mark, { recursive: false }); } catch { return; }
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'ci-watch', '--session', sessionId, '--cwd', cwd, '--pr', String(pr.number), '--sha', String(pr.sha ?? '')], { detached: true, stdio: 'ignore' }).unref();
}

async function ciWatch({ session, cwd, pr, sha }) {
  const started = Date.now();
  try {
    while (Date.now() - started < CI_MAX_MS) {
      await new Promise((r) => setTimeout(r, CI_POLL_MS));
      const now = prOf(cwd);
      if (!now || String(now.number) !== String(pr) || (sha && now.sha && now.sha !== sha)) return;
      if (!now.checks || now.checks.pending) continue;
      const failed = now.checks.fail > 0;
      let failing = [];
      if (failed) {
        try {
          failing = JSON.parse(execFileSync('gh', ['pr', 'checks', String(pr), '--json', 'name,bucket,link'], { cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] })).filter((c) => c.bucket === 'fail').map((c) => ({ name: c.name, link: c.link }));
        } catch {}
      }
      const c = controlOf(session);
      const wake = failed && !!c && c.ciWake !== false;
      if (wake) {
        const names = failing.map((f) => f.name).join(', ') || 'some checks';
        writeJson(sub('inbox', session, `${Date.now()}-${randomBytes(3).toString('hex')}.json`), { type: 'message', text: `CI failed on PR #${pr} (${names}). Read the failure (gh pr checks ${pr}, then gh run view <run id> --log-failed), fix it, and push.` });
      }
      queueEvent({ kind: 'ci', sessionId: session, cwd, pr: { number: now.number, url: now.url }, state: failed ? 'fail' : 'pass', failing, woke: wake });
      await commands.flush({ quiet: true });
      return;
    }
  } finally {
    fs.rmSync(sub('ci', `${session}-${sha || pr}`), { recursive: true, force: true });
  }
}

// "21:30" (next one), "+90m", "+2h", or an ISO date and time
function whenOf(at) {
  if (!at) refuse('Say when: "21:30", "+90m", "+2h", or a date and time like 2026-11-16T09:00.');
  const s = String(at).trim();
  let t;
  const rel = /^\+(\d+)\s*(m|min|h|hr|d)$/i.exec(s);
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (rel) t = Date.now() + Number(rel[1]) * { m: 60_000, min: 60_000, h: 3_600_000, hr: 3_600_000, d: 86_400_000 }[rel[2].toLowerCase()];
  else if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    t = d.getTime();
  } else t = new Date(s).getTime();
  if (!Number.isFinite(t)) refuse(`Could not read "${s}" as a time.`);
  if (t < Date.now() + 60_000) refuse('Pick a time at least a minute from now.');
  return Math.ceil(t / 60_000) * 60_000;
}

// macOS: a launchd agent (runs at wake if the Mac slept through it). Linux: a systemd user timer.
const plistOf = (id) => path.join(HOME, 'Library', 'LaunchAgents', `com.clawd.${id}.plist`);
function timerCommand(id) {
  const shim = path.join(HOME, '.local', 'bin', 'clawdctl');
  return fs.existsSync(shim) ? ['/bin/sh', shim, 'run-scheduled', id] : [process.execPath, fileURLToPath(import.meta.url), 'run-scheduled', id];
}
function installTimer(t) {
  if (process.env.CLAWD_NO_TIMER) return;
  const d = new Date(t.at);
  if (process.platform === 'darwin') {
    const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.clawd.${t.id}</string>
<key>ProgramArguments</key><array>${timerCommand(t.id).map((a) => `<string>${x(a)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${x(USER_PATH)}</string></dict>
<key>StartCalendarInterval</key><dict><key>Month</key><integer>${d.getMonth() + 1}</integer><key>Day</key><integer>${d.getDate()}</integer><key>Hour</key><integer>${d.getHours()}</integer><key>Minute</key><integer>${d.getMinutes()}</integer></dict>
</dict></plist>
`;
    fs.mkdirSync(path.dirname(plistOf(t.id)), { recursive: true });
    fs.writeFileSync(plistOf(t.id), plist);
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistOf(t.id)], { stdio: 'ignore', timeout: 15_000 });
  } else {
    const pad = (n) => String(n).padStart(2, '0');
    const cal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
    execFileSync('systemd-run', ['--user', `--unit=clawd-${t.id}`, `--on-calendar=${cal}`, `--setenv=PATH=${USER_PATH}`, ...timerCommand(t.id)], { stdio: 'ignore', timeout: 15_000 });
  }
}
function removeTimer(t) {
  if (process.env.CLAWD_NO_TIMER) return;
  if (process.platform === 'darwin') {
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/com.clawd.${t.id}`], { stdio: 'ignore', timeout: 15_000 }); } catch {}
    fs.rmSync(plistOf(t.id), { force: true });
  } else {
    try { execFileSync('systemctl', ['--user', 'stop', `clawd-${t.id}.timer`], { stdio: 'ignore', timeout: 15_000 }); } catch {}
  }
}

function clip(text, max) {
  const t = text ?? '';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function extras(e) {
  const bits = [];
  if (e.links?.length) bits.push(`links: ${e.links.join(' ')}`);
  if (e.media?.length) bits.push(`files: ${e.media.map((m) => path.basename(m.path ?? String(m))).join(', ')}`);
  if (e.git?.commits?.length) bits.push(`${e.git.commits.length} commit(s) on ${e.git.branch}`);
  if (e.git?.changed) bits.push(`${e.git.changed.files} file(s) changed, +${e.git.changed.insertions} -${e.git.changed.deletions}`);
  if (e.git?.pr) bits.push(`PR #${e.git.pr.number} ${e.git.pr.state}${e.git.pr.checks ? ` (checks: ${e.git.pr.checks.pass} pass, ${e.git.pr.checks.fail} fail, ${e.git.pr.checks.pending} pending)` : ''}`);
  if (e.costUsd !== undefined) bits.push(`cost $${e.costUsd}${e.budgetUsd ? ` of $${e.budgetUsd}` : ''}`);
  return bits.length ? ` [${bits.join('; ')}]` : '';
}

function line(e) {
  const who = `[${machine()}] ${e.name ?? path.basename(e.cwd ?? '') ?? e.sessionId?.slice(0, 8)}`;
  if (e.kind === 'ask' && e.ask === 'permission') return `${who} wants permission for ${e.tool}: ${e.summary} (ask ${e.askId}, mode ${e.mode})`;
  if (e.kind === 'ask') return `${who} asks: ${(e.questions ?? []).map((q) => `${q.question} [${(q.options ?? []).map((o) => o.label).join(' / ')}]`).join(' ')} (ask ${e.askId}, mode ${e.mode})`;
  if (e.kind === 'turn_done' && e.reason === 'aborted') return `${who} was interrupted. It had got to: ${clip(e.answer, 300)}`;
  if (e.kind === 'turn_done') return `${who} finished a turn: ${clip(e.answer, 300)}${e.truncated ? ` [answer cut: ${e.answerChars} chars, peek for the rest]` : ''}${e.decision ? ` Decision for the person: ${e.decision.question} [${e.decision.options.join(' / ')}]` : ''}${extras(e)}`;
  if (e.kind === 'takeover') return `${who}: Clawd Bot has this session now (${e.by === 'you' ? 'handed over at the machine' : 'taken over by the bot'}, mode ${e.mode}).`;
  if (e.kind === 'released') return `${who} is back with the person at the machine. Its asks show there again.`;
  if (e.kind === 'test') return `[${machine()}] Clawd Bot is connected.`;
  if (e.kind === 'ended') return `${who} ended.`;
  if (e.kind === 'steer_failed') return `${who} could not run on ${[e.model, e.effort].filter(Boolean).join(' ')}; it went back to its own model and effort.`;
  if (e.kind === 'failed') return `${who} failed (${e.reason}): ${clip(e.answer, 300)}`;
  if (e.kind === 'request') return `${who} asks Grok Bot (request ${e.requestId}): ${clip(e.task, 600)}`;
  if (e.kind === 'remote') return e.remoteUrl ? `${who} Remote Control: ${e.remoteUrl}` : `${who}: Remote Control could not be turned on here.`;
  if (e.kind === 'ci') return `${who} CI ${e.state === 'fail' ? 'failed' : 'passed'} on PR #${e.pr?.number} ${e.pr?.url ?? ''}${e.failing?.length ? ` (${e.failing.map((f) => f.name).join(', ')})` : ''}${e.woke ? '. The session was woken to fix it.' : ''}`;
  if (e.kind === 'budget') return `${who} ${e.level === 'stopped' ? 'stopped at its budget' : 'is at 80% of its budget'}: $${e.costUsd} of $${e.budgetUsd}.`;
  if (e.kind === 'scheduled') return e.failed ? `[${machine()}] Scheduled task ${e.taskId} did not start: ${e.failed}` : `[${machine()}] Scheduled task ${e.taskId} started ${e.started?.name ?? ''}${e.started?.remoteUrl ? `: ${e.started.remoteUrl}` : ''}`;
  if (e.kind === 'progress') return `${who} progress: ${e.busy ? 'working' : 'idle'}${e.holding ? `, waiting on ${e.holding}` : ''}. Last: ${clip(e.lastAnswer, 300)}`;
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

function lastApiError(sessionId) {
  const file = transcriptOf(sessionId);
  if (!file) return undefined;
  const size = fs.statSync(file).size;
  const len = Math.min(size, 200_000);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  for (const raw of buf.toString('utf8').split('\n').reverse()) {
    let row;
    try { row = JSON.parse(raw); } catch { continue; }
    if (row.type !== 'assistant' || row.isSidechain) continue;
    if (!row.isApiErrorMessage) return undefined;
    const c = row.message?.content;
    return (Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : String(c ?? '')).slice(0, 400);
  }
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
    out.push({ role: row.type, at: row.timestamp, text: clip(text, PEEK_CHARS), ...(text.length > PEEK_CHARS && { truncated: true, chars: text.length }) });
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
  ['list_asks', 'Open questions and permission requests from taken-over sessions on this machine, each with how many minutes it has waited.', { session: S, olderThan: { type: 'number', description: 'Only asks waiting at least this many minutes.' } }, [], 'asks'],
  ['check_update', 'Whether a newer Clawd release is out than the one installed on this machine, and the command that updates it.', {}, [], 'check_update'],
  ['answer', 'Answer an open ask. A permission takes decision allow or deny (and a reason the session will read). A question takes pick (the option label, for one question) or answers (an object from question text to answer).', { ask: S, decision: { ...S, enum: ['allow', 'deny'] }, reason: S, pick: S, answers: { type: 'object' } }, ['ask'], 'answer'],
  ['send_message', 'Send a message to a taken-over session, as if the person typed it. It runs when the session is next idle.', { session: S, text: S }, ['session', 'text'], 'send'],
  ['interrupt', 'Stop what a taken-over session is doing right now (like pressing Esc).', { session: S }, ['session'], 'interrupt'],
  ['set_model', 'Change the model of a taken-over session from its next request on, while you have it. "default" goes back to its own.', { session: S, model: S }, ['session', 'model'], 'set_model'],
  ['set_effort', 'Change the reasoning effort (low, medium, high, xhigh, max) of a taken-over session from its next request on, while you have it. "default" goes back to its own.', { session: S, effort: S }, ['session', 'effort'], 'set_effort'],
  ['set_permissions', 'Set how a taken-over session handles permission prompts while you have it: acceptEdits allows file edits inside its folder without asking, dontAsk denies anything not pre-approved, default goes back to asking you.', { session: S, permissions: { ...S, enum: ['default', 'acceptEdits', 'dontAsk'] } }, ['session', 'permissions'], 'set_permissions'],
  ['set_report', 'Push a short progress report for a taken-over session every N minutes, or "off".', { session: S, minutes: S }, ['session', 'minutes'], 'set_report'],
  ['peek', 'The last messages of a session and its state, to summarise it for the person.', { session: S, count: { type: 'number' } }, ['session'], 'peek'],
  ['stop_session', 'Stop a background session. Its conversation is kept and can be resumed.', { session: S }, ['session'], 'stop'],
  ['remote_control', 'Turn on Remote Control for a taken-over terminal session; the link arrives as a remote event.', { session: S }, ['session'], 'remote'],
  ['set_budget', 'Cap what a taken-over session may spend, in US dollars, or "off". Warns at 80%; at 100% the turn stops before the next request.', { session: S, usd: S }, ['session', 'usd'], 'set_budget'],
  ['set_ci_wake', 'Whether a failed CI run on the session\'s PR wakes the session to fix it (on by default).', { session: S, on: { ...S, enum: ['on', 'off'] } }, ['session', 'on'], 'set_ci_wake'],
  ['get_file', 'A file a session made, as listed in an event\'s media: its type and base64 contents, up to 5 MB.', { path: S }, ['path'], 'file'],
  ['set_ask_grok', 'Let a session ask you for help (its AskGrok tool), or stop it. The person must want it on.', { session: S, on: { ...S, enum: ['on', 'off'] }, perHour: { type: 'number' } }, ['session', 'on'], 'set_grok'],
  ['list_requests', 'Open AskGrok requests from sessions on this machine.', {}, [], 'requests'],
  ['reply_request', 'Answer a session\'s AskGrok request with text, or decline it with a reason.', { request: S, text: S, decline: S }, ['request'], 'reply'],
  ['schedule_task', 'Start a background session later: at is "21:30", "+90m", "+2h" or an ISO date and time.', { at: S, folder: S, prompt: S, name: S, model: S, effort: S, mode: { ...S, enum: ['handle', 'babysit'] } }, ['at', 'folder', 'prompt'], 'schedule'],
  ['list_schedules', 'Scheduled tasks on this machine.', {}, [], 'schedules'],
  ['unschedule', 'Cancel a scheduled task.', { id: S }, ['id'], 'unschedule'],
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

// The node that ran link first, then the usual places, so upgrading or switching Node doesn't break clawdctl.
const shimScript = (node) => `#!/bin/sh
for n in '${node.replace(/'/g, `'\\''`)}' "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node \\
  "$HOME/.local/share/fnm/aliases/default/bin/node" "$HOME/.volta/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -x "$n" ] && exec "$n" "\${CLAWD_HOME:-$HOME/.clawd}/launch.mjs" "$@"
done
echo 'clawdctl: no Node found. Install Node 18 or later.' >&2
exit 1
`;

function link() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  fs.writeFileSync(sub('plugin-root'), root);
  fs.writeFileSync(sub('launch.mjs'), LAUNCHER);
  const bin = path.join(HOME, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, 'clawdctl');
  fs.rmSync(shim, { force: true });
  fs.writeFileSync(shim, shimScript(process.execPath), { mode: 0o755 });
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

  clawdctl info | check-update | sessions [--all] | asks [--session <s>] [--older-than <minutes>]
  clawdctl start --folder <dir> --prompt <text> [--name n] [--model m] [--effort e] [--mode handle|babysit]
  clawdctl take-over <session> [--mode handle|babysit] | release <session> | mode <session> handle|babysit
  clawdctl answer <ask> --decision allow|deny [--reason r] | --pick <label> | --answers '<json>'
  clawdctl send <session> <text> | interrupt <session> | model <session> <m> | effort <session> <e>
  clawdctl permissions <session> default|acceptEdits|dontAsk
  clawdctl report <session> <minutes|off> | peek <session> [--count n] | stop <session>
  clawdctl remote <session> | budget <session> <usd|off> | ci-wake <session> on|off | file <path>
  clawdctl grok <session> on|off [--per-hour n] | requests | reply <request> --text <t> | --decline <why>
  clawdctl schedule --at <21:30|+90m|ISO> --folder <dir> --prompt <text> [--name n] [--model m] [--effort e] [--mode m]
  clawdctl schedules | unschedule <id>
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
      case 'check-update': return commands.check_update();
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
      case 'requests': return commands.requests();
      case 'reply': return commands.reply({ request: pos[0], text: flags.text ?? (pos.length > 1 ? pos.slice(1).join(' ') : undefined), decline: flags.decline });
      case 'grok': return commands.set_grok({ session: pos[0], on: pos[1], perHour: flags.perHour });
      case 'remote': return commands.remote({ session: pos[0] });
      case 'remote-url': return commands.remote_url({ session: pos[0] });
      case 'budget': return commands.set_budget({ session: pos[0], usd: pos[1] });
      case 'ci-wake': return commands.set_ci_wake({ session: pos[0], on: pos[1] });
      case 'git-summary': return commands.git_summary(flags);
      case 'ci-watch': return commands.ci_watch(flags);
      case 'file': return commands.file({ path: pos[0] });
      case 'schedule': return commands.schedule({ ...flags, prompt: flags.prompt ?? (pos.length ? pos.join(' ') : undefined) });
      case 'schedules': return commands.schedules();
      case 'unschedule': return commands.unschedule({ id: pos[0] });
      case 'run-scheduled': return commands.run_scheduled({ id: pos[0] });
      case 'flush': return commands.flush(flags);
      case 'push-later': return pushLaterLoop(pos[0]);
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
