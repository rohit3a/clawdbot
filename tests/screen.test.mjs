// The terminal replay clawdctl reads a session's screen with, and the /usage reader.
// Run: node --test tests/

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { render, panelOf, resetTime, usageLimits } = await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'clawd', 'bin', 'screen.mjs'));

test('text lands where the cursor moves it, and erases clear what they cover', () => {
  const raw = 'hello world\x1b[1;7HWORLD\x1b[2;1Hsecond line\x1b[2;7H\x1b[Kxyz\x1b[3;5Hthird\x1b[3;1H\x1b[2Xab\x1b[1B\x1b[3Gdown';
  assert.deepEqual(render(raw, { rows: 5, cols: 20 }), ['hello WORLD', 'secondxyz', 'ab  third', '  down']);
});

test('long lines wrap at the width, and the bottom line scrolls the screen up', () => {
  assert.deepEqual(render('abcdefgh', { rows: 3, cols: 5 }), ['abcde', 'fgh']);
  assert.deepEqual(render('1\r\n2\r\n3\r\n4', { rows: 3, cols: 5 }), ['2', '3', '4']);
});

test('wide characters take two cells and joiners stay with the character before them', () => {
  assert.deepEqual(render('日本x\x1b[1;5Hy', { rows: 2, cols: 10 }), ['日本y']);
  assert.deepEqual(render('✔\u{fe0f} ok', { rows: 1, cols: 10 }), ['✔\u{fe0f} ok']);
});

test('the alternate screen starts blank and leaving it brings the main screen back; OSC titles draw nothing', () => {
  const raw = 'main text\x1b]0;a title\x07\x1b[?1049h\x1b[Hfull screen\x1b[?1049l';
  assert.deepEqual(render(raw, { rows: 3, cols: 20 }), ['main text']);
  assert.deepEqual(render('main\x1b[?1049h\x1b[2;3Hpanel', { rows: 3, cols: 20 }), ['  panel']);
});

test('a panel is cut from under its rule when it shows an Esc hint; otherwise the screen is kept whole', () => {
  const screen = ['header', '', '─'.repeat(30), '> prompt', '─'.repeat(30), `${'▔'.repeat(60)} ○ low · /effort ▔`, '  Usage', '  Esc to cancel'];
  assert.equal(panelOf(screen), 'Usage\nEsc to cancel');
  assert.equal(panelOf(['header', '─'.repeat(30), '> prompt', '─'.repeat(30)]), `header\n${'─'.repeat(30)}\n> prompt\n${'─'.repeat(30)}`);
});

test('reset times read in their own time zone, and a time alone means the next one', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  assert.equal(resetTime('Nov 21, 1:30am (Asia/Kolkata)', now), '2026-11-20T20:00:00.000Z');
  assert.equal(resetTime('3pm (Europe/London)', now), '2026-11-15T15:00:00.000Z');
  assert.equal(resetTime('11am (Europe/London)', now), '2026-11-16T11:00:00.000Z');
  assert.equal(resetTime('Jan 2, 9am (America/New_York)', now), '2027-01-02T14:00:00.000Z');
  assert.equal(resetTime('soon', now), undefined);
});

test('usage limits are read whether a bar shares the heading\'s line or has its own', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const text = 'Current session ███ 40% used\nResets 3pm (Europe/London)\n\nCurrent week (all models)\n████ 16.5% used\nResets Nov 21, 1:30am (Asia/Kolkata)\nCurrent week (Opus)\nnot loaded yet';
  assert.deepEqual(usageLimits(text, now), [
    { id: 'session', label: 'Current session', percentUsed: 40, resets: '3pm (Europe/London)', resetsAt: '2026-11-15T15:00:00.000Z' },
    { id: 'week', label: 'Current week (all models)', percentUsed: 16.5, resets: 'Nov 21, 1:30am (Asia/Kolkata)', resetsAt: '2026-11-20T20:00:00.000Z' },
  ]);
});
