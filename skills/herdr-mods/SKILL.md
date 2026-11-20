---
name: herdr-mods
description: What the shared Herdr Desktop mods add (space groups sidebar, pinned spaces, notepads, markdown review panes, the pane right-click menu, sleeping and waking Claude sessions) and every command an agent can run to do the same things from the shell — group, colour, status, fold, pin, minimize and arrange spaces, move panes between tabs and spaces, open and comment on markdown files, edit notepads, set a pane status. Also how to start, message, read or steer another Claude session in Herdr. Also where to find mods and layouts other people share online (herdr.dev/mods, herdr.dev/layouts). Load whenever a task touches Herdr spaces, groups, pins, notepads, md-review, moving panes or sleeping and waking sessions, when asked to organize spaces or open a doc for review, when opening, messaging or steering another Claude session in Herdr, or when a session is blocked on something only the user can do (restart the computer, log in) and should flag it on its pane.
---

# Herdr mods

These mods live in `~/.config/herdr-app/mods/`. Herdr redraws from that folder while it runs. For Herdr's own commands (spaces, tabs, panes, terminals), read `herdr-app --skill` and `hc --skill` first.

## Mods and layouts other people made

When asked whether a mod or layout exists for something, search these online lists before answering. Don't stop at the installed folder:

- **herdr.dev/mods**: mods (pieces for your own window). The list is built from public GitHub repos with the topic `herdr-mod`.
- **herdr.dev/layouts**: whole layouts. The list is built from repos with the topic `herdr-layout`.

The gallery pages don't fetch well: they show cards without links or descriptions. Search GitHub instead:

```bash
gh search repos --topic herdr-mod --limit 200 --json fullName,description,url     # or --topic herdr-layout
```

To install one, follow "Layouts and mods other people made" in `~/.config/herdr-app/AGENTS.md`: read the recipe and every file first, tell the user what the mod reaches on the network, runs, or reads outside its folder, never overwrite an existing mod, and run `herdr-app check`.

| Mod | What it adds |
|---|---|
| `spaces-grouped` | The sidebar: spaces in groups (nestable, foldable, reorderable), row colours, an emoji status badge per space, a new-space dialog, per-panel zoom. One mod in roles: the sidebar, a space's right-click menu, the group dialog, the status dialog, the new-space dialog. |
| `pins` | Pinned spaces: each pinned space keeps its own column beside the normal view. Columns can be minimized to a dock bar (chips show each space's status like the sidebar: spinner while working, dot when done or blocked) and rearranged. Docking: Ctrl+Shift+D, the − button, or double-click a header's space name (pins an unpinned selected space first). |
| `notepads` | A Notepads section at the bottom of the sidebar: text notes and to-do lists, one file each. |
| `md-review` | A markdown file as a pane: rendered (Read) or raw (Edit). Click a block to comment; comments are saved in the file. Links (Obsidian `[[wikilinks]]`, the note beside the linking note first, and relative `.md` links) open in the same pane, with Back. "Select text" shows the whole file as one selectable text for copying across paragraphs; right-click has "Copy this block" and "Copy whole document". |
| `pane-status` | Each pane's header bar (a copy of Herdr's `pane` mod). When the pane's terminal has a status, the header turns into a coloured bar showing it in bold, e.g. "Restart computer" in red. |
| `pane-menu` | The right-click menu on a pane: Herdr's items plus "Move to new tab", "Move into tab…", "Move to new space…", "Open from screen…" (lists the file paths shown in a terminal and opens one), and "Sleep session" / "Wake session" for Claude. |

## Rules for agents

- **Mod commands only reach mods on screen.** `herdr-app do '<mod>.<verb>:<json>'` delivers to that mod only while it's shown: the sidebar for `spaces-grouped`, a layout with the `pins-engine` block for `pins`. `herdr-app do` answers `{"ok": true}` either way, so check the result in `~/.config/herdr-app/shared.json`.
- **Errors show as a notification** in the window, not in the command's output.
- **Never write `shared.json` yourself.** Herdr owns it while it runs; change it only through commands. Reading it is fine.
- **Open things in your own space, not the selected one.** The user switches spaces while sessions work. Look up your space from `$HC_TERMINAL_ID` and pass `--space` (or `--pane`):

```bash
SPACE=$(herdr-app ls | python3 -c "
import json,sys,os
me='\"'+os.environ['HC_TERMINAL_ID']+'\"'
for s in json.load(sys.stdin)['spaces']:
  if me in json.dumps(s): print(s['id'])")
PANE=$(herdr-app ls | grep -A1 "\"$HC_TERMINAL_ID\"" | sed -n 's/.*"pane": "\(.*\)".*/\1/p')
```

- Spaces and groups can be named by id or by name in every command. Space ids come from `herdr-app ls`.

A new Claude session in a new tab of your own space:

```bash
herdr-app do tab.new --space "$SPACE" --name "<name>" --argv '["claude","--name","<name>"]' --task "<seed message>"
```

Opening a tab selects it, which takes the user's view and keyboard away from what they're doing; if a local note offers a background variant, prefer it.

## Steering other Claude sessions

When finding which space or tab you're in, to avoid reporting the wrong one, look up `$HC_TERMINAL_ID` in `herdr-app ls`; `herdr-app status` gives the window's focused pane, not yours.

When sending a message to another Claude session, to get replies back by name, use the `SendMessage` tool with the session's name from `ListAgents`. Keep `hc` for typing into a terminal or reading its screen; read `hc --skill` before using it.

Before messaging a session, check that Claude is actually running in its terminal: a session can be asleep (the pane menu's "Sleep session" exits Claude and leaves the pane at its shell), and then a message goes nowhere, or `hc send` types it into the shell. `hc get <terminal> --json` has `"status": {"app": "claude-code", ...}` only while Claude runs; a sleeping one has `status: null` and a non-empty `sleep.session` label (set by the pane menu's Sleep and by an auto-sleep). When it's asleep, tell the user instead of sending, or wake it first if they asked you to (see "Waking a session from any machine" below) and wait until `status.app` is `claude-code` and its state is `idle`.

```bash
hc read <terminal> --lines 0      # its visible screen
hc send <terminal> "<msg>"        # arrives as an ordinary prompt; say who sent it and how to reply
hc wait <terminal>                # until it stops working
```

When another session should run a slash command (e.g. `/rename style`), to avoid it arriving as plain text, don't send it with `hc send` or `SendMessage`: `hc send` wraps every message in `<hc from="t1d">…</hc>`, so Claude reads it as a prompt and the command never runs. Type it key by key with `hc keys`, which adds no tag:

```bash
hc keys <terminal> / r e n a m e space s t y l e enter
```

## Sidebar commands (`spaces-grouped`)

```bash
herdr-app do 'spaces-grouped.<verb>:<json>'
```

| Verb | JSON | Does |
|---|---|---|
| `space-group` | `{space, group, parent?}` | Puts a space in a group, making the group (inside `parent`) if missing. `group: null` takes it out of its group. |
| `group-new` | `{name, parent?, machine?}` | Makes a group, nested in `parent` if given. Nothing if it exists. |
| `group-rename` | `{group, name}` | |
| `group-delete` | `{group}` | Its spaces and child groups move up to its parent. |
| `group-move` | `{group, parent?, before?, after?}` | `parent`: nest it there (`null`: top level; left out: unchanged). `before`/`after`: a group to sit next to. |
| `group-fold` | `{group, folded}` | `true` folds, `false` unfolds. |
| `group-color` | `{group, color}` | `null`: no colour. |
| `space-color` | `{space, color}` | `"dim"`: no colour even in a coloured group; `null`: same as its group. |
| `space-status` | `{space, text}` | The badge left of the name, usually one emoji; `""` clears it. |
| `pane-move` | `{terminal \| pane, to, space?, tab?, name?, group?}` | Moves a pane: `to: "new-tab"` (in `space`, default its own), `"tab"` (beside the panes of `tab`), `"new-space"` (named `name`, in group `group`). Works for terminals and mod panes such as md-review. |
| `new-space` | (no JSON: `spaces-grouped.new-space`) | Opens the new-space dialog for the user. To make a space yourself, use `herdr-app do space.new`. |

Colours: `ansi6` teal, `ansi4` blue, `ansi5` purple, `ansi1` pink, `ansi3` orange, `ansi2` green, `#d9b54a` yellow, `#d9534f` red, `#8a8f98` grey, or any `#rrggbb`. Prefix `inv:` (e.g. `inv:ansi4`) for a row filled with the full colour and black text.

`pane-move` has to show the target space for a moment, because Herdr only places panes in the shown space; it then goes back to the space that was shown.

Examples:

```bash
herdr-app do 'spaces-grouped.space-group:{"space":"bug-42","group":"today","parent":"bugs"}'
herdr-app do 'spaces-grouped.group-move:{"group":"bugs","before":"work"}'
herdr-app do 'spaces-grouped.space-status:{"space":"bug-42","text":"🐛"}'
herdr-app do 'spaces-grouped.pane-move:{"terminal":"t5f","to":"new-space","name":"spike","group":"work"}'
```

Reading state, in `~/.config/herdr-app/shared.json`:

| Key | Shape |
|---|---|
| `space.groups` | `{ list: [{ id, name, machine, parent? }], of: { spaceId: groupId } }`; `list` order is the sidebar's order |
| `space.color` | `{ spaceId: color }` |
| `group.colors` | `{ groupId: color }` |
| `space.status` | `{ spaceId: text }` |

Fold state isn't in `shared.json`; it's kept by the sidebar itself.

## Pin commands (`pins`)

Only in a layout that contains the `pins` mod's `pins-engine` block.

| Verb | JSON | Does |
|---|---|---|
| `pin` | `{space, pinned}` | Pins a space (`pinned: false` unpins). |
| `minimize` | `{space, minimized}` | Shrinks a pinned space's column to a chip in the dock bar, or restores it. |
| `place` | `{space, beside, side}` | Moves a pinned space's column next to another pinned space or `"main"` (the normal view). `side`: `left`, `right`, `top`, `bottom`, or `swap`. |

```bash
herdr-app do 'pins.pin:{"space":"bugs"}'
herdr-app do 'pins.place:{"space":"bugs","beside":"main","side":"left"}'
```

With `settings.json` `"pin_spaces": true` (Mod settings, Ctrl+Shift+S: "Always pin spaces"), a space that gets selected (opened from the sidebar, or new) is pinned at once and the normal view goes back to the space shown before; spaces that only appear because their machine connected aren't pinned.

`pins.key-dock` (no JSON; bound to Ctrl+Shift+D) docks the space holding the focused pane: pins it if needed, minimizes it, and selects the next pinned space still showing. `pins.key-toggle-active` (Ctrl+Shift+P) swaps that space between the normal view and its own column: the selected space gets pinned and the normal view goes back to a pinned space (or the space selected before), while a pinned column's space is unpinned and selected; the keyboard stays on the moved space. `pins.key-hide` (Ctrl+Shift+M) takes that space off screen: unpins it, and if it's selected, selects a pinned space (or the one selected before). A newly pinned or restored space goes to the right of the other pinned spaces, just before the normal view. All three act on whatever the user has focused, so use `pin` + `minimize` from scripts instead.

State in `shared.json`: `pins.spaces` (pinned ids, in order), `pins.minimized`, `pins.arrange` (a tree of `{type: "row" | "column", children}` whose leaves are space ids and `"main"`).

## Notepads

Each notepad is a file in the notepads folder (`settings.json` key `"notepads_folder"`, default `~/notepads`). Edit the files directly; the panel picks up changes on its own.

- `<name>.txt`: plain text.
- `<name>.md`: a to-do list, one item per `- [ ] text` or `- [x] text` line. Other lines are kept but not shown.

`herdr-app do notepads.toggle` opens or folds the section.

## Markdown review (`md-review`)

Open a file in a pane beside your own:

```bash
herdr-app do pane.split --direction right --pane "$PANE" --mod md-review --props '{"file":"/abs/path/doc.md"}'
```

Comments are saved in the file, on the line under the block they're about (indented under a list item), as:

```markdown
<!-- Author: the comment text -->
```

The author is `settings.json`'s `"md_review_author"`, default `Comment`. When reading a file someone reviewed in this pane, treat those lines as their comments. To answer one, edit the file. The pane re-reads the file every 2 seconds, but doesn't always show changes made on disk: after editing a file that's open, close the pane (`herdr-app do pane.close --pane <id>`) and open it again.

`herdr-app ls` lists only terminal panes, and a mod's `panes()` lists md-review panes without their file. To find which files are open and their pane ids, read `~/.local/state/herdr-core/default/docs.json`: each pane is a node whose `content.mod` is `md-review` and `content.props.file` is the file.

## Pane status (`pane-status`)

Each pane's header can show a one-line status as a coloured bar. CLAUDE.md says when to set it; the command:

```bash
hc label "$HC_TERMINAL_ID" "status=Building: parser fix" "status.color=blue" >/dev/null   # show it
hc label "$HC_TERMINAL_ID" "status=" "status.color=" >/dev/null                               # clear it
```

Colours: `blue` working, `yellow` waiting for the user's answer, `red` blocked on something only the user can do, `green` done. Any other name shows as red. Long text is cut off at the header's width. The user can also set the text and colour from the pane's right-click menu ("Set status…", "Clear status") or clear it with the × on the bar. The header has no timer: it redraws only when a terminal's labels change. A `UserPromptSubmit` hook in `~/.claude/settings.json` clears a Claude session's status each time the user sends it a message, so an old status never outlives the turn it was set in.

## Pane menu (`pane-menu`)

A layout picks it with `"terminal_menu": "pane-menu"` at its root. Its move items are the same moves as the sidebar's `pane-move` command; use that command from scripts. "Open from screen…" is mouse-only: an agent can open the file itself.

"Sleep session" (on a pane running Claude) types `/exit`, so the pane goes back to its shell, and labels the terminal `sleep.session=<id>` (the id Claude prints) and `sleep.cwd=<folder>`. "Wake session" (shown while `sleep.session` is non-empty and Claude isn't running) types `cd <folder>` and `claude --resume <id>` there, then sets both labels to empty. Another machine's own auto-sleep can use the same labels, so either side wakes what the other put to sleep. Both work for terminals on other machines (`pi/t7`).

A SessionStart hook (`claude/settings-hook.json` in the repo, installed on each machine that runs Claude in Herdr) also labels each terminal `claude.session=<id>` and `claude.cwd=<folder>` whenever Claude starts there. Wake falls back to these when `sleep.session` is empty, so a pane whose Claude was killed without sleeping (a reboot, a crash) still shows "Wake session" and resumes its last session. Waking leaves them as they are. From a script:

```bash
python3 ~/.config/herdr-app/mods/pane-menu/session.py sleep <terminal>   # or wake, or toggle
```

That script is only on the computer that shows the Herdr window (where the mods are installed). On a remote machine, such as a server whose terminals the window shows, it doesn't exist.

### Waking a session from any machine

Use the first of these that works where you are:

1. A local wake command, if this machine has one.
2. `python3 ~/.config/herdr-app/mods/pane-menu/session.py wake <terminal>`, if the mods are installed here.
3. By hand, which works anywhere `hc` reaches the terminal. Read the id from the terminal's `sleep.session` label (or `claude.session` if that's empty), type the resume command, then clear the sleep labels:

```bash
cmd="claude --resume <id>"
hc keys <terminal> ctrl+c
hc keys <terminal> $(python3 -c 'import sys;print(" ".join("space" if c==" " else c for c in sys.argv[1]))' "$cmd") enter
hc label <terminal> "sleep.session=" "sleep.cwd=" >/dev/null
```

Type it with `hc keys`, not `hc send`: `hc send` wraps the text in an `<hc from=...>` tag, which the shell rejects. The pane's shell is already in the session's folder (`sleep.cwd`); if it isn't, type `cd <folder>` the same way first. Then wait until `hc get <terminal> --json` shows `status.app` `claude-code` and state `idle`.

It logs to `~/.local/state/herdr-sessions/session.log`.

Ctrl+Shift+R (the `session-keys` mod, a 0 px block in the layout) does the same for the focused pane: puts it to sleep when Claude runs there, else wakes it.

A cron job runs `~/.config/herdr-app/mods/pane-menu/auto-sleep.py` every 10 minutes: it sleeps each Claude session on this machine whose Herdr status has been idle or done for an hour, never working or blocked ones. `--report` lists every session grouped as already sleeping, newly slept and still awake, with minutes since each last changed; `--dry-run` does the same without sleeping anything.

## Grouping from another machine

Groups live in the Herdr app on the computer showing the window, so `herdr-app do` doesn't reach them from another machine. There, an agent labels its own terminal instead:

```bash
hc label "$HC_TERMINAL_ID" group="meta tasks"   # put this space in that group (made if missing)
hc label "$HC_TERMINAL_ID" group=-              # take it out of its group
```

The sidebar picks the label up within a second, moves the space and removes the label.

Each remote machine's groups and colours are kept in `~/.local/state/herdr-groups/groups.json` on that machine, so every computer whose Herdr shows it (e.g. a Mac and a Windows PC both showing a server) sees the same groups. The sidebar reads the file on connecting (the file wins; an empty file is filled from this computer), writes it when you change a group or colour, and rereads it every 3 seconds. Each group has `id`, `name`, `parent`, `color`; each space (by its id on that machine) has `name`, `group`, `color`. Don't edit the file by hand while a group or colour change is in flight on some computer: the last write wins.

## Two windows

A second Herdr window has its own app home (e.g. `~/.config/herdr-app-pi`, with `mods` a symlink to the main home's) and can set `HERDR_APP_ID` for its own taskbar button. Commands reach the main window unless `HERDR_APP_HOME` names the other home, e.g. `HERDR_APP_HOME=~/.config/herdr-app-pi herdr-app status`. The sidebar filter is settings.json `"sidebar_machine"` in each home.

## Settings (`~/.config/herdr-app/settings.json`)

Herdr's `settings()` leaves custom keys out, so each mod reads the file itself.

| Key | Used by | Default |
|---|---|---|
| `new_space_folders` | sidebar's new-space dialog: `{ machineName: folder }`, `""` is this computer | the machine's home |
| `notepads_folder` | notepads | `~/notepads` |
| `sidebar_machine` | spaces-grouped, pins: this window shows only that computer's spaces ("this computer", or a machine name) | every computer |
| `pin_spaces` | pins: a space you open is pinned at once | off |
| `md_review_author` | md-review comment author | `Comment` |
