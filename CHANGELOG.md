# Changelog

## 0.6.0

- A plan waiting for approval reaches the bot whole. The bot approves it, or sends it back with the changes wanted.
- The bot can allow a permission for the rest of the session (`answer --remember`): that exact command, or that tool. Handing the session back forgets it.
- A file from the chat can go into a session: `clawdctl put` saves it on the computer and `send --file` points the session at it.
- `schedule --session` sends a taken-over session a message later, so a turn stopped by a usage limit can carry on when the limit resets.
- A `context` event warns once when a session has used 80% of its context, and each finished turn carries `contextPercent`.
- `take-over` says when a session hasn't picked it up, which means it was opened before Clawd was installed or updated and needs a restart.
- `sessions` shows how long a taken-over session has been working (`workingMin`) or idle (`idleMin`).
- The Grok skills teach the bot how to report: outcome first and short, a choice card whenever the person must decide, replies routed to the right session, a hand-back card when a task is done, and failure, plan and permission cards. The events routine prompt is now v4 and the waiting check v2. The Grok template no longer mentions Tailscale.

## 0.5.1

- The spending cap is off unless the person turns it on for a session. The Grok skills never set, suggest or raise one on their own. Cost per session is still shown.

## 0.5.0

- Each finished turn carries what it made: links from the answer and the PR or preview links its commands printed, media files it wrote or named (images, GIFs, videos, PDFs), its commits and changed files, the PR and its checks, and the session's cost. `clawdctl file <path>` hands the bot a listed file, up to 5 MB, to post in the chat.
- When the bot takes over a terminal session, the session turns on Remote Control and the link arrives as a `remote` event. `clawdctl remote <session>` asks for it again.
- After a turn that leaves a PR's checks running, a watcher waits for them. A `ci` event says whether they passed. On a failure the session is woken with a message to fix it, unless `clawdctl ci-wake <session> off`.
- `clawdctl budget <session> <usd>` caps what a taken-over session may spend: a `budget` event at 80%, and at 100% the turn ends before its next request.
- AskGrok: a session the person opts in (`/clawd grok on`, or `clawdctl grok <session> on`) can ask the bot to do a task and gets the answer back as the tool result. At most 6 requests an hour by default. The Grok skills run read-only tasks and put anything that posts, sends, pays or changes an account to the person on a card. The bot answers with `clawdctl reply`.
- `clawdctl schedule` starts a background session later, from launchd on macOS or a systemd user timer on Linux. `schedules` and `unschedule` list and cancel.
- The events routine prompt is now v3, and the Grok skills cover each new event.

## 0.4.3

- A finished turn's answer reaches the bot whole up to 8,000 characters, up from 1,500. A longer one ends in "…" and its event says `truncated: true` with the full length, so the bot reads the rest with `peek` instead of asking the session to resend.
- `peek` returns each message whole up to 8,000 characters, and marks a longer one as cut.
- In the Claude desktop app, the question a session puts in its closing box reaches the bot with the turn, as `decision` with its options.
- The Grok instructions and skills put every decision a session raises to the user as a tap-to-answer choice card, and send the pick back to the session. The events routine prompt is now v2.

## 0.4.2

- An ask records its session's process id, and clawdctl drops an ask only when that process is gone. 0.4.1 judged by the waiting process instead, which has a moment between wait steps when none runs.

## 0.4.1

- Sessions in the Claude desktop app, or any host with no terminal, survive a long wait for the bot. The app ends a turn that sends nothing for about 15 minutes, so while the bot holds an ask the session writes a line every 8 minutes. The first line, "Clawd Bot has this session: waiting on its answer to …", stands in for the status line the app doesn't draw.
- clawdctl drops an ask whose session died or was killed while it waited, so the bot and the reminder routine no longer see it.

## 0.4.0

- Events that arrive inside the 20-second gap between pushes are sent once the gap is over, even after their session has ended. Before, a session that failed or ended just after another push left its last events waiting until some other session started.
- A failed turn's event carries the API error from the session's transcript, so the bot can say why it failed.
- `clawdctl asks --older-than <minutes>` lists asks that have waited that long, each with `waitingMin`.
- `clawdctl check-update` says whether a newer release is out than the one installed.
- Two optional Grok Bot routines in clawd-setup: an hourly reminder of unanswered asks, and a daily update check.
- The `clawdctl` shim finds Node again after Node is upgraded or switched.
- clawdctl has its own tests, and CI runs every test on Linux and macOS on each push.

## 0.3.0

- Installs and updates now get tagged releases. The marketplace pins each release to its commit, so work on `main` reaches no machine until it is released.
- `clawdctl` always runs the version Claude Code has installed, the same one each session's mod runs. `clawdctl info` shows that version and its commit.
- Each GitHub release carries the plugin as a tarball and a `SHA256SUMS` manifest.

## 0.2.1

- `clawdctl` runs from the marketplace copy, so plugin updates no longer leave it on an old version.

## 0.2.0

- The bot can set a taken-over session's permission mode: accept edits inside its folder, or don't ask.
- A test suite for the mod: `claude plugin test plugins/clawd`.
- The webhook setup accepts a bare key on its second line.
