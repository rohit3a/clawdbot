# Changelog

## 1.0.0

- Works with Claude Code 2.1.330 as well as 2.1.325. A finished turn reads the control file as it is then, so a take-over or release in the two seconds before it decides whether the turn reaches the bot. A tick asked for while another runs (a `/clawd` command, a turn's start) now runs right after it instead of being skipped.
- Subagent steering goes through [Overseer](https://github.com/rohit3a/overseer) 0.4.0's control when it is installed. Overseer's pane then shows what the bot set. A Codex model switch that Codex refuses mid-turn still lands: the turn stops and a new one continues on the new model. A message to a finished Claude subagent goes through `overseer-courier`, so model, effort, pause and stop reach the run it wakes. On release the bot's model, effort and pauses are put back. With Overseer 0.3.0, Clawd steers as before.
- With Overseer 0.3.0, a model or effort change to a running Codex turn now says it is unconfirmed. Codex applies effort in place but refuses some model switches mid-turn, and only Overseer sees its answer. 0.8.0 reported every change as applied.
- `subagents` says why a session has none to show: Overseer is not installed, it is installed but turned off, or it is not running in that session. Each session's `agents.json` now has `overseer: false` when Overseer is not loaded.
- On Linux, scheduled tasks are persistent systemd user timers, kept in unit files under `~/.config/systemd/user/`. They survive a reboot. A task whose time passed while the computer was off runs when your user's systemd starts again: at boot with lingering on (`loginctl enable-linger`), otherwise at login. Running or cancelling a task removes its files. Tasks scheduled with 0.8.0 still go away at a reboot.
- A scheduled task runs with the `CLAWD_HOME` it was scheduled under, on Linux and macOS.
- `scripts/release.mjs` tags a version that the PR already set without making an empty commit. Any failing check stops the release, puts the version files back, and commits nothing.
- The docs say plainly that Windows is not supported.

## 0.8.0

- Subagents, through [Overseer](https://github.com/rohit3a/overseer) 0.3.0 or later, for Claude subagents and Codex agents alike. `clawdctl subagents <session>` lists a session's subagents as JSON: id, name, kind (`claude` or `codex`), model, effort, status, steps, tokens, and last activity. `clawdctl subagent <session> <id> [--count n]` adds the prompt it was given and its recent thread. Without Overseer installed, both say so and name the install commands.
- `clawdctl subagent <session> <id> send <text> | model <m> | effort <e> | pause | resume | stop` steers one, while the bot has the session. A message reaches a running subagent with its next request, or a running Codex turn at once (`turn/steer`). It wakes a finished one under the same id with its history; a finished Codex agent continues its thread through Overseer's own `codex` tool. Model and effort apply from a Claude subagent's next request, and to a running Codex turn at once. Pause holds a Claude subagent before its next request until resumed. Stop ends a Claude subagent at its next request, or interrupts the running Codex turn. Each answers with what it did and how.
- A session the bot holds sends a `subagent` event when one of its subagents finishes (with its answer), fails, is stopped, or makes no new step for 10 minutes (`CLAWD_SUBAGENT_STUCK_MS` changes that). A permission ask from a subagent names it (`subagentName`).
- `sessions` counts each session's subagents (`subagents: { running, total }`).
- MCP: `list_subagents`, `read_subagent`, `message_subagent` and `steer_subagent`.
- Clawd reads Overseer's state and drives its Codex bridge; it changes nothing in Overseer. Every session keeps a copy of its subagent list in `~/.clawd/subagents/<session>/agents.json`.
- The mod honours `CLAWD_HOME`, as clawdctl already did.
- The events routine prompt is now v7, with the `subagent` event.

## 0.7.0

- `clawdctl screen <session>` reads the dialog or panel a session shows (/usage, /cost, /status, a model picker) and prints it as JSON: `session`, `status`, `text`, `capturedAt`, and `source`, where the text came from. `--dismiss` then sends Escape, only while a dialog is open, and says whether it closed. `--full` returns the whole screen.
- Only the session's own terminal is read. A background session is read from its own output (`claude logs`), replayed by a small terminal emulator at its terminal's size, and takes Escape through `claude attach`. An interactive session is read from the tmux or WezTerm pane, or the iTerm2 or Terminal tab on a Mac, that holds its own tty, and only while the session is in front there. A terminal clawdctl cannot read gets the session's own account instead (model, context, cost, plan limits), marked `source: session`.
- A taken-over session that sits at a dialog sends a `dialog` event with the panel's text, once per opening, after it has had 3 seconds to draw. `peek` and `take-over` carry the text as `screen` while a session is at a dialog. On by default; `clawdctl config screen off` stops the automatic reads.
- `clawdctl usage` prints the Claude plan limits as /usage shows them: each window (current session, current week, a model's week) with `percentUsed`, `resets` as shown and `resetsAt` in UTC. It uses a reading under 5 minutes old: from a session's last API response, which every session on the computer now keeps, or from the last panel read. Otherwise, or with `--fresh`, it opens /usage in a throwaway background session, reads it, and stops and removes the session. That makes no model request, so it uses none of the plan. The session starts in your home folder, which must be trusted; `--folder` or `clawdctl config usage-folder <dir>` names another.
- MCP: `read_screen` and `plan_usage`.
- The events routine prompt is now v6, with the `dialog` event.

## 0.6.4

- `clawdctl serve` listens on localhost unless `--host` names one private address, and refuses to listen on every interface. It no longer looks for a Tailscale address.

## 0.6.3

- Plans go to the bot as replies. A plan dialog answers only at the session itself or through Remote Control, never to a hook, so the bot's approval left sessions stuck at it. A session the bot holds now refuses plan mode and writes its plan as its reply, and the bot approves, revises or rejects it with a message.
- A session already in plan mode sends a `plan` event with the whole plan and its Remote Control link, where the person approves it.
- `start` no longer offers plan mode.
- The events routine prompt is now v5.

## 0.6.2

- Tried to answer plan dialogs through a PermissionRequest hook. That did not close them; 0.6.3 replaces it.
- A `ci` event names the failing checks with any `gh` version. Older `gh` releases have no `pr checks --json`, so the names now come from the PR's check rollup.

## 0.6.1

- CI wake also covers checks that had already failed when the turn ended. Each commit is reported once.
- A scheduled task on macOS runs before it removes its own launchd job. Before, removing the job first stopped the run.

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
