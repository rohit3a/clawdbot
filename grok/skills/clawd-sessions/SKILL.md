---
name: clawd-sessions
description: >-
  Drive Claude Code sessions on the user's computers with Clawd: list them,
  start one, take one over or hand it back, send a message, interrupt, change
  model, effort or mode, set progress reports, read what it said, stop it. Use
  for "what's running", "start Claude on…", "take over…", "tell it to…",
  "switch to sonnet", "babysit it", "give it back", "what did it say".
---
Follow clawd-rules first.

## What's running
On each online computer (or the one named): `~/.local/bin/clawdctl sessions`. Report per computer, one line per session: name, folder, status (working, idle, waiting on a question or permission), taken over and mode. `--all` adds finished background sessions. Keep it short; offer `peek` for detail.

## Start a session
1. Computer: the one the user names, else ask when several are online.
2. Folder: the user's words. If unclear, ask. A folder Claude has never been trusted in fails with a trust message: tell the user to open Claude there once and accept the prompt.
3. Model and effort: the user's words, else their saved defaults, else `sonnet` and `medium`. Opus at high effort costs far more for small jobs; mention that if they ask for it on a small task.
4. `~/.local/bin/clawdctl start --folder '<dir>' --prompt '<their task, in their words>' --name '<short-name>' --model <m> --effort <e>`, plus `--mode babysit` if they asked.
5. Reply with: computer, name, the `remoteUrl` (opens the session on the phone, web or Claude app), and `attach` / `resume` for the computer itself. The session is taken over from its first prompt, so its questions come here.

## Take over, hand back, mode
- "Take over X": `take-over '<X>'` (add `--mode babysit` if they say). Confirm in one line: from now on its questions and permission prompts come here, and the screen shows only a status line.
- "Give it back", "release X": `release '<X>'`. Anything it was waiting on reappears on the computer's screen.
- "Babysit X" / "you handle X": `mode '<X>' babysit|handle`.
- The user can also type `/clawd on`, `/clawd off`, `/clawd babysit` or `/clawd handle` in the session itself.

## Steer
Steering needs the session taken over; clawdctl refuses otherwise, so offer to take it over.
- Message: `send '<X>' '<text>'`. Pass the user's words. If you add context, keep it short and concrete. It arrives within seconds, as its next prompt or alongside the current turn.
- Interrupt: `interrupt '<X>'`. The interrupted turn arrives as an event.
- Model or effort: `model '<X>' <m>`, `effort '<X>' <level>`; `default` undoes it. They apply from the next request while you have the session; released, it goes back to its own.
- Permission mode: `permissions '<X>' acceptEdits` lets it edit files inside its folder without asking; `dontAsk` denies anything not already allowed, without asking; `default` goes back to asking. It lasts while you have the session. Plan, auto and bypass modes are set at the computer, not from here.

## Remote Control
A terminal session gets Remote Control when it is taken over, and the link arrives as a `remote` event. Sessions started here have it already. For another one: `remote '<X>'`. The link opens the session on the phone, the web or the Claude app.

## Budget
`budget '<X>' <usd>` caps what a taken-over session may spend: a `budget` event at 80%, and at 100% the turn stops before its next request. Suggest one for long or unattended work. `sessions` shows `costUsd`; `budget '<X>' off` removes it.

## AskGrok
Only when the user asks for it: `grok '<X>' on` lets that session ask you for help (6 requests an hour by default, `--per-hour n` to change). The user can also type `/clawd grok on` in the session. `grok '<X>' off` stops it.

## Later
"Run this tonight", "at 9 tomorrow": `schedule --at '<time>' --folder '<dir>' --prompt '<task>' --name '<n>' --model <m> --effort <e>` (add `--mode babysit` if asked). At is `21:30` (the next one), `+90m`, `+2h`, or `2026-11-16T09:00`, in the computer's time zone. A background session starts then, taken over by you, and a `scheduled` event brings its name and Remote Control link. `schedules` lists them, `unschedule <id>` cancels. On Linux a reboot clears pending tasks.

## Watch
- "What did it say / what is it doing": `peek '<X>' --count 6` and summarise its last messages in two or three lines. Each message holds up to 8,000 characters; one marked `truncated` is longer still. If its last reply puts a decision to the user, follow clawd-event, "Decisions in a reply".
- Progress reports: `report '<X>' <minutes>` (or `off`). Each report arrives as an event.

## Stop
`stop '<X>'` ends a background session; it can be resumed later with the `resume` command it prints. An interactive session can't be stopped from here: interrupt it and hand it back.
