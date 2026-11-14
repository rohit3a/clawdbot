// clawdctl as a bot uses it: a CLI against a scratch ~/.clawd, with a stand-in `claude` and a local webhook.
// Run: node --test tests/

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLAWDCTL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'clawd', 'bin', 'clawdctl.mjs');
const SESSION = '11111111-2222-3333-4444-555555555555';
const OTHER = '11119999-0000-0000-0000-000000000000';

let root, home, dir, hook;
const received = [];

// `claude agents --json` lists two sessions; `--version` and `stop` answer as Claude Code does
function fakeClaude() {
  const agents = JSON.stringify([
    { sessionId: SESSION, id: 'bg01', kind: 'background', name: 'api-fix', cwd: '/w/api', status: 'busy' },
    { sessionId: OTHER, kind: 'interactive', name: 'api-docs', cwd: '/w/docs', status: 'idle' },
  ]);
  const bin = path.join(root, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh
case "$1" in
  agents) printf '%s' '${agents}' ;;
  --version) echo '9.9.9 (Claude Code)' ;;
  stop) echo stopped >> "${root}/stopped" ;;
esac
`, { mode: 0o755 });
  return bin;
}

function clawdctl(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLAWDCTL, ...args], {
      env: { ...process.env, HOME: home, CLAWD_HOME: dir, CLAUDE_BIN: path.join(root, 'claude'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
      timeout: 20_000,
    }, (err, stdout, stderr) => {
      let json;
      try { json = JSON.parse(stdout); } catch {}
      resolve({ code: err ? err.code ?? 1 : 0, json, stdout, stderr: stderr.trim() });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const read = (...p) => JSON.parse(fs.readFileSync(path.join(dir, ...p), 'utf8'));
const control = (id = SESSION) => read('control', `${id}.json`);
const writeAsk = (ask) => {
  fs.mkdirSync(path.join(dir, 'asks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'asks', `${ask.id}.json`), JSON.stringify({ sessionId: SESSION, cwd: '/w/api', createdAt: Date.now(), ...ask }));
};
const queue = (kind, extra = {}) => {
  fs.mkdirSync(path.join(dir, 'outbox'), { recursive: true });
  const id = `${kind}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(path.join(dir, 'outbox', `${id}.json`), JSON.stringify({ id, at: Date.now(), kind, sessionId: SESSION, ...extra }));
};
const until = async (check, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (check()) return;
  assert.fail('timed out');
};

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdctl-test-'));
  fakeClaude();
  hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
      res.statusCode = hook.status ?? 200;
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
});

after(() => {
  hook.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(root, 'home-'));
  dir = path.join(home, '.clawd');
  received.length = 0;
  hook.status = 200;
});

const hookUrl = () => `http://127.0.0.1:${hook.address().port}/hook`;

test('info names the machine and the Claude Code version', async () => {
  await clawdctl(['config', 'machine', 'Bench']);
  const r = await clawdctl(['info']);
  assert.equal(r.code, 0);
  assert.equal(r.json.machine, 'Bench');
  assert.equal(r.json.claude, '9.9.9 (Claude Code)');
  assert.equal(r.json.webhook, false);
});

test('sessions are found by name, short id or the start of their id, and ambiguity is refused', async () => {
  for (const ref of ['api-fix', 'bg01', '11111111']) {
    const r = await clawdctl(['take-over', ref]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.session, SESSION);
  }
  const vague = await clawdctl(['take-over', 'api']);
  assert.equal(vague.code, 1);
  assert.match(vague.stderr, /matches 2 sessions/);
  const none = await clawdctl(['take-over', 'nothing-here']);
  assert.match(none.stderr, /No session matches/);
});

test('take-over, mode and release write the control file the mod reads', async () => {
  await clawdctl(['take-over', 'api-fix', '--mode', 'babysit']);
  assert.deepEqual([control().takenOver, control().mode], [true, 'babysit']);
  await clawdctl(['mode', 'api-fix', 'handle']);
  assert.equal(control().mode, 'handle');
  await clawdctl(['release', 'api-fix']);
  assert.equal(control().takenOver, false);
});

test('steering needs the session taken over', async () => {
  for (const args of [['model', 'api-fix', 'haiku'], ['effort', 'api-fix', 'low'], ['permissions', 'api-fix', 'acceptEdits'], ['send', 'api-fix', 'hi']]) {
    const r = await clawdctl(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /not taken over/);
  }
});

test('model, effort and permission mode are set, checked and undone', async () => {
  await clawdctl(['take-over', 'api-fix']);
  await clawdctl(['model', 'api-fix', 'haiku']);
  await clawdctl(['effort', 'api-fix', 'max']);
  await clawdctl(['permissions', 'api-fix', 'acceptEdits']);
  assert.deepEqual([control().model, control().effort, control().permissions], ['haiku', 'max', 'acceptEdits']);

  assert.match((await clawdctl(['effort', 'api-fix', 'extreme'])).stderr, /Effort is one of/);
  assert.match((await clawdctl(['permissions', 'api-fix', 'bypassPermissions'])).stderr, /not offered/);

  for (const [cmd, value] of [['model', 'default'], ['effort', 'default'], ['permissions', 'default']]) await clawdctl([cmd, 'api-fix', value]);
  assert.deepEqual([control().model, control().effort, control().permissions, control().takenOver], [undefined, undefined, undefined, true]);
});

test('send and interrupt reach the session inbox', async () => {
  await clawdctl(['take-over', 'api-fix']);
  await clawdctl(['send', 'api-fix', 'run', 'the', 'tests']);
  await clawdctl(['interrupt', 'api-fix']);
  const inbox = fs.readdirSync(path.join(dir, 'inbox', SESSION)).sort().map((n) => read('inbox', SESSION, n));
  assert.deepEqual(inbox.map((m) => m.type).sort(), ['interrupt', 'message']);
  assert.equal(inbox.find((m) => m.type === 'message').text, 'run the tests');
});

test('a permission is answered allow or deny, nothing else', async () => {
  writeAsk({ id: 'perm-1', kind: 'permission', tool: 'Bash' });
  assert.match((await clawdctl(['answer', 'perm-1', '--pick', 'Yes'])).stderr, /allow or deny/);
  const r = await clawdctl(['answer', 'perm-1', '--decision', 'deny', '--reason', 'use npm test']);
  assert.equal(r.code, 0);
  assert.deepEqual(read('answers', 'perm-1.json'), { decision: 'deny', reason: 'use npm test' });
});

test('a question takes a pick, or answers by question text, and refuses other questions', async () => {
  writeAsk({ id: 'q-1', kind: 'question', questions: [{ question: 'Tea or coffee?', options: [{ label: 'Tea' }, { label: 'Coffee' }] }] });
  await clawdctl(['answer', 'q-1', '--pick', 'Tea']);
  assert.deepEqual(read('answers', 'q-1.json'), { answers: { 'Tea or coffee?': 'Tea' } });

  writeAsk({ id: 'q-2', kind: 'question', questions: [{ question: 'Which port?' }, { question: 'Which host?' }] });
  assert.match((await clawdctl(['answer', 'q-2', '--pick', '80'])).stderr, /several questions/);
  assert.match((await clawdctl(['answer', 'q-2', '--answers', '{"Which colour?":"red"}'])).stderr, /not one of this ask/);
  await clawdctl(['answer', 'q-2', '--answers', '{"Which port?":"80","Which host?":"rog"}']);
  assert.deepEqual(read('answers', 'q-2.json'), { answers: { 'Which port?': '80', 'Which host?': 'rog' } });

  assert.match((await clawdctl(['answer', 'gone', '--pick', 'x'])).stderr, /No open ask/);
});

test('asks can be narrowed to the ones waiting longest', async () => {
  writeAsk({ id: 'old', kind: 'question', createdAt: Date.now() - 30 * 60_000, pid: process.pid });
  writeAsk({ id: 'new', kind: 'question', createdAt: Date.now(), pid: process.pid });
  const r = await clawdctl(['asks', '--older-than', '15']);
  assert.deepEqual(r.json.asks.map((a) => [a.id, a.waitingMin]), [['old', 30]]);
});

test('an ask whose session process has gone is dropped; a live one, or one with no pid, stays', async () => {
  const gone = spawn('true');
  await new Promise((r) => gone.on('exit', r));
  writeAsk({ id: 'held', kind: 'question', pid: process.pid });
  writeAsk({ id: 'orphan', kind: 'permission', pid: gone.pid });
  writeAsk({ id: 'older-mod', kind: 'question' });
  const r = await clawdctl(['asks']);
  assert.deepEqual(r.json.asks.map((a) => a.id).sort(), ['held', 'older-mod']);
  assert.equal(fs.existsSync(path.join(dir, 'asks', 'orphan.json')), false);
  assert.match((await clawdctl(['answer', 'orphan', '--decision', 'allow'])).stderr, /No open ask/);
});

test('only background sessions can be stopped', async () => {
  assert.match((await clawdctl(['stop', 'api-docs'])).stderr, /Only background sessions/);
  const r = await clawdctl(['stop', 'api-fix']);
  assert.equal(r.json.stopped, true);
  assert.ok(fs.existsSync(path.join(root, 'stopped')));
});

test('the webhook window adds Bearer to a bare key and refuses a URL that is not https', async () => {
  const bad = await clawdctl(['config', 'webhook'], { input: 'not a url\n' });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /not a webhook URL/);

  await clawdctl(['config', 'webhook'], { input: 'https://127.0.0.1:9/hook\nsk-test-123\n' });
  assert.equal(read('config.json').webhook.auth, 'Bearer sk-test-123');
  await clawdctl(['config', 'webhook'], { input: 'https://127.0.0.1:9/hook\nAuthorization: Bearer sk-test-456\n' });
  assert.equal(read('config.json').webhook.auth, 'Bearer sk-test-456');

  const shown = await clawdctl(['config', 'show']);
  assert.equal(shown.json.webhook, 'set');
  assert.doesNotMatch(shown.stdout, /sk-test|127\.0\.0\.1/);
});

test('flush posts queued events with the key, then empties the outbox', async () => {
  await clawdctl(['config', 'webhook', '--url', hookUrl(), '--key-stdin'], { input: 'sk-test-789\n' });
  queue('ask', { ask: { id: 'q-1', kind: 'question' } });
  queue('turn_done', { answer: 'All done' });

  const r = await clawdctl(['flush']);
  assert.equal(r.json.sent, 2);
  assert.equal(received.length, 1);
  assert.equal(received[0].auth, 'Bearer sk-test-789');
  assert.deepEqual(received[0].body.events.map((e) => e.kind).sort(), ['ask', 'turn_done']);
  assert.equal(received[0].body.events[0].name, 'api-fix');
  assert.equal(fs.readdirSync(path.join(dir, 'outbox')).length, 0);
});

test('events queued inside the gap still go out after the session has gone', async () => {
  await clawdctl(['config', 'webhook', '--url', hookUrl()]);
  fs.writeFileSync(path.join(dir, 'push-state.json'), JSON.stringify({ lastPushAt: Date.now() - 18_500 }));
  queue('failed', { reason: 'error' });

  const r = await clawdctl(['flush']);
  assert.match(r.json.note, /Pushing in/);
  assert.equal(received.length, 0);
  await until(() => received.length === 1);
  assert.equal(received[0].body.events[0].kind, 'failed');
  await until(() => !fs.existsSync(path.join(dir, 'push.later')));
});

test('a failed turn is pushed with the error from its transcript', async () => {
  await clawdctl(['config', 'webhook', '--url', hookUrl()]);
  const project = path.join(home, '.claude', 'projects', '-w-api');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }] } },
    { type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'There is an issue with the selected model.' }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  queue('failed', { reason: 'error', answer: '' });

  await clawdctl(['flush']);
  assert.match(received[0].body.text, /failed \(error\): There is an issue with the selected model/);
});

test('a refused push keeps the events for the next try', async () => {
  await clawdctl(['config', 'webhook', '--url', hookUrl()]);
  hook.status = 401;
  queue('ask');
  const r = await clawdctl(['flush']);
  assert.equal(r.json.status, 401);
  assert.equal(fs.readdirSync(path.join(dir, 'outbox')).filter((n) => n.endsWith('.json')).length, 1);
  fs.rmSync(path.join(dir, 'push.later'), { recursive: true, force: true });
});

test('the outbox keeps at most 200 events', async () => {
  for (let i = 0; i < 205; i++) queue('progress');
  await clawdctl(['flush']);
  assert.equal(fs.readdirSync(path.join(dir, 'outbox')).length, 200);
});

test('the shim runs the installed copy, and falls back when the recorded Node is gone', async () => {
  const cfg = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(cfg, { recursive: true });
  const installed = path.join(root, 'installed');
  fs.cpSync(path.dirname(path.dirname(CLAWDCTL)), installed, { recursive: true, filter: (f) => !f.includes('/.claude-plugin/types') });
  fs.writeFileSync(path.join(cfg, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'clawd@clawdbot': [{ scope: 'user', installPath: installed, version: '7.7.7', gitCommitSha: 'feedface' }] } }));

  await clawdctl(['link']);
  const shim = path.join(home, '.local', 'bin', 'clawdctl');
  const text = fs.readFileSync(shim, 'utf8').replace(/^for n in '[^']*'/m, "for n in '/gone/node'");
  fs.writeFileSync(shim, text);

  const r = await new Promise((resolve) => execFile(shim, ['info'], {
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CLAWD_HOME: dir, CLAUDE_BIN: path.join(root, 'claude'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
  }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
  assert.equal(r.err, null, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).installed, { version: '7.7.7', commit: 'feedface' });
});
