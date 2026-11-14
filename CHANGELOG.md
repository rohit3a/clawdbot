# Changelog

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
