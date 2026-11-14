#!/usr/bin/env node
// Cut a Clawd release: node scripts/release.mjs <version> [--dry-run]
// 1. on a clean, up-to-date main: set the version, validate and test the plugin, commit and tag v<version>
// 2. pin the marketplace to that tag's commit, so installs and updates get exactly the release
// 3. push, then publish a GitHub release with the notes from CHANGELOG.md, a tarball and SHA256SUMS

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN = 'plugins/clawd';
const REPO_URL = 'https://github.com/rohit3a/clawdbot.git';
const [version, flag] = process.argv.slice(2);
const dry = flag === '--dry-run';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
const git = (...args) => run('git', args).trim();
const fail = (msg) => { process.stderr.write(`release: ${msg}\n`); process.exit(1); };
const step = (msg) => process.stdout.write(`- ${msg}\n`);
const editJson = (file, fn) => {
  const p = path.join(ROOT, file);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  fn(data);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
};

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail('usage: node scripts/release.mjs <x.y.z> [--dry-run]');
const tag = `v${version}`;
if (git('branch', '--show-current') !== 'main') fail('release from main');
if (git('status', '--porcelain')) fail('commit or stash your changes first');
git('fetch', '--quiet', 'origin', 'main', '--tags');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('main is not the same as origin/main');
if (git('tag', '--list', tag)) fail(`${tag} already exists`);

const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const notes = changelog.split(/^## /m).find(s => s.startsWith(`${version}\n`) || s.startsWith(`${version} `))?.split('\n').slice(1).join('\n').trim();
if (!notes) fail(`CHANGELOG.md has no "## ${version}" section`);

step(`version ${version}`);
editJson(`${PLUGIN}/.claude-plugin/plugin.json`, p => { p.version = version; });
const ctl = path.join(ROOT, PLUGIN, 'bin/clawdctl.mjs');
const src = fs.readFileSync(ctl, 'utf8');
if (!/^const VERSION = '[^']*';$/m.test(src)) fail('no VERSION line in clawdctl.mjs');
fs.writeFileSync(ctl, src.replace(/^const VERSION = '[^']*';$/m, `const VERSION = '${version}';`));

step('validate and test');
run('claude', ['plugin', 'validate', PLUGIN], { stdio: 'inherit' });
run('claude', ['plugin', 'validate', '.'], { stdio: 'inherit' });
run('claude', ['plugin', 'test', PLUGIN], { stdio: 'inherit' });
run(process.execPath, ['--test', ...fs.readdirSync(path.join(ROOT, 'tests')).filter(f => f.endsWith('.test.mjs')).map(f => `tests/${f}`)], { stdio: 'inherit' });

if (dry) {
  git('checkout', '--', PLUGIN);
  step('dry run: stopped before committing; nothing changed');
  process.exit(0);
}

step(`commit and tag ${tag}`);
git('add', '-A', PLUGIN);
git('commit', '--quiet', '-m', `Clawd ${version}`);
git('tag', '-a', tag, '-m', `Clawd ${version}`);
const sha = git('rev-parse', `${tag}^{commit}`);

step(`pin the marketplace to ${sha.slice(0, 7)}`);
editJson('.claude-plugin/marketplace.json', m => {
  const entry = m.plugins.find(p => p.name === 'clawd');
  entry.source = { source: 'git-subdir', url: REPO_URL, path: PLUGIN, ref: tag, sha };
  entry.version = version;
});
run('claude', ['plugin', 'validate', '.'], { stdio: 'inherit' });
git('add', '.claude-plugin/marketplace.json');
git('commit', '--quiet', '-m', `Install Clawd ${version}`);

step('build the release files');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-release-'));
const tarball = path.join(out, `clawd-${version}.tar.gz`);
run('git', ['archive', '--format=tar.gz', `--prefix=clawd/`, '-o', tarball, `${tag}:${PLUGIN}`]);
const files = git('ls-tree', '-r', '--name-only', tag, PLUGIN).split('\n').filter(Boolean);
const sums = files.map(f => {
  const bytes = execFileSync('git', ['show', `${tag}:${f}`], { cwd: ROOT, maxBuffer: 64 << 20 });
  return `${createHash('sha256').update(bytes).digest('hex')}  ${f.slice(PLUGIN.length + 1)}`;
});
sums.push(`${createHash('sha256').update(fs.readFileSync(tarball)).digest('hex')}  ${path.basename(tarball)}`);
fs.writeFileSync(path.join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
const body = `${notes}\n\nCommit \`${sha}\`. Install or update as the README says; \`clawdctl info\` shows the installed commit.\n`;
fs.writeFileSync(path.join(out, 'notes.md'), body);

step('push');
git('push', '--quiet', 'origin', 'main', tag);

step('publish the GitHub release');
run('gh', ['release', 'create', tag, '--title', `Clawd ${version}`, '--notes-file', path.join(out, 'notes.md'), '--verify-tag', tarball, path.join(out, 'SHA256SUMS')], { stdio: 'inherit' });
step(`done: ${tag} at ${sha}`);
