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

// `claude agents --json` lists two sessions; `--version` and `stop` answer as Claude Code does. A test can give
// its own session list ($HOME/fake/agents.json), a background session's output (fake/logs-<id>), what `--bg`
// starts (fake/bg-agents.json), and what an attached session does with the keys it gets (fake/after-attach.json).
function fakeClaude() {
  const agents = JSON.stringify([
    { sessionId: SESSION, id: 'bg01', kind: 'background', name: 'api-fix', cwd: '/w/api', status: 'busy' },
    { sessionId: OTHER, kind: 'interactive', name: 'api-docs', cwd: '/w/docs', status: 'idle' },
  ]);
  const bin = path.join(root, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh
F="$HOME/fake"
mkdir -p "$F"
case "$1" in
  agents) if [ -f "$F/agents.json" ]; then cat "$F/agents.json"; else printf '%s' '${agents}'; fi ;;
  --version) echo '9.9.9 (Claude Code)' ;;
  stop) echo stopped >> "${root}/stopped"; echo "stop $2" >> "$F/calls" ;;
  rm) echo "rm $2" >> "$F/calls" ;;
  logs) cat "$F/logs-$2" ;;
  attach) printf 'Attaching...'; head -c 1 > "$F/attach-input"; [ -f "$F/after-attach.json" ] && cp "$F/after-attach.json" "$F/agents.json"; head -c 2 >> "$F/attach-input" ;;
  --bg)
    echo "bg $PWD $*" >> "$F/calls"
    if [ -f "$F/untrusted" ]; then echo 'Error: this folder is not trusted' >&2; exit 1; fi
    [ -f "$F/bg-agents.json" ] || exit 0
    cp "$F/bg-agents.json" "$F/agents.json"; echo 'backgrounded · bg77 · clawd-usage' ;;
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
  assert.equal((await clawdctl(['reply', 'request-b', '--decline', 'Posting needs the person'])).json.delivered, 'as a message');
  const [msg] = fs.readdirSync(path.join(dir, 'inbox', SESSION));
  assert.match(read('inbox', SESSION, msg).text, /declined your earlier AskGrok request .*Posting needs the person/);
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
  view) echo '{"number":9,"url":"https://github.com/o/r/pull/9","state":"OPEN","headRefOid":"abc123","statusCheckRollup":[{"name":"test (ubuntu)","conclusion":"FAILURE","detailsUrl":"https://x/1"},{"name":"lint","conclusion":"SUCCESS"}]}' ;;
  *) echo 'unknown flag: --json' >&2; exit 1 ;;
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
  assert.deepEqual(ci.failing, [{ name: 'test (ubuntu)', link: 'https://x/1' }]);

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

test('on Linux a scheduled task is a persistent systemd timer in unit files, and cancelling removes them', { skip: process.platform !== 'linux' }, async () => {
  const bin = fs.mkdtempSync(path.join(root, 'bin-'));
  const xdg = fs.mkdtempSync(path.join(root, 'xdg-'));
  const calls = path.join(bin, 'calls');
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\n`, { mode: 0o755 });
  const run = (args) => new Promise((resolve) => execFile(process.execPath, [CLAWDCTL, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, CLAWD_HOME: dir, CLAUDE_BIN: path.join(root, 'claude'), XDG_CONFIG_HOME: path.join(xdg, 'config'), XDG_DATA_HOME: path.join(xdg, 'data') },
  }, (err, stdout) => resolve({ code: err ? 1 : 0, json: JSON.parse(stdout || 'null') })));
  const { json } = await run(['schedule', '--at', '+2h', '--folder', '/w/api', '--prompt', 'Run the nightly checks']);
  const unit = (ext) => path.join(xdg, 'config', 'systemd', 'user', `clawd-${json.id}.${ext}`);
  const timer = fs.readFileSync(unit('timer'), 'utf8');
  const service = fs.readFileSync(unit('service'), 'utf8');
  assert.match(timer, /^OnCalendar=\d{4}-\d\d-\d\d \d\d:\d\d:00$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
  assert.ok(service.includes(`Environment="CLAWD_HOME=${dir}"`));
  assert.match(service, new RegExp(`^ExecStart=.* "run-scheduled" "${json.id}"$`, 'm'));
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['--user daemon-reload', `--user enable --now clawd-${json.id}.timer`]);

  assert.equal((await run(['unschedule', json.id])).json.cancelled, true);
  assert.equal(fs.existsSync(unit('timer')) || fs.existsSync(unit('service')), false);
  assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n').slice(2), [`--user stop clawd-${json.id}.timer`, `--user disable clawd-${json.id}.timer`, '--user daemon-reload']);
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

// ---------- the session's screen, and plan usage ----------

const fake = (...p) => path.join(home, 'fake', ...p);
const putFake = (name, text) => { fs.mkdirSync(fake(), { recursive: true }); fs.writeFileSync(fake(name), text); };
const readFake = (name) => { try { return fs.readFileSync(fake(name), 'utf8'); } catch { return ''; } };
// a stand-in for a tool clawdctl runs (ps, stty, tmux, script), found first on its PATH
const fakeTool = (name, body) => {
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nF="$HOME/fake"\n${body}\n`, { mode: 0o755 });
};
const sessionList = (...rows) => JSON.stringify(rows);
const bgAt = (extra = {}) => ({ sessionId: SESSION, id: 'bg01', pid: 4242, kind: 'background', name: 'api-fix', cwd: '/w/api', status: 'waiting', waitingFor: 'dialog open', ...extra });
const docsAt = (extra = {}) => ({ sessionId: OTHER, pid: 5151, kind: 'interactive', name: 'api-docs', cwd: '/w/docs', status: 'waiting', waitingFor: 'dialog open', ...extra });

// Claude Code's own drawing: a header, then a /usage panel under a rule, written in place with cursor moves, a
// placeholder erased and rewritten, and the hint that the panel closes with Esc
const USAGE_PANEL = [
  '\x1b[?1049h\x1b[2J\x1b[H',
  '\x1b[1;2H\x1b[1mClaude Code\x1b[22m\x1b[1;20Hv9.9.9',
  `\x1b[20;1H\x1b[38;2;136;136;136m${'▔'.repeat(100)}\x1b[39m`,
  '\x1b[21;4HSettings  Status  Usage',
  '\x1b[23;4HCurrent session',
  '\x1b[24;4HLoading…',
  '\x1b[24;4H\x1b[K█████\x1b[50G23% used',
  '\x1b[25;4HResets 3pm (Europe/London)',
  '\x1b[27;4HCurrent week (all models)',
  '\x1b[28;4H████████\x1b[50G16% used',
  '\x1b[29;4HResets Nov 21, 1:30am (Asia/Kolkata)',
  '\x1b[31;4HCurrent week (Fable)',
  '\x1b[32;4H██████\x1b[50G12% used',
  '\x1b[33;4HResets Nov 21, 1:29am (Asia/Kolkata)',
  '\x1b[35;4H\x1b[2mEsc to cancel\x1b[22m',
].join('');

// a background session at a dialog: its tty answers ps and stty, its output is the panel above
function backgroundAtDialog() {
  putFake('agents.json', sessionList(bgAt(), docsAt({ status: 'idle', waitingFor: undefined })));
  putFake('logs-bg01', USAGE_PANEL);
  fakeTool('ps', 'echo "pts/9 Ssl+"');
  fakeTool('stty', 'echo "40 120"');
}

test('screen reads a background session\'s open panel from its own output; peek and take-over carry it', async () => {
  backgroundAtDialog();
  const r = await clawdctl(['screen', 'api-fix']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.status, 'waiting: dialog open');
  assert.equal(r.json.dialogOpen, true);
  assert.equal(r.json.source, 'logs');
  assert.ok(Date.parse(r.json.capturedAt) > Date.now() - 60_000);
  assert.match(r.json.text, /^Settings {2}Status {2}Usage/);
  assert.match(r.json.text, /Current session\n█████ +23% used\nResets 3pm \(Europe\/London\)/);
  assert.match(r.json.text, /Esc to cancel$/);
  assert.doesNotMatch(r.json.text, /Claude Code|Loading/);

  const whole = await clawdctl(['screen', 'api-fix', '--full']);
  assert.match(whole.json.text, /^ Claude Code {7}v9\.9\.9/);

  const peek = await clawdctl(['peek', 'api-fix']);
  assert.match(peek.json.screen.text, /Current week \(Fable\)/);
  fs.mkdirSync(path.join(dir, 'live'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'live', `${SESSION}.json`), '{}');
  const taken = await clawdctl(['take-over', 'api-fix']);
  assert.equal(taken.json.pickedUp, true);
  assert.match(taken.json.screen.text, /Current session/);

  await clawdctl(['config', 'screen', 'off']);
  assert.equal((await clawdctl(['peek', 'api-fix'])).json.screen, undefined);
  assert.equal((await clawdctl(['config', 'show'])).json.screen, 'off');
  assert.equal((await clawdctl(['screen', 'api-fix'])).json.source, 'logs');
});

test('--dismiss sends Escape to a background session through claude attach, and only while a dialog is open', async () => {
  backgroundAtDialog();
  putFake('after-attach.json', sessionList(bgAt({ status: 'idle', waitingFor: undefined })));
  // script gives claude attach a terminal; this one just runs the command it wraps, on either platform's arguments
  fakeTool('script', 'while [ $# -gt 0 ]; do case "$1" in -qfec|-c) cmd="$2"; shift ;; esac; shift; done; exec sh -c "$cmd"');

  const r = await clawdctl(['screen', 'api-fix', '--dismiss']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.dismissed, true, r.json.dismissNote);
  assert.match(r.json.text, /Current week/);
  assert.equal(readFake('attach-input'), '\x1b\x04\x04');

  fs.rmSync(fake('attach-input'));
  const idle = await clawdctl(['screen', 'api-fix', '--dismiss']);
  assert.equal(idle.json.dialogOpen, false);
  assert.equal(idle.json.dismissed, false);
  assert.match(idle.json.dismissNote, /No dialog is open/);
  assert.equal(readFake('attach-input'), '');
});

test('an interactive session is read from the tmux pane that holds its own tty, and from nothing else', async () => {
  putFake('agents.json', sessionList(docsAt()));
  putFake('tmux-panes', '/dev/pts/2 %1\n/dev/pts/3 %4\n');
  putFake('after-keys.json', sessionList(docsAt({ status: 'idle', waitingFor: undefined })));
  fakeTool('ps', 'cat "$F/ps"');
  fakeTool('tmux', `case "$1" in
  list-panes) cat "$F/tmux-panes" ;;
  capture-pane) if [ "$4" = "%4" ]; then printf '  Model\\n${'─'.repeat(40)}\\n  Select model\\n  ❯ 1. Sonnet\\n    2. Opus\\n  Enter to confirm · Esc to exit\\n\\n'; else echo 'another pane'; fi ;;
  send-keys) echo "$*" >> "$F/tmux-keys"; cp "$F/after-keys.json" "$F/agents.json" ;;
esac`);

  putFake('ps', 'pts/3 Ss+\n');
  const r = await clawdctl(['screen', 'api-docs', '--dismiss']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.source, 'tmux');
  assert.equal(r.json.text, 'Select model\n❯ 1. Sonnet\n  2. Opus\nEnter to confirm · Esc to exit');
  assert.equal(readFake('tmux-keys').trim(), 'send-keys -t %4 Escape');
  assert.equal(r.json.dismissed, true);
  putFake('agents.json', sessionList(docsAt()));

  // the session is not in front of its terminal: something else is showing there
  putFake('ps', 'pts/3 Ss\n');
  const behind = await clawdctl(['screen', 'api-docs']);
  assert.equal(behind.json.text, null);
  assert.match(behind.json.note, /in front of the session/);

  // a tty no reader holds
  putFake('ps', 'pts/8 Ss+\n');
  const unknown = await clawdctl(['screen', 'api-docs']);
  assert.equal(unknown.json.text, null);
  assert.match(unknown.json.note, /cannot read/);
});

test('a session with no terminal of its own falls back to its own account, once the bot has it', async () => {
  putFake('agents.json', sessionList(docsAt()));
  fakeTool('ps', 'echo "?? Ss"');
  const none = await clawdctl(['screen', 'api-docs']);
  assert.equal(none.json.source, null);
  assert.match(none.json.note, /no terminal of its own/);

  await clawdctl(['take-over', 'api-docs']);
  fs.writeFileSync(path.join(dir, 'screen', `${OTHER}.json`), JSON.stringify({ command: 'cost', at: Date.now(), text: '/cost is open.\nTotal cost: $0.42' }));
  const own = await clawdctl(['screen', 'api-docs']);
  assert.equal(own.json.source, 'session');
  assert.equal(own.json.command, 'cost');
  assert.match(own.json.text, /Total cost: \$0\.42/);
  assert.match(own.json.note, /not its screen/);
});

test('a session stuck at a dialog reaches the bot as a dialog event with the panel\'s text', async () => {
  backgroundAtDialog();
  await clawdctl(['config', 'webhook', '--url', hookUrl()]);
  const r = await clawdctl(['dialog-check', '--session', SESSION, '--command', 'usage']);
  assert.equal(r.json.queued, true, r.stderr);
  await until(() => received.length === 1);
  const [event] = received[0].body.events;
  assert.equal(event.kind, 'dialog');
  assert.equal(event.command, 'usage');
  assert.equal(event.source, 'logs');
  assert.match(event.screen, /Current week \(all models\)\n████████ +16% used/);
  assert.match(received[0].body.text, /api-fix is stuck at a dialog \(\/usage\): Settings {2}Status {2}Usage · Current session · █████ +23% used/);

  // gone by the time it is checked: nothing is sent
  putFake('agents.json', sessionList(bgAt({ status: 'idle', waitingFor: undefined })));
  assert.equal((await clawdctl(['dialog-check', '--session', SESSION])).json.dialogOpen, false);
  await clawdctl(['config', 'screen', 'off']);
  putFake('agents.json', sessionList(bgAt()));
  await clawdctl(['dialog-check', '--session', SESSION]);
  assert.deepEqual(listOutbox(), []);
});

test('usage reads a throwaway session\'s /usage panel, removes the session, and keeps the reading a few minutes', async () => {
  putFake('bg-agents.json', sessionList({ sessionId: 'usage-0000', id: 'bg77', pid: 7777, kind: 'background', name: 'clawd-usage', cwd: home, status: 'waiting', waitingFor: 'dialog open' }));
  putFake('logs-bg77', USAGE_PANEL);
  fakeTool('ps', 'echo "pts/9 Ssl+"');
  fakeTool('stty', 'echo "40 120"');

  const r = await clawdctl(['usage']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.source, 'usage-panel');
  assert.deepEqual(r.json.limits.map((l) => [l.id, l.label, l.percentUsed]), [
    ['session', 'Current session', 23],
    ['week', 'Current week (all models)', 16],
    ['week:fable', 'Current week (Fable)', 12],
  ]);
  assert.equal(r.json.limits[1].resets, 'Nov 21, 1:30am (Asia/Kolkata)');
  assert.match(r.json.limits[1].resetsAt, /^\d{4}-11-20T20:00:00\.000Z$/);
  assert.match(r.json.text, /Esc to cancel/);
  const calls = readFake('calls').trim().split('\n');
  assert.deepEqual(calls, [`bg ${fs.realpathSync(home)} --bg -n clawd-usage /usage`, 'stop bg77', 'rm bg77']);

  // a second ask inside five minutes uses that reading; --fresh reads the panel again
  assert.equal((await clawdctl(['usage'])).json.source, 'usage-panel');
  assert.equal(readFake('calls').trim().split('\n').length, 3);
  await clawdctl(['usage', '--fresh']);
  assert.equal(readFake('calls').trim().split('\n').length, 6);
});

test('usage takes a session\'s own fresh reading of its limits when there is one, and says how to fix an untrusted folder', async () => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ at: Date.now(), sessionId: SESSION, rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-11-15T15:00:00.000Z' }, { kind: 'seven_day', percentUsed: 16 }] }));
  const r = await clawdctl(['usage']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.source, 'session');
  assert.deepEqual(r.json.limits, [
    { id: 'session', label: 'Current session', percentUsed: 23.5, resetsAt: '2026-11-15T15:00:00.000Z' },
    { id: 'week', label: 'Current week (all models)', percentUsed: 16 },
  ]);
  assert.equal(readFake('calls'), '');

  putFake('untrusted', '');
  const refused = await clawdctl(['usage', '--fresh']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /not trusted.*config usage-folder/s);
  const set = await clawdctl(['config', 'usage-folder', root]);
  assert.equal(set.json.usageFolder, root);
});

// ---------- subagents, through Overseer ----------

const T0 = Date.parse('2026-11-23T10:00:00Z');
const mirror = (agents) => {
  fs.mkdirSync(path.join(dir, 'subagents', SESSION), { recursive: true });
  fs.writeFileSync(path.join(dir, 'subagents', SESSION, 'agents.json'), JSON.stringify({ sessionId: SESSION, pid: 1, at: T0 + 60_000, overseer: true, agents }));
};
const SLEEPER = {
  id: 'ad0ab1e3e157d92d6', kind: 'claude', name: 'sleeper', type: 'general-purpose', description: 'Sleeper', status: 'running', startedAt: T0, spawnPrompt: 'Run sleep 25 three times.',
  model: 'claude-sonnet-5-5', effort: 'low', steps: 3, tokensIn: 1200, tokensOut: 80, activity: 'Bash: sleep 25',
  thread: [{ at: T0, by: 'parent', text: 'Run sleep 25 three times.' }, { at: T0 + 5_000, by: 'tool', text: 'Bash: sleep 25' }, { at: T0 + 30_000, by: 'tool', text: 'Bash: sleep 25' }],
};
const CODEX = {
  id: 'codex-mwhp3qcg-1', kind: 'codex', name: 'codexsleeper', type: 'codex', description: 'sleep 45', status: 'completed', startedAt: T0, endedAt: T0 + 50_000, spawnPrompt: 'Run sleep 45, then reply CODEXDONE.',
  model: 'gpt-6.1-terra', effort: 'xhigh', steps: 1, tokensIn: 99569, tokensOut: 156, activity: '', codex: { threadId: '01a1dec3', isAlive: true, cwd: '/w/api' },
  thread: [{ at: T0, by: 'parent', text: 'Run sleep 45, then reply CODEXDONE.' }, { at: T0 + 50_000, by: 'agent', text: 'CODEXDONE' }],
};
const installOverseer = () => {
  const cfg = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'overseer@overseer': [{ scope: 'user', version: '0.3.0' }], 'overseer-courier@overseer': [{ scope: 'user', version: '0.3.0' }] } }));
};
// stands in for the mod: answers the next subagent item that reaches the session's inbox
const modAnswers = async (answer) => {
  let item;
  await until(() => {
    const box = path.join(dir, 'inbox', SESSION);
    item = fs.existsSync(box) ? fs.readdirSync(box).map((n) => read('inbox', SESSION, n)).find((m) => m.type === 'subagent' && !m.seen) : undefined;
    return !!item;
  });
  for (const n of fs.readdirSync(path.join(dir, 'inbox', SESSION))) fs.rmSync(path.join(dir, 'inbox', SESSION, n));
  fs.writeFileSync(path.join(dir, 'answers', `${item.id}.json`), JSON.stringify(answer));
  return item;
};

test('subagents says cleanly when Overseer is not installed, and when a session has none to report', async () => {
  const none = await clawdctl(['subagents', 'api-fix']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /Overseer is not installed.*claude plugin install overseer@overseer/s);

  installOverseer();
  const empty = await clawdctl(['subagents', 'api-fix']);
  assert.equal(empty.code, 0, empty.stderr);
  assert.deepEqual(empty.json.subagents, []);
  assert.deepEqual(empty.json.overseer, { installed: true, version: '0.3.0', courier: true });
  assert.match(empty.json.note, /restarted/);
});

test('subagents lists Claude and Codex subagents as Overseer sees them, with what the bot set', async () => {
  mirror([SLEEPER, CODEX]);
  const d = path.join(dir, 'subagents', SESSION);
  fs.writeFileSync(path.join(d, 'steer.json'), JSON.stringify({ [SLEEPER.id]: { effort: 'medium' } }));
  fs.writeFileSync(path.join(d, `pause-${SLEEPER.id}`), '1');
  fs.writeFileSync(path.join(d, `holding-${SLEEPER.id}`), '1');
  const r = await clawdctl(['subagents', 'api-fix']);
  assert.equal(r.code, 0, r.stderr);
  const [s, c] = r.json.subagents;
  assert.deepEqual(
    { id: s.id, name: s.name, kind: s.kind, model: s.model, effort: s.effort, status: s.status, steps: s.steps, tokens: s.tokens, lastActivityAt: s.lastActivityAt, next: s.next, pausedByBot: s.pausedByBot },
    { id: SLEEPER.id, name: 'sleeper', kind: 'claude', model: 'claude-sonnet-5-5', effort: 'low', status: 'paused', steps: 3, tokens: { in: 1200, out: 80 }, lastActivityAt: '2026-11-23T10:00:30.000Z', next: { effort: 'medium' }, pausedByBot: true },
  );
  assert.deepEqual([c.kind, c.status, c.model, c.codex], ['codex', 'completed', 'gpt-6.1-terra', { threadId: '01a1dec3', running: false, alive: true }]);
  assert.deepEqual((await clawdctl(['sessions'])).json.sessions.find((x) => x.session === SESSION).subagents, { running: 1, total: 2 });
});

test('subagent shows the prompt and the recent thread, found by name or the start of its id', async () => {
  mirror([SLEEPER, CODEX]);
  const r = await clawdctl(['subagent', 'api-fix', 'codex-mwhp', '--count', '1']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.prompt, 'Run sleep 45, then reply CODEXDONE.');
  assert.deepEqual(r.json.thread, [{ by: 'agent', at: '2026-11-23T10:00:50.000Z', text: 'CODEXDONE' }]);
  assert.equal((await clawdctl(['subagent', 'api-fix', 'SLEEPER'])).json.thread.length, 3);
  assert.match((await clawdctl(['subagent', 'api-fix', 'nobody'])).stderr, /No subagent matches/);
  assert.match((await clawdctl(['subagent', 'api-fix', 'sleeper', 'dance'])).stderr, /message, model, effort, pause, resume, stop/);
});

test('steering a subagent needs the session taken over, and goes to the session, which says what it did', async () => {
  mirror([SLEEPER, CODEX]);
  assert.match((await clawdctl(['subagent', 'api-fix', 'sleeper', 'pause'])).stderr, /not taken over/);
  await clawdctl(['take-over', 'api-fix']);
  assert.match((await clawdctl(['subagent', 'api-fix', 'codexsleeper', 'pause'])).stderr, /pauses Claude subagents only/);
  assert.match((await clawdctl(['subagent', 'api-fix', 'sleeper', 'effort', 'huge'])).stderr, /Effort is one of/);
  assert.match((await clawdctl(['subagent', 'api-fix', 'sleeper', 'send'])).stderr, /message text/);

  const [sent, item] = await Promise.all([clawdctl(['subagent', 'api-fix', 'codexsleeper', 'send', 'Reply', 'PAPAYA']), modAnswers({ ok: true, via: 'mcp__overseer__codex', note: 'Codex continues the same thread.' })]);
  assert.deepEqual([item.op, item.agentId, item.value], ['message', CODEX.id, 'Reply PAPAYA']);
  assert.equal(sent.code, 0, sent.stderr);
  assert.deepEqual([sent.json.done, sent.json.via, sent.json.kind], [true, 'mcp__overseer__codex', 'codex']);

  const [refused] = await Promise.all([clawdctl(['subagent', 'api-fix', 'sleeper', 'stop']), modAnswers({ ok: false, reason: 'Overseer has no subagent with that id in this session now.' })]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /sleeper: Overseer has no subagent/);
});

test('the MCP server offers the subagent tools', async () => {
  mirror([SLEEPER]);
  const out = execFileSync(process.execPath, [CLAWDCTL, 'mcp'], {
    env: { ...process.env, HOME: home, CLAWD_HOME: dir, CLAUDE_BIN: path.join(root, 'claude'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') },
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_subagents', arguments: { session: 'api-fix' } } })}\n`,
    encoding: 'utf8',
    timeout: 20_000,
  }).trim().split('\n').map((l) => JSON.parse(l));
  const names = out.find((m) => m.id === 1).result.tools.map((t) => t.name);
  for (const n of ['list_subagents', 'read_subagent', 'message_subagent', 'steer_subagent']) assert.ok(names.includes(n), n);
  assert.equal(JSON.parse(out.find((m) => m.id === 2).result.content[0].text).subagents[0].name, 'sleeper');
});

test('release forgets what the bot set for subagents, so a paused one goes on', async () => {
  mirror([SLEEPER]);
  await clawdctl(['take-over', 'api-fix']);
  const d = path.join(dir, 'subagents', SESSION);
  for (const f of ['steer.json', `pause-${SLEEPER.id}`, `stop-${SLEEPER.id}`]) fs.writeFileSync(path.join(d, f), '{}');
  await clawdctl(['release', 'api-fix']);
  assert.deepEqual(fs.readdirSync(d), ['agents.json']);
});

test('subagent events read as one line each for the bot', async () => {
  await clawdctl(['config', 'machine', 'Bench']);
  await clawdctl(['config', 'webhook', '--url', hookUrl()]);
  const who = { id: CODEX.id, name: 'codexsleeper', kind: 'codex', model: 'gpt-6.1-terra', steps: 1 };
  queue('subagent', { state: 'finished', subagent: who, answer: 'CODEXDONE MANGO' });
  queue('subagent', { state: 'stuck', reason: 'no new step for 10 min', subagent: who });
  queue('subagent', { state: 'stopped', subagent: { ...who, kind: 'claude', model: 'claude-haiku-5-5', name: 'counter' } });
  queue('subagent', { state: 'failed', error: 'Ended with error', subagent: { ...who, kind: 'claude', model: 'claude-haiku-5-5', name: 'counter' } });
  await clawdctl(['flush']);
  assert.deepEqual(received[0].body.text.split('\n').sort(), [
    '[Bench] api-fix subagent "codexsleeper" (codex, gpt-6.1-terra) finished after 1 steps: CODEXDONE MANGO',
    '[Bench] api-fix subagent "codexsleeper" (codex, gpt-6.1-terra) looks stuck: no new step for 10 min. clawdctl subagent 11111111 codex-mwhp3qcg-1 shows its thread.',
    '[Bench] api-fix subagent "counter" (claude, claude-haiku-5-5) failed (Ended with error) after 1 steps.',
    '[Bench] api-fix subagent "counter" (claude, claude-haiku-5-5) was stopped after 1 steps.',
  ]);
});
