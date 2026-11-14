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
- Send it a message, interrupt it, and change its model, effort or permission mode (accept edits, or don't ask).
- Read its last messages, and stop a background session.
- Push events to the bot: asks, finished turns, interruptions and failures, plus a progress report at an interval you choose.

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
| Elsewhere, on your tailnet | the HTTP server: `clawdctl serve`, then `http://<machine>:7477/mcp` with the key |
| In Grok Bot | its device link running clawdctl commands, or its Tailscale plugin pointed at `clawdctl serve` |

`clawdctl serve` binds to the machine's Tailscale address by default, never to all interfaces, and refuses any request without the bearer key from `~/.clawd/serve.key`. Copy that key into your bot's connector settings yourself; don't paste it into a chat.

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
| `/clawd off` | take it back |
| `/clawd status` | show who has it |

If you take a session back while it is waiting on an answer, the question or permission prompt reappears on the screen.

## clawdctl

```text
clawdctl info | check-update | sessions [--all] | asks [--session <s>] [--older-than <minutes>]
clawdctl start --folder <dir> --prompt <text> [--name n] [--model m] [--effort e] [--mode handle|babysit]
clawdctl take-over <session> [--mode handle|babysit] | release <session> | mode <session> handle|babysit
clawdctl answer <ask> --decision allow|deny [--reason r] | --pick <label> | --answers '<json>'
clawdctl send <session> <text> | interrupt <session> | model <session> <m> | effort <session> <e>
clawdctl permissions <session> default|acceptEdits|dontAsk
clawdctl report <session> <minutes|off> | peek <session> [--count n] | stop <session>
clawdctl config webhook --url <url> [--key-stdin] | config webhook --off | config machine <name> | config show
clawdctl link | mcp | serve [--host ip] [--port 7477]
```

A session can be named by its id, the start of its id, its short background id or its name.

## How it works

The mod and clawdctl share files in `~/.clawd`:

- `control/<session>.json` says whether the bot has the session, in which mode, and any model or effort it set.
- `asks/` holds open questions and permission prompts; `answers/` holds the bot's answers.
- `inbox/<session>/` holds messages and interrupts for the session.
- `outbox/` holds events waiting to be pushed.

An idle session reads only its own control file, every two seconds. A taken-over session holds each ask at the point Claude would show it, waits for an answer file, and lets go the moment the session is released. Model, effort and permission-mode changes apply while the bot has the session, at each request and each permission check, so no confirmation dialog opens on a screen nobody is watching and your own default mode is left alone. Sessions that `clawdctl start` launches take a claim for their folder in their first turn, so even their first prompt is covered.

## Limits

- Tested on Linux and macOS. Windows is untested.
- A held ask waits as long as it takes. Your bot decides when to give up and answer.
- Model, effort and permission mode set by the bot last while it has the session. Released, the session goes back to its own. The bot can't set plan, auto or bypass mode.
- Background sessions need a trusted folder.

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
node scripts/release.mjs 0.3.0
```

It sets the version, validates and tests the plugin, tags the release, pins the marketplace to it, pushes, and publishes the GitHub release. `--dry-run` stops before committing.

## License

MIT
