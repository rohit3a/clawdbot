// clawdctl as a bot uses it: a CLI against a scratch ~/.clawd, with a stand-in `claude` and a local webhook.
// Run: node --test tests/

import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
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
      env: { ...process.env, CLAWD_NO_TIMER: '1', CLAWD_TAKEOVER_WAIT_MS: '0', HOME: home, CLAWD_HOME: dir, CLAUDE_BIN: path.join(root, 'claude'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
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
const listOutbox = () => { try { return fs.readdirSync(path.join(dir, 'outbox')).map((n) => read('outbox', n)); } catch { return []; } };
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

test('a cut answer and a decision for the person are named in the readable line', async () => {
  await clawdctl(['config', 'webhook', '--url', hookUrl()]);
  queue('turn_done', { answer: `${'a'.repeat(8000)}…`, truncated: true, answerChars: 12000, decision: { question: 'Ship 0.4.3?', options: ['Yes, ship it', 'Not now'] } });

  await clawdctl(['flush']);
  assert.match(received[0].body.text, /\[answer cut: 12000 chars, peek for the rest\]/);
  assert.match(received[0].body.text, /Decision for the person: Ship 0\.4\.3\? \[Yes, ship it \/ Not now\]/);
  assert.equal(received[0].body.events[0].answer.length, 8001);
});

test('peek returns long messages whole, and marks one over 8000 characters as cut', async () => {
  const project = path.join(home, '.claude', 'projects', '-w-api');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'b'.repeat(5000) }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'c'.repeat(9000) }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');

  const [whole, cut] = (await clawdctl(['peek', 'api-fix', '--count', '2'])).json.messages;
  assert.equal(whole.text.length, 5000);
  assert.equal(whole.truncated, undefined);
  assert.equal(cut.text.length, 8001);
  assert.equal(cut.truncated, true);
  assert.equal(cut.chars, 9000);
});

const transcript = (rows) => {
  const project = path.join(home, '.claude', 'projects', '-w-api');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, `${SESSION}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

test('a remote event carries the Remote Control link from the transcript', async () => {
  await clawdctl(['config', 'webhook', '--url', hookUrl()]);
  transcript([
    { type: 'system', subtype: 'bridge_status', url: 'https://claude.ai/code/session_OLD' },
    { type: 'system', subtype: 'bridge_status', url: 'https://claude.ai/code/session_NEW' },
  ]);
  assert.equal((await clawdctl(['remote-url', SESSION])).json.remoteUrl, 'https://claude.ai/code/session_NEW');
  queue('remote');

  await clawdctl(['flush']);
  assert.equal(received[0].body.events[0].remoteUrl, 'https://claude.ai/code/session_NEW');
  assert.match(received[0].body.text, /Remote Control: https:\/\/claude\.ai\/code\/session_NEW/);
});

test('media in an event keeps only files made in the turn, and only those can be fetched', async () => {
  await clawdctl(['config', 'webhook', '--url', hookUrl()]);
  const work = fs.mkdtempSync(path.join(root, 'work-'));
  fs.writeFileSync(path.join(work, 'old.png'), 'old');
  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(path.join(work, 'old.png'), past, past);
  fs.mkdirSync(path.join(work, 'out'));
  fs.writeFileSync(path.join(work, 'out', 'shot.png'), 'png-bytes');
  queue('turn_done', { cwd: work, answer: 'Made a screenshot.', media: ['out/shot.png', 'old.png', 'missing.gif'], mediaSince: Date.now() - 60_000, links: ['https://github.com/o/r/pull/7'] });

  await clawdctl(['flush']);
  const e = received[0].body.events[0];
  assert.deepEqual(e.media, [{ path: path.join(work, 'out', 'shot.png'), type: 'image/png', bytes: 9 }]);
  assert.match(received[0].body.text, /links: https:\/\/github\.com\/o\/r\/pull\/7; files: shot\.png/);
  const got = await clawdctl(['file', path.join(work, 'out', 'shot.png')]);
  assert.equal(Buffer.from(got.json.base64, 'base64').toString(), 'png-bytes');
  const refused = await clawdctl(['file', path.join(work, 'old.png')]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /Only files a session made/);
});

test('AskGrok: opt-in per session, a reply reaches a waiting request, a late one arrives as a message', async () => {
  const on = await clawdctl(['grok', 'api-fix', 'on', '--per-hour', '3']);
  assert.deepEqual(read('grok', `${SESSION}.json`), { enabled: true, perHour: 3 });
  assert.equal(on.json.askGrok, true);
  fs.mkdirSync(path.join(dir, 'requests'), { recursive: true });
  const req = (id, extra) => fs.writeFileSync(path.join(dir, 'requests', `${id}.json`), JSON.stringify({ id, sessionId: SESSION, task: 'Check Razorpay payments today', createdAt: Date.now(), pid: process.pid, ...extra }));
  req('request-a', { waiting: true });
  req('request-b', { waiting: false });

  assert.equal((await clawdctl(['requests'])).json.requests.length, 2);
  assert.equal((await clawdctl(['reply', 'request-a', '--text', '3 payments, 4,200 INR'])).json.delivered, 'as the tool result');
  assert.deepEqual(read('answers', 'request-a.json'), { result: '3 payments, 4,200 INR' });
  assert.equal((await clawdctl(['reply', 'request-b', '--decline', 'Posting needs Rohit'])).json.delivered, 'as a message');
  const [msg] = fs.readdirSync(path.join(dir, 'inbox', SESSION));
  assert.match(read('inbox', SESSION, msg).text, /declined your earlier AskGrok request .*Posting needs Rohit/);
  assert.equal((await clawdctl(['reply', 'request-b', '--text', 'again'])).code, 1);
});

test('a budget needs the session taken over and a positive amount', async () => {
  assert.equal((await clawdctl(['budget', 'api-fix', '5'])).code, 1);
  await clawdctl(['take-over', 'api-fix']);
  assert.equal((await clawdctl(['budget', 'api-fix', '0'])).code, 1);
  assert.equal((await clawdctl(['budget', 'api-fix', '2.5'])).json.budgetUsd, 2.5);
  assert.equal(control().budgetUsd, 2.5);
  await clawdctl(['budget', 'api-fix', 'off']);
  assert.equal(control().budgetUsd, undefined);
});

test('git-summary names the branch, the turn\'s commits and what changed', async () => {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'first');
  const since = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  git('commit', '-qam', 'second');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
  git('add', 'b.txt');

  const r = (await clawdctl(['git-summary', '--cwd', repo, '--since', since])).json;
  assert.equal(r.branch, 'main');
  assert.equal(r.commits.length, 1);
  assert.match(r.commits[0], /second$/);
  assert.deepEqual(r.changed, { files: 2, insertions: 2, deletions: 0 });
  assert.deepEqual((await clawdctl(['git-summary', '--cwd', root])).json, {});
});

test('a PR whose checks already failed wakes the session once per commit', async () => {
  await clawdctl(['take-over', 'api-fix']);
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'fix']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'start']);
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$2" in
  view) echo '{"number":9,"url":"https://github.com/o/r/pull/9","state":"OPEN","headRefOid":"abc123","statusCheckRollup":[{"conclusion":"FAILURE"},{"conclusion":"SUCCESS"}]}' ;;
  checks) echo '[{"name":"test (ubuntu)","bucket":"fail","link":"https://x/1"},{"name":"lint","bucket":"pass","link":"https://x/2"}]' ;;
esac
`, { mode: 0o755 });

  const r = (await clawdctl(['git-summary', '--cwd', repo, '--session', SESSION])).json;
  assert.deepEqual(r.pr.checks, { pass: 1, fail: 1, pending: 0 });
  await until(() => fs.existsSync(path.join(dir, 'inbox', SESSION)) && fs.readdirSync(path.join(dir, 'inbox', SESSION)).length === 1);
  const [msg] = fs.readdirSync(path.join(dir, 'inbox', SESSION));
  assert.match(read('inbox', SESSION, msg).text, /CI failed on PR #9 \(test \(ubuntu\)\)/);
  await until(() => listOutbox().some((e) => e.kind === 'ci'));
  const ci = listOutbox().find((e) => e.kind === 'ci');
  assert.equal(ci.state, 'fail');
  assert.equal(ci.woke, true);

  await clawdctl(['git-summary', '--cwd', repo, '--session', SESSION]);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(fs.readdirSync(path.join(dir, 'inbox', SESSION)).length, 1);
});

test('a scheduled task is listed, can be cancelled, and refuses a time already past', async () => {
  const r = await clawdctl(['schedule', '--at', '+90m', '--folder', '/w/api', '--prompt', 'Run the nightly checks', '--model', 'haiku', '--effort', 'low']);
  const { tasks } = (await clawdctl(['schedules'])).json;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, r.json.id);
  assert.ok(Math.abs(new Date(tasks[0].at).getTime() - (Date.now() + 90 * 60_000)) < 120_000);
  assert.equal((await clawdctl(['unschedule', r.json.id])).json.cancelled, true);
  assert.equal((await clawdctl(['schedules'])).json.tasks.length, 0);
  assert.equal((await clawdctl(['schedule', '--at', '2020-01-01T00:00', '--folder', '/w/api', '--prompt', 'x'])).code, 1);
});

test('a scheduled task that runs pushes a scheduled event', async () => {
  await clawdctl(['config', 'webhook', '--url', hookUrl()]);
  const work = fs.mkdtempSync(path.join(root, 'work-'));
  const { json } = await clawdctl(['schedule', '--at', '+2h', '--folder', work, '--prompt', 'Run the nightly checks']);
  await clawdctl(['run-scheduled', json.id]);
  await until(() => received.length === 1, 30_000);
  assert.equal(received[0].body.events[0].kind, 'scheduled');
  assert.equal(received[0].body.events[0].taskId, json.id);
  assert.equal((await clawdctl(['schedules'])).json.tasks.length, 0);
});

test('a take-over the session never picks up says it needs a restart', async () => {
  const r = await clawdctl(['take-over', 'api-fix']);
  assert.equal(r.json.pickedUp, false);
  assert.match(r.json.note, /restart it/);
  fs.mkdirSync(path.join(dir, 'live'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'live', `${SESSION}.json`), '{}');
  assert.equal((await clawdctl(['take-over', 'api-fix'])).json.pickedUp, true);
});

test('allow can be remembered for the session; deny cannot', async () => {
  writeAsk({ id: 'permission-r', kind: 'permission', tool: 'Bash' });
  await clawdctl(['answer', 'permission-r', '--decision', 'allow', '--remember']);
  assert.deepEqual(read('answers', 'permission-r.json'), { decision: 'allow', remember: true });
  writeAsk({ id: 'permission-d', kind: 'permission', tool: 'Bash' });
  await clawdctl(['answer', 'permission-d', '--decision', 'deny', '--remember']);
  assert.deepEqual(read('answers', 'permission-d.json'), { decision: 'deny' });
});

test('a file put from the chat can be attached to a message, and nothing else can', async () => {
  await clawdctl(['take-over', 'api-fix']);
  const put = await clawdctl(['put', 'shot.png', '--base64-stdin'], { input: Buffer.from('png-bytes').toString('base64') });
  assert.equal(fs.readFileSync(put.json.path, 'utf8'), 'png-bytes');
  await clawdctl(['send', 'api-fix', 'What is wrong here?', '--file', put.json.path]);
  const [msg] = fs.readdirSync(path.join(dir, 'inbox', SESSION));
  assert.match(read('inbox', SESSION, msg).text, /What is wrong here\?\n\nAttached by the person through Clawd Bot: .*shot\.png/);
  assert.equal((await clawdctl(['send', 'api-fix', 'x', '--file', CLAWDCTL])).code, 1);
});

test('a scheduled message reaches a session the bot still has', async () => {
  await clawdctl(['take-over', 'api-fix']);
  const { json } = await clawdctl(['schedule', '--at', '+1h', '--session', 'api-fix', '--prompt', 'The limit has reset: carry on.']);
  assert.equal(json.session, SESSION);
  await clawdctl(['run-scheduled', json.id]);
  const [msg] = fs.readdirSync(path.join(dir, 'inbox', SESSION));
  assert.equal(read('inbox', SESSION, msg).text, 'The limit has reset: carry on.');
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
