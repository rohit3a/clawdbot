# Changelog

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
