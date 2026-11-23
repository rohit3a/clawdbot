# Clawd Bot

Run Claude Code on your own computers from a chat with your bot, on any device.

Clawd Bot has two parts:

- **The clawd mod**, a Claude Code plugin. It is installed in every session and stays idle until a session is handed to your bot. From then on, that session's questions and permission prompts go to the bot instead of the screen, and the screen shows a single status line. Take the session back and everything shows on the screen again.
- **clawdctl**, a small command line tool and MCP server (Node 18+, no dependencies). It lists the sessions on a machine, starts new ones, takes them over, answers their asks, steers them and pushes events to your bot.

Everything runs on your machines and over links you already have. There is no server of ours in between.

## What your bot can do

- List every Claude Code session on a machine: interactive and background, busy, idle or waiting.
- Start a session in a folder, already taken over, with Remote Control on. It returns a claude.ai link you can open on your phone, the web or the Claude app, plus `claude attach` and `claude --resume` commands for picking it up at the machine later.
- Take over a running session, or release it back to you.
- Answer its questions and permission prompts.
- Send it a message, interrupt it, and change its model, effort or permission mode (accept edits, don't ask, or bypass). What it sets stays after it hands the session back, until it sets `default`.
- Read its last messages, and stop a background session.
- Read a dialog or panel left open on its screen (/usage, /cost, /status, a model picker), and close it with Escape.
- Show the Claude plan's limits as /usage does: the current session and the week, how much of each is used and when each resets.
- With [Overseer](#subagents) installed, list a session's Claude and Codex subagents, read each one's prompt and thread, and message, pause, resume, stop or re-model them.
- Push events to the bot: asks, finished turns, interruptions and failures, a session stuck at a dialog with the dialog's text, subagents that finish, fail or stall, plus a progress report at an interval you choose.
- With each finished turn, pass on what it made: links (PRs, previews), media files (images, GIFs, videos, PDFs) the bot can fetch and post, the turn's commits and changed files, the PR and its checks, and the session's cost.
- Turn on Remote Control when it takes over a terminal session, and send the bot the link.
- Watch a PR's checks after a turn. When CI fails, the bot hears about it and the session is woken to fix it.
- Show what each session has cost. A spending cap is off by default: turned on for a session, it warns the bot at 80% and stops the turn at 100%.
- Start a session later: at a time, or after a delay, from the computer's own timer (launchd on macOS, systemd on Linux).
- Let a session ask your bot for help, if you turn it on for that session (AskGrok). The bot does read-only work itself, and anything that posts, sends, pays or changes an account waits for your yes. 6 requests an hour by default.

## Who decides

Each taken-over session has a mode:

- **handle it**: the bot answers what it can, and asks you when it is unsure or the step is risky.
- **babysit**: every question and permission prompt goes to you.

Change the mode by telling your bot, or by typing `/clawd babysit` or `/clawd handle` in the session.

## Install

On each machine you want to control:

```bash
claude plugin marketplace add rohit3a/clawdbot
```

```bash
claude plugin install clawd@clawdbot
```

Then put `clawdctl` on your PATH:

```bash
node ~/.claude/plugins/marketplaces/clawdbot/plugins/clawd/bin/clawdctl.mjs link
```

`clawdctl info` should now print the machine name, your Claude Code version and the installed Clawd version and commit. To give the machine a friendlier name:

```bash
clawdctl config machine Laptop
```

Background sessions only start in folders you have trusted. Open Claude in a folder once and accept the trust prompt before asking the bot to start work there.

## Connect your bot

Any agent that speaks MCP can drive clawdctl. Pick the link that fits where your bot runs.

| Your bot runs | Connect it with |
| --- | --- |
| On the same machine | the stdio server: `clawdctl mcp` |
| Elsewhere, over SSH | the stdio server through SSH: `ssh <host> clawdctl mcp` |
| Elsewhere, on a private network | the HTTP server: `clawdctl serve --host <private ip>`, then `http://<private ip>:7477/mcp` with the key |
| In Grok Bot | its device link running clawdctl commands (the Clawd Bot template does this) |

`clawdctl serve` listens on localhost unless `--host` names one private address (your LAN or VPN), never on all interfaces, and refuses any request without the bearer key from `~/.clawd/serve.key`. Copy that key into your bot's connector settings yourself; don't paste it into a chat.

### Pushes

To have events pushed to your bot, give clawdctl a webhook, for example a Grok Bot routine's trigger URL. Pipe the key in so it never shows up in your shell history:

```bash
clawdctl config webhook --url https://example.com/your-hook --key-stdin < keyfile
```

Each push is a JSON POST of `{ machine, sentAt, events, text }`, where `text` is one readable line per event. Pushes are batched at least 20 seconds apart, and retried less and less often while the webhook fails. `clawdctl config webhook --off` stops them.

To update later:

```bash
claude plugin marketplace update clawdbot
```

```bash
claude plugin update clawd@clawdbot
```

`clawdctl` updates at once; sessions load the new mod when they next start.

### Releases

Installs and updates get the latest release, never unreleased work on `main`: the marketplace pins each release to its commit. Each [GitHub release](https://github.com/rohit3a/clawdbot/releases) lists that commit and carries the plugin as a tarball with a `SHA256SUMS` manifest. What changed is in [CHANGELOG.md](CHANGELOG.md).

## In the session

| Type | What it does |
| --- | --- |
| `/clawd on` | hand this session to your bot |
| `/clawd babysit` or `/clawd handle` | hand it over in that mode, or switch modes |
| `/clawd off` | take it back (the bot's model, effort and permission mode stay) |
| `/clawd clear` | drop the bot's model, effort and permission mode, back to the session's own |
| `/clawd status` | show who has it, and the bot's settings |
| `/clawd grok on` or `/clawd grok off` | let this session ask your bot for help with its AskGrok tool, or stop it |

If you take a session back while it is waiting on an answer, the question or permission prompt reappears on the screen.

The Claude desktop app draws no status line for plugins. There, a session your bot holds writes a dim line instead, "Clawd Bot has this session: waiting on its answer to …", and repeats it every 8 minutes while it waits. The app ends a turn that sends nothing for about 15 minutes, and the repeated line keeps it going.

## clawdctl

```text
clawdctl info | check-update | sessions [--all] | asks [--session <s>] [--older-than <minutes>]
clawdctl start --folder <dir> --prompt <text> [--name n] [--model m] [--effort e] [--mode handle|babysit]
clawdctl take-over <session> [--mode handle|babysit] | release <session> | mode <session> handle|babysit
clawdctl answer <ask> --decision allow|deny [--reason r] | --pick <label> | --answers '<json>'
clawdctl send <session> <text> | interrupt <session> | model <session> <m> | effort <session> <e>
clawdctl permissions <session> default|acceptEdits|dontAsk|bypass
clawdctl report <session> <minutes|off> | peek <session> [--count n] | stop <session>
clawdctl screen <session> [--dismiss] [--full] | usage [--fresh] [--folder <dir>]
clawdctl subagents <session> | subagent <session> <id> [--count n]
clawdctl subagent <session> <id> send <text> | model <m> | effort <e> | pause | resume | stop
clawdctl remote <session> | budget <session> <usd|off> | ci-wake <session> on|off | file <path>
clawdctl grok <session> on|off [--per-hour n] | requests | reply <request> --text <t> | --decline <why>
clawdctl schedule --at <21:30|+90m|ISO> --folder <dir> --prompt <text> [--name n] [--model m] [--effort e] [--mode m]
clawdctl schedules | unschedule <id>
clawdctl config webhook --url <url> [--key-stdin] | config webhook --off | config machine <name> | config show
clawdctl config screen on|off | config usage-folder <dir>
clawdctl link | mcp | serve [--host ip] [--port 7477]
```

A session can be named by its id, the start of its id, its short background id or its name.

### Dialogs on the screen

A dialog such as /usage, /cost, /status or the model picker holds the keys, and nothing of it reaches the bot by itself. `sessions` shows such a session as `waiting: dialog open`.

```bash
clawdctl screen api-fix
```

```json
{ "session": "…", "name": "api-fix", "status": "waiting: dialog open", "dialogOpen": true, "source": "logs",
  "text": "Settings  Status  Config  Usage  Stats\n\nCurrent week (all models)\n████████  17% used\n…\nEsc to cancel",
  "capturedAt": "2026-11-15T09:35:01.018Z" }
```

`text` is the open panel; `--full` gives the whole screen. `--dismiss` sends Escape afterwards, only while a dialog is open, since Escape during a turn would interrupt it, and says whether the dialog closed.

Only the session's own terminal is read:

| Session | Read from | Escape through |
| --- | --- | --- |
| Background | its own output, `claude logs`, replayed at its terminal's size | `claude attach`, in a terminal `script` gives it |
| Interactive, in tmux or WezTerm | the pane that holds the session's tty | the same pane |
| Interactive, in iTerm2 or Terminal on a Mac | the tab that holds the session's tty | iTerm2 only |
| Anything else | the session's own account: model, context, cost and plan limits, when the bot has it | not offered |

An interactive session is read only while it is in front in its terminal. On a Mac, the first read asks once for permission to control iTerm2 or Terminal. Panels show what the session's screen shows, including the account's email in /status.

When a session the bot holds sits at a dialog for 3 seconds, a `dialog` event carries its text, once per opening. `peek` and `take-over` include it as `screen`. `clawdctl config screen off` stops these automatic reads; `clawdctl screen` still works.

### Plan usage

```bash
clawdctl usage
```

```json
{ "machine": "Laptop", "source": "usage-panel", "readAt": "2026-11-15T09:32:59.784Z",
  "limits": [
    { "id": "session", "label": "Current session", "percentUsed": 23, "resets": "3pm (Europe/London)", "resetsAt": "2026-11-15T15:00:00.000Z" },
    { "id": "week", "label": "Current week (all models)", "percentUsed": 17, "resets": "Nov 21, 1:30am (Asia/Kolkata)", "resetsAt": "2026-11-20T20:00:00.000Z" }
  ] }
```

A reading under 5 minutes old is used as it is: the last panel read, or the limits a session on the computer saw in its last API response (`source: "session"`). Otherwise, or with `--fresh`, clawdctl opens /usage in a throwaway background session in your home folder, reads it, and stops and removes the session, in about 10 seconds. That sends no prompt to the model, so it uses none of the plan. The folder must be trusted: `--folder <dir>` or `clawdctl config usage-folder <dir>` names another one.

### Subagents

Subagent control works through [Overseer](https://github.com/rohit3a/overseer) 0.3.0 or later, which tracks every Claude subagent (the Agent tool) and Codex agent (its `codex` tool) a session starts. Install it on the same computer:

```bash
claude plugin marketplace add rohit3a/overseer
```

```bash
claude plugin install overseer@overseer
```

```bash
claude plugin install overseer-courier@overseer
```

With Overseer 0.4.0 or later and its courier, the bot steers through Overseer's own control, as its pane does. The courier is what lets the bot steer a finished Claude subagent its message wakes. Overseer 0.3.0 still works, with the limits below. Without Overseer, `subagents` says so and names these commands. It also says when Overseer is installed but turned off, or not running in that session. A session picks Overseer up when it next starts.

```bash
clawdctl subagents api-fix
```

```json
{ "session": "…", "name": "api-fix", "overseer": { "installed": true, "version": "0.3.0", "courier": true },
  "subagents": [
    { "id": "a8d1…", "name": "counter", "kind": "claude", "model": "claude-haiku-5-5", "effort": "low", "status": "running",
      "steps": 16, "tokens": { "in": 41200, "out": 980 }, "activity": "Bash: echo 15", "lastActivityAt": "2026-11-23T12:43:21.000Z" },
    { "id": "codex-mwt9…", "name": "codexsleeper", "kind": "codex", "model": "gpt-6.1-terra", "effort": "xhigh", "status": "completed",
      "steps": 1, "codex": { "threadId": "…", "running": false, "alive": true } } ] }
```

`subagent <session> <id>` adds the prompt it was given and its last 12 thread entries (`--count` up to 40). A subagent is named by its id, the start of its id, or its name.

Steering a subagent needs the session taken over, like steering the session itself:

| Command | Claude subagent | Codex agent |
| --- | --- | --- |
| `send <text>` | running: arrives with its next request. Finished: wakes it under the same id, with its history | running: joins the current turn. Finished: continues the same Codex thread, through Overseer's own `codex` tool |
| `model <m>`, `effort <e>` | from its next request | the running turn at once (see below); a finished one from its next turn |
| `pause`, `resume` | holds before its next request until resumed, stopped or released | not offered: Codex has no pause, only stopping the turn |
| `stop` | ends at its next request | stops the running turn |

Each command answers with what was done and how (`via`). Through Overseer 0.4.0 that reads `overseer override`, `overseer overseer-courier`, `overseer turn/settings/update` or `overseer turn/interrupt`. A message from the bot reaches the subagent marked as the person's, and the parent session is told in a line of its own, so it trusts the subagent's report of it.

Codex changes effort in a running turn in place, but it refuses some model switches mid-turn (for example from `gpt-6.1-terra` to `gpt-6-luna`). Through Overseer 0.4.0 a refused switch stops the turn, and a new turn continues on the new model (`via: overseer turn/interrupt`). With Overseer 0.3.0 only Overseer sees Codex's answer, so the command says the change is unconfirmed. Either way, the bot's next message to that agent uses it.

Unlike the session's own model, effort and permission mode, what the bot sets for a subagent ends when it hands the session back. Through Overseer 0.4.0 it is given back: pauses are resumed and model and effort go back to the agent's own. A Codex turn that already moved to a new model stays on it.

A session the bot holds sends a `subagent` event when one of its subagents finishes (with its answer), fails, is stopped, or makes no new step for 10 minutes. Through Overseer 0.4.0, Overseer's pane shows the bot's changes like its own. With 0.3.0 it shows none of them. Either way `subagents` shows them (`next`, `pausedByBot`, `stopping`).

## How it works

The mod and clawdctl share files in `~/.clawd`:

- `control/<session>.json` says whether the bot has the session, in which mode, and any model or effort it set.
- `asks/` holds open questions and permission prompts; `answers/` holds the bot's answers.
- `inbox/<session>/` holds messages and interrupts for the session.
- `outbox/` holds events waiting to be pushed.
- `screen/<session>.json` is a taken-over session's own account of itself at its last slash command, for a terminal clawdctl cannot read.
- `usage.json` holds the plan limits from the newest API response of any session on the computer.
- `subagents/<session>/` holds `agents.json`, the session's copy of Overseer's subagent list, and, while the bot has the session, `steer.json` (model and effort it set per subagent) and `pause-<id>` and `stop-<id>` markers. Release removes all but `agents.json`.

`CLAWD_HOME` moves `~/.clawd` elsewhere, for clawdctl and the mod alike.

An idle session reads only its own control file, every two seconds, and writes `usage.json` when its plan limits move. A taken-over session holds each ask at the point Claude would show it, waits for an answer file, and lets go the moment the session is released. Model, effort and permission-mode changes apply at each request and each permission check, so no confirmation dialog opens on a screen nobody is watching and your own default mode is left alone. They are kept in `~/.clawd/runs/<session>.json`, which a release leaves in place, so they stay in force after the bot hands the session back. Sessions that `clawdctl start` launches take a claim for their folder in their first turn, so even their first prompt is covered.

## Limits

- Linux and macOS only. Windows is not supported: scheduled tasks need launchd or systemd, and clawdctl's screen reads, `start` and its process checks assume a POSIX system. Clawd has not been tried in WSL.
- A held ask waits as long as it takes. Your bot decides when to give up and answer.
- Screen capture reads background sessions, and interactive ones in tmux, WezTerm, iTerm2 or Terminal. Other terminals (GNOME Terminal, a plain SSH login) get the session's own account instead of its screen.
- Model, effort and permission mode set by the bot stay after it releases the session, and the status line says so ("Clawd Bot's settings stay"). They end when the bot sets them back to `default` (which works on a released session), or when you type `/clawd clear`. Setting a new value needs the session taken over. The bot can't set plan or auto mode.
- `bypass` allows every tool call Claude would ask you about, in the session and its subagents, with no prompt, also after a release. Your settings' deny rules still refuse, as do safety floors on the computer such as Permit's, which deny rather than ask. It never goes past an administrator's limit on a tool. It is not Claude Code's `bypassPermissions` mode: the session's own mode is left as it is, and calls Claude would allow anyway are untouched.
- Background sessions need a trusted folder.
- PR and CI status need the `gh` CLI signed in on the computer.
- The cost and the budget need a host that keeps a cost ledger. The terminal always has one.
- Scheduled tasks survive a reboot. On Linux they are persistent systemd user timers: a task whose time passed while the computer was off runs once your user's systemd starts. That happens at boot if lingering is on (`loginctl enable-linger`), otherwise at your next login. On macOS they run at wake if the Mac slept through them. Tasks scheduled on Linux before 1.0.0 still go away at a reboot.
- A session waits up to 20 minutes for an AskGrok answer. After that the answer arrives as a message.
- Subagents need Overseer. With Overseer 0.3.0, or 0.4.0 without its courier running, a Claude subagent the bot's own message woke runs outside the mod's sight until it finishes: model, effort, pause and stop do not reach that run. Overseer 0.4.0 with its courier closes that gap.
- Codex agents can't be paused. Codex's app-server has no pause, only stopping the turn, and an emulated pause would lose the tool call the turn is in. Stop and a later message do the same job.
- A Codex model switch that Codex refuses mid-turn costs that turn: through Overseer 0.4.0 the turn is stopped and continued on the new model, losing whatever was in flight.

## Tests and releases

```bash
claude plugin test plugins/clawd
```

```bash
node --test tests/*.test.mjs
```

The first runs the mod's tests against Claude Code itself; the second runs clawdctl as a bot would, against a stand-in `claude` and a local webhook.

To cut a release, add a section for the version to `CHANGELOG.md`, commit it, then on `main`:

```bash
node scripts/release.mjs 1.0.0
```

It sets the version (or keeps it, when the merged PR already set it), validates and tests the plugin, tags the release, pins the marketplace to it, pushes, and publishes the GitHub release. If any check fails, it puts the version files back and commits nothing. `--dry-run` stops before committing.

## License

MIT
