// What a Claude Code session's terminal shows: a small terminal emulator that replays the session's own output
// into a grid of cells, and readers for the panels found there (/usage). No dependencies.

const WIDE = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb], [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

function width(cp) {
  if (cp === 0x200d || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1f3fb && cp <= 0x1f3ff) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 0;
  for (const [lo, hi] of WIDE) if (cp >= lo && cp <= hi) return 2;
  return 1;
}

// Replays raw terminal output (cursor moves, erases, scrolling, the alternate screen) on a rows x cols grid and
// returns the lines it ends showing, trailing blanks trimmed. Colours and modes are read past; text is all it keeps.
export function render(raw, { rows = 50, cols = 200 } = {}) {
  const blank = () => Array.from({ length: cols }, () => ' ');
  let grid = Array.from({ length: rows }, blank);
  let main;
  let r = 0, c = 0, wrap = false;
  let saved = { r: 0, c: 0 };
  let top = 0, bottom = rows - 1;
  const clampR = (v) => Math.max(0, Math.min(rows - 1, v));
  const clampC = (v) => Math.max(0, Math.min(cols - 1, v));
  const scrollUp = (n = 1) => { for (let i = 0; i < n; i++) { grid.splice(top, 1); grid.splice(bottom, 0, blank()); } };
  const scrollDown = (n = 1) => { for (let i = 0; i < n; i++) { grid.splice(bottom, 1); grid.splice(top, 0, blank()); } };
  const lineFeed = () => { if (r === bottom) scrollUp(); else r = clampR(r + 1); };
  const put = (ch, w) => {
    if (w === 0) { const pc = c > 0 ? c - 1 : 0; grid[r][pc] += ch; return; }
    if (wrap || c + w > cols) { c = 0; lineFeed(); wrap = false; }
    grid[r][c] = ch;
    if (w === 2 && c + 1 < cols) grid[r][c + 1] = '';
    if (c + w >= cols) { c = cols - 1; wrap = true; } else c += w;
  };
  const eraseLine = (row, from, to) => { for (let x = from; x <= to; x++) grid[row][x] = ' '; };

  const csi = (params, priv, final) => {
    const p = params.split(';').map((v) => (v === '' ? undefined : Number(v)));
    const n = (i = 0, d = 1) => (p[i] === undefined || Number.isNaN(p[i]) || p[i] === 0 ? d : p[i]);
    const raw0 = p[0] ?? 0;
    if (priv === '?') {
      if ((final === 'h' || final === 'l') && p.some((v) => v === 1049 || v === 1047 || v === 47)) {
        if (final === 'h' && !main) { main = { grid, r, c }; grid = Array.from({ length: rows }, blank); }
        else if (final === 'l' && main) { ({ grid, r, c } = main); main = undefined; }
      }
      return;
    }
    if (priv) return;
    wrap = false;
    switch (final) {
      case 'A': r = Math.max(r < top ? 0 : top, r - n()); break;
      case 'B': r = Math.min(r > bottom ? rows - 1 : bottom, r + n()); break;
      case 'C': c = clampC(c + n()); break;
      case 'D': c = clampC(c - n()); break;
      case 'E': r = clampR(r + n()); c = 0; break;
      case 'F': r = clampR(r - n()); c = 0; break;
      case 'G': case '`': c = clampC(n() - 1); break;
      case 'H': case 'f': r = clampR(n(0) - 1); c = clampC(n(1) - 1); break;
      case 'd': r = clampR(n() - 1); break;
      case 'J':
        if (raw0 === 0) { eraseLine(r, c, cols - 1); for (let y = r + 1; y < rows; y++) eraseLine(y, 0, cols - 1); }
        else if (raw0 === 1) { eraseLine(r, 0, c); for (let y = 0; y < r; y++) eraseLine(y, 0, cols - 1); }
        else grid = Array.from({ length: rows }, blank);
        break;
      case 'K':
        if (raw0 === 0) eraseLine(r, c, cols - 1);
        else if (raw0 === 1) eraseLine(r, 0, c);
        else eraseLine(r, 0, cols - 1);
        break;
      case 'X': eraseLine(r, c, Math.min(cols - 1, c + n() - 1)); break;
      case '@': grid[r].splice(c, 0, ...Array.from({ length: n() }, () => ' ')); grid[r].length = cols; break;
      case 'P': grid[r].splice(c, n()); while (grid[r].length < cols) grid[r].push(' '); break;
      case 'L': if (r >= top && r <= bottom) for (let i = 0; i < n(); i++) { grid.splice(bottom, 1); grid.splice(r, 0, blank()); } break;
      case 'M': if (r >= top && r <= bottom) for (let i = 0; i < n(); i++) { grid.splice(r, 1); grid.splice(bottom, 0, blank()); } break;
      case 'S': scrollUp(n()); break;
      case 'T': scrollDown(n()); break;
      case 'r': top = clampR(n(0) - 1); bottom = p[1] ? clampR(p[1] - 1) : rows - 1; if (top >= bottom) { top = 0; bottom = rows - 1; } r = 0; c = 0; break;
      case 's': saved = { r, c }; break;
      case 'u': ({ r, c } = saved); break;
      default: break;
    }
  };

  const s = String(raw);
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (cp === 0x1b) {
      const next = s[i];
      if (next === '[') {
        let j = i + 1;
        let priv = '';
        if (/[?>=<!]/.test(s[j] ?? '')) priv = s[j++];
        let params = '';
        while (j < s.length && /[0-9;:]/.test(s[j])) params += s[j++];
        while (j < s.length && /[ -/]/.test(s[j])) j++;
        const final = s[j] ?? '';
        i = j + 1;
        csi(params.replace(/:/g, ';'), priv, final);
      } else if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
        // OSC, DCS and the like run to BEL or ST
        let j = i + 1;
        while (j < s.length && s[j] !== '\x07' && !(s[j] === '\x1b' && s[j + 1] === '\\')) j++;
        i = s[j] === '\x07' ? j + 1 : j + 2;
      } else if (next === '7') { saved = { r, c }; i++; }
      else if (next === '8') { ({ r, c } = saved); wrap = false; i++; }
      else if (next === 'D') { lineFeed(); i++; }
      else if (next === 'E') { lineFeed(); c = 0; i++; }
      else if (next === 'M') { if (r === top) scrollDown(); else r = clampR(r - 1); i++; }
      else if (next === 'c') { grid = Array.from({ length: rows }, blank); r = 0; c = 0; i++; }
      else if (next === '(' || next === ')' || next === '*' || next === '+' || next === '#' || next === '%') i += 2;
      else i++;
      continue;
    }
    if (cp === 0x0d) { c = 0; wrap = false; continue; }
    if (cp === 0x0a || cp === 0x0b || cp === 0x0c) { lineFeed(); wrap = false; continue; }
    if (cp === 0x08) { c = Math.max(0, c - 1); wrap = false; continue; }
    if (cp === 0x09) { c = clampC((Math.floor(c / 8) + 1) * 8); continue; }
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
    put(ch, width(cp));
  }
  const lines = grid.map((row) => row.join('').replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  while (lines.length && !lines[0]) lines.shift();
  return lines;
}

// The open panel, cut from the whole screen: Claude Code draws a panel under a rule of ▔ (fullscreen) or ─ (main
// screen) that spans the width; the last such rule above the bottom starts it. With none, the screen is returned whole.
export function panelOf(lines) {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    // the rule can carry a few words drawn over its end (the effort indicator: "○ low · /effort")
    const rule = /[▔─━]{20,}/.exec(t)?.[0] ?? '';
    if (rule && rule.length >= t.length * 0.6) {
      // the prompt box sits between two ─ rules; a panel's rule has text right under it
      if (lines.slice(i + 1).some((l) => /Esc to|Enter to|↑\/↓|to (cancel|close|exit|go back|select)/i.test(l))) { start = i + 1; break; }
    }
  }
  const out = (start >= 0 ? lines.slice(start) : lines).map((l) => l.replace(/\s+$/, ''));
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  const indent = Math.min(...out.filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length));
  return out.map((l) => l.slice(indent)).join('\n');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "Nov 21, 1:30am (Asia/Kolkata)", "3pm (Europe/London)" or "Nov 21 at 1:30am": the next such moment, in UTC
export function resetTime(text, now = Date.now()) {
  const m = /(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,|\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i.exec(text);
  if (!m || (!m[5] && m[4] === undefined)) return undefined;
  let hour = Number(m[3]) % 12 + (m[5]?.toLowerCase() === 'pm' ? 12 : 0);
  if (!m[5]) hour = Number(m[3]);
  const minute = Number(m[4] ?? 0);
  const zone = m[6];
  const parts = (t) => {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    const o = Object.fromEntries(f.formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
    return o;
  };
  let local;
  try { local = parts(now); } catch { return undefined; }
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : local.month - 1;
  if (month < 0) return undefined;
  const day = m[2] ? Number(m[2]) : local.day;
  // wall time in the zone to an instant: guess it as UTC, then take off the zone's offset at that moment
  const at = (year, mon, d) => {
    const guess = Date.UTC(year, mon, d, hour, minute);
    const seen = parts(guess);
    const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour % 24, seen.minute) - guess;
    return guess - offset;
  };
  let t = at(local.year, month, day);
  if (!m[1] && t < now - 60_000) t = at(local.year, month, day + 1);
  if (m[1] && t < now - 86_400_000) t = at(local.year + 1, month, day);
  return new Date(t).toISOString();
}

// The limits a /usage panel shows: a heading ("Current session", "Current week (all models)"), then its bar with
// "N% used", then "Resets …". Each reading keeps the panel's own words beside the parsed values.
export function usageLimits(text, now = Date.now()) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^(Current (?:session|week)[^█▉▊▋▌▍▎▏░▒▓%]*?)\s*(?=[█▉▊▋▌▍▎▏░▒▓]|\d+(?:\.\d+)?%|$)/.exec(lines[i]);
    if (!head) continue;
    const label = head[1].trim();
    const window = lines.slice(i, i + 4).join('\n');
    const pct = /(\d+(?:\.\d+)?)%\s*used/i.exec(window);
    if (!pct) continue;
    const resets = /Resets?\s+([^\n]+)/i.exec(window)?.[1]?.trim();
    const model = /\(([^)]+)\)/.exec(label)?.[1];
    const id = /session/i.test(label) ? 'session' : model && !/all models/i.test(model) ? `week:${model.toLowerCase()}` : 'week';
    out.push({ id, label, percentUsed: Number(pct[1]), ...(resets && { resets, resetsAt: resetTime(resets, now) }) });
  }
  return out;
}
