# Agent Tracker

A local board for keeping track of Claude Code chats across folders, plus projects you haven't started yet.

```bash
npm start
```

Then open http://localhost:47823. No dependencies or build step; needs Node 21.2 or newer.

Or use the shortcut: `~/Applications/Agent Tracker.app` runs `bin/open.sh`, which starts the server if needed and opens the board in Chrome. Its server keeps running after Chrome closes and logs to `data/server.log`. To stop it:

```bash
kill $(lsof -tiTCP:47823 -sTCP:LISTEN)
```

The app has this folder's path built in. If you move the folder, rebuild it:

```bash
bin/build-shortcut.sh
```

## What it touches

It only reads Claude Code's data and never writes to it:

- `~/.claude/projects` for transcripts and subagents
- `~/.claude/sessions` for which chats are open right now
- `~/Library/Application Support/Claude/claude-code-sessions` for desktop app titles

Your stages, notes and ideas live in `data/state.json`. Back that file up if you care about it.
`data/scan-cache.json` is disposable and rebuilds itself. Renaming a chat here only changes its name in the tracker.

It also reads the account fields from `~/.claude.json`, to put an email on the signed-in account. Nothing else from that file is read or kept.

## Usage

Each chat shows its token usage, with subagents included. The header totals whatever is on screen, and the sidebar totals each account on this Mac, whichever one is signed in now.

The **Calendar** tab shows the last 5 weeks, Monday to Sunday, in this computer's time zone. Days are colored by rank among active days, so one huge day doesn't wash out the rest. Click a day to see which chats ran. The statistics on the right cover the whole 5 weeks.

- **Tokens** means input, output and cache writes. Cache reads are listed separately in a chat's details: they're the same context reused every turn, and they run hundreds of times larger.
- **Each message counts once.** Claude Code repeats usage across transcript lines and copies history into forked chats, so totals are keyed by message id.
- **Small undercount:** background calls that never reach a transcript, such as title generation, aren't included.
- **Accounts:** older transcripts don't say which account ran them, so those appear as "Account not recorded". An account shows its email once it has been signed in while the tracker is running.
- **No dollar amounts:** Claude Code's `cost-state` totals cover a whole process, which can span several chats, so they can't be split per chat.

## How cards behave

- **New chats** land in the stage marked "new chats". Change that from any stage's `⋯` menu.
- **First run only:** chats idle for more than 7 days start in Paused, so Active isn't a wall of old work.
- **Stages are yours.** A chat never moves on its own. If you use a parked chat again, it gets a "New activity" tag instead. Hover over the tag and click its × to clear it, or move the card. It comes back if the chat is used again.
- **Moving several cards:** tick the checkbox that appears when you hover over a card, or `⌘`-click it. `Shift`-click selects a range within a stage. Drag any selected card to move them all, or use "Move to…" at the top. `Esc` clears the selection.
- **Pruned transcripts:** when Claude Code deletes an old transcript, the card stays with its last summary and a "Transcript gone" tag, but can't be resumed.

## Search

Press `/` or `⌘K`. Every word must match somewhere in a card's title, note, folder, branch or PRs, its last reply and recap, or the messages you typed. Clicking a folder narrows the results.

## Settings

Environment variables: `AGENT_TRACKER_PORT`, `AGENT_TRACKER_DATA`, `AGENT_TRACKER_CLAUDE_HOME`, `AGENT_TRACKER_DESKTOP_DIR`.

## Tests

```bash
npm test
```
