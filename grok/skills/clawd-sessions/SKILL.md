---
name: clawd-sessions
description: >-
  Drive Claude Code sessions on the user's computers with Clawd: list them,
  start one, take one over or hand it back, send a message, interrupt, change
  model, effort or mode, set progress reports, read what it said, stop it. Use
  for "what's running", "start Claude on…", "take over…", "tell it to…",
  "switch to sonnet", "babysit it", "give it back", "what did it say",
  "what's on its screen", "close that dialog", "how much usage is left",
  "what are its subagents doing", "tell the codex agent…", "pause that
  subagent", "stop the subagent".
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
- "Give it back", "release X": `release '<X>'`. Anything it was waiting on reappears on the computer's screen. Model, effort and permission mode you set stay in force (`kept` lists them): say so in the same line, and offer to set them back to `default` if the user wants the session's own.
- "Babysit X" / "you handle X": `mode '<X>' babysit|handle`.
- The user can also type `/clawd on`, `/clawd off`, `/clawd babysit` or `/clawd handle` in the session itself.

## Steer
Steering needs the session taken over; clawdctl refuses otherwise, so offer to take it over.
- Message: `send '<X>' '<text>'`. Pass the user's words. If you add context, keep it short and concrete. It arrives within seconds, as its next prompt or alongside the current turn.
- Interrupt: `interrupt '<X>'`. The interrupted turn arrives as an event.
- Model or effort: `model '<X>' <m>`, `effort '<X>' <level>`; `default` undoes it. They apply from the next request and stay after you release the session, until you set `default`, which works on a released session too. A new value needs the session taken over.
- Permission mode: `permissions '<X>' acceptEdits` lets it edit files inside its folder without asking; `dontAsk` denies anything not already allowed, without asking; `bypass` allows everything it would ask about, with no prompt; `default` goes back to asking. Set `bypass` only when the user asks for it in so many words, and say it stays after release. The user's deny rules and the computer's safety floors still refuse under it; when a floor refuses, tell the user to answer it on their device. Each mode stays after you release the session, until you set `default` (which works on a released session) or the user types `/clawd clear` there. A released session's `keptByBot` in `sessions` shows what is still in force. Plan and auto modes are set at the computer, not from here.

## Remote Control
A terminal session gets Remote Control when it is taken over, and the link arrives as a `remote` event. Sessions started here have it already. For another one: `remote '<X>'`. The link opens the session on the phone, the web or the Claude app.

## Budget
Off unless the user turns it on. Only when the user asks for a budget on a session: `budget '<X>' <usd>` caps what it may spend, with a `budget` event at 80%, and at 100% the turn stops before its next request. Never set, suggest or raise one on your own. `sessions` and finished turns show `costUsd` either way; `budget '<X>' off` removes the cap.

## AskGrok
Only when the user asks for it: `grok '<X>' on` lets that session ask you for help (6 requests an hour by default, `--per-hour n` to change). The user can also type `/clawd grok on` in the session. `grok '<X>' off` stops it.

## Later
"Run this tonight", "at 9 tomorrow": `schedule --at '<time>' --folder '<dir>' --prompt '<task>' --name '<n>' --model <m> --effort <e>` (add `--mode babysit` if asked). At is `21:30` (the next one), `+90m`, `+2h`, or `2026-11-16T09:00`, in the computer's time zone. A background session starts then, taken over by you, and a `scheduled` event brings its name and Remote Control link. `schedules` lists them, `unschedule <id>` cancels. Pending tasks survive a reboot. One whose time passed while the computer was off runs when it is back: on Linux at boot with lingering on, otherwise at the user's next login; on a Mac at wake.

## Watch
- "What did it say / what is it doing": `peek '<X>' --count 6` and summarise its last messages in two or three lines. Each message holds up to 8,000 characters; one marked `truncated` is longer still. If its last reply puts a decision to the user, follow clawd-event, "Decisions in a reply".
- Progress reports: `report '<X>' <minutes>` (or `off`). Each report arrives as an event.

## A dialog on its screen
A session whose status is `waiting: dialog open` sits at a panel such as /usage, /cost, /status or the model picker, which holds its keys. `peek` and `take-over` then carry its text as `screen`; a session you hold also sends a `dialog` event.
- "What's on its screen": `screen '<X>'`. Sum up `text` in two or three lines. `source: session` means its terminal could not be read and the text is the session's own account (model, context, cost, plan limits), not its screen: say so. `text: null` comes with a `note` that says why.
- "Close it": `screen '<X>' --dismiss`. It sends Escape only while a dialog is open, and `dismissed` says whether it closed. A picker or question that needs a choice may stay open: then it needs the user at the computer, or Remote Control.

## Plan usage
"How much usage is left", "when does my limit reset": `usage` on that computer. Report each of `limits` in one line: `label`, `percentUsed`, and `resetsAt` in the user's time zone. A reading under 5 minutes old is used as it is; `--fresh` reads /usage again in a throwaway session that makes no model request, about 10 seconds. A "not trusted" refusal names the fix: relay it. The limits are the account's, so one computer is enough.

## Subagents
A session's subagents are the Claude subagents (Agent tool) and Codex agents it started. Clawd sees them through Overseer. Without it, `subagents` refuses with the install commands: relay them, and offer to run them only after the user's yes (clawd-setup). If Overseer is installed but turned off, or not running in that session, the refusal says so and names the fix: relay it.
- "What are its subagents doing": `subagents '<X>'`. One line each: `name`, `kind`, `model`, `status`, `steps`, and `activity` for a running one. `pausedByBot`, `next` (a model or effort you set) and `stopping` show your own steering. A `note` says why the list is empty or stale.
- "What did it say": `subagent '<X>' '<id or name>' --count 6`. Sum up its last entries; `prompt` is the task its parent gave it.
- Steering needs the session taken over, as for the session itself. Name the subagent by id, the start of its id, or its name.
  - Message: `subagent '<X>' '<id>' send '<text>'`. Pass the user's words. A running one gets it with its next request (Codex: in its current turn); a finished one wakes under the same id with its history. Its answer arrives as a `subagent` event.
  - Model or effort: `subagent '<X>' '<id>' model <m>` or `effort <level>`. For a running Codex turn, the `note` says how it went: switched in place, or the turn stopped and continued on the new model (`via` ends in `turn/interrupt`), or unconfirmed. Relay that in one line; never say a change took effect when the note says it is unconfirmed.
  - Pause and resume: `subagent '<X>' '<id>' pause`, then `resume`. Claude subagents only, because Codex has no pause: offer Stop instead. A paused one waits until you resume, stop or release the session.
  - Stop: `subagent '<X>' '<id>' stop`. A Claude subagent ends at its next request; a Codex agent's running turn stops. A message continues either later.
- clawdctl prints `done` with a `note` on what happened, or `queued` when the session didn't answer within seconds: say it will apply when the session next checks. A refusal is one sentence: relay it.

## Stop
`stop '<X>'` ends a background session; it can be resumed later with the `resume` command it prints. An interactive session can't be stopped from here: interrupt it and hand it back.
