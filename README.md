
# Herdr Mods

Mods for Herdr Desktop, plus a Claude Code skill that lets Claude agents drive everything they add from the command line.

| Mod | What you get |
|---|---|
| `spaces-grouped` | A sidebar with space groups (nestable, foldable, drag to reorder), row colours, an emoji status per space, a new-space dialog (Ctrl+Shift+N) that starts a terminal or Claude. |
| `zoom` | Ctrl+plus/minus/0 zoom the panel under the mouse (the sidebar, an md-review pane), else every terminal's font size. An invisible block in the status bar, so the keys work even with the sidebar hidden. |
| `pins` | Pin spaces so each keeps its own column beside the one you're in. Columns can be shrunk to a dock bar (Ctrl+Shift+D, or double-click a space's name) whose chips show if an agent there is working or waiting, and rearranged by dragging. Ctrl+Shift+P moves a space between the main view and its own column; Ctrl+Shift+M takes it off screen. Needs the `grouped-pins` layout. |
| `notepads` | Notes and to-do lists at the bottom of the sidebar. Each one is a plain file in `~/notepads`, so Claude can read and edit them. |
| `md-review` | Opens a markdown file as a pane. Click a block to leave a comment; comments are saved in the file as `<!-- Author: ... -->` for Claude to read. |
| `system` | CPU, memory and GPU load in the status bar, with a small live graph for each. When Herdr runs in WSL it shows all of Windows (a PowerShell script samples Windows' performance counters); on a Mac it reads `iostat`, `vm_stat`, `sysctl` and `ioreg`. Click RAM for the programs using the most memory, as a share of all memory and in GB; click elsewhere on it to open Task Manager or Activity Monitor. |
| `pane-status` | Each pane's header bar, under the terminal. A pane can show a one-line coloured status ("Building: parser fix" in blue, "Restart computer" in red): agents set it with `hc label "$HC_TERMINAL_ID" "status=..." "status.color=blue"`, you set it from the pane's right-click menu. |
| `session-keys` | Ctrl+Shift+R wakes the focused pane's sleeping Claude session, or puts it to sleep when Claude runs there. An invisible block in the layout, so the key works anywhere. |
| `mod-settings` | A settings dialog (Ctrl+Shift+S) for the mods' own settings, which Herdr's Settings screen doesn't show: the new-space folder per machine, the notepads folder, the sidebar's machine filter, and "Always pin spaces" (a space you open or make is pinned at once). |
| `pane-menu` | The right-click menu on a pane gains "Move to new tab", "Move into tab…", "Move to new space…" and "Open from screen…" (lists the file paths shown in a terminal and opens one), "Set status…", and "Sleep session" / "Wake session" for Claude. `auto-sleep.py` beside it puts Claude sessions to sleep after an hour idle (see Install). |

`spaces-grouped` and `pins` work together: pinning is done from the sidebar. The others work on their own.

Also install [herdr-recall](https://github.com/shihyuho/herdr-recall) (not in this repo): a fuzzy, most-recent-first switcher for spaces, tabs, panes and agents. `keys-snippet.json` binds it to Cmd+E.

For Claude and Codex usage limits next to `system`, install [herdr-quota](https://github.com/Lakris2407/herdr-quota)'s `quota` mod (not in this repo) and `quota-axi` (`npm install -g quota-axi`).

## Install

1. Close Herdr Desktop. Your terminals and Claude sessions keep running. (Herdr docks any new mod folder it sees while open as a panel.)
2. Copy each folder in `mods/` into `~/.config/herdr-app/mods/`. (If you set `HERDR_APP_HOME`, use that folder instead of `~/.config/herdr-app` here and below.)
3. Copy `layouts/grouped.json` and `layouts/grouped-pins.json` into `~/.config/herdr-app/layouts/`. They are copies of Herdr's `main` layout with the grouped sidebar, the notepads section and the pane menu; `grouped-pins` adds pinned spaces.
4. Optional: add the key bindings in `keys-snippet.json` to `~/.config/herdr-app/keys.json`.
5. Copy `skills/herdr-mods/` into `~/.claude/skills/`, so Claude knows the mods and their commands.
6. Install herdr-recall: copy `mods/recall/` from github.com/shihyuho/herdr-recall into `~/.config/herdr-app/mods/` (a copy, not a symlink), run `herdr-app check ~/.config/herdr-app/mods/recall`, then press Cmd+E once to start it.
7. Optional, for `system` (and `quota`): in your layout, replace the status block (`"mod": "workspace-status"`) with a row:

   ```json
   { "id": "status", "type": "row", "size": { "px": 28 }, "resizable": false, "children": [
     { "id": "status-main", "type": "block", "content": { "mod": "workspace-status" }, "size": { "weight": 1 } },
     { "id": "status-system", "type": "block", "content": { "mod": "system" }, "size": { "weight": 3.3 }, "min": 120 },
     { "id": "status-quota", "type": "block", "content": { "mod": "quota" }, "size": { "weight": 3.6 }, "min": 130 }
   ] }
   ```

8. Optional, to put idle Claude sessions to sleep after an hour: add a cron job, `(crontab -l; echo "*/10 * * * * /usr/bin/python3 $HOME/.config/herdr-app/mods/pane-menu/auto-sleep.py") | crontab -`. A sleeping pane's right-click menu has "Wake session".
9. Optional, so Claude sessions keep their pane status current on their own: add `claude/CLAUDE-pane-status.md` to `~/.claude/CLAUDE.md` (it tells each session to set its status when it starts work and at the end of every reply), and merge `claude/settings-hook.json` into `~/.claude/settings.json` under `hooks.UserPromptSubmit` (it clears the status each time you send a message, so an old one never lingers).
10. Optional, so "Wake session" survives a reboot or crash: merge the `hooks.SessionStart` entry of `claude/settings-hook.json` into `~/.claude/settings.json` on every machine that runs Claude in Herdr. It labels each terminal with the Claude session started in it (`claude.session`, `claude.cwd`), so a pane whose Claude was killed without sleeping still offers "Wake session".
11. Open Herdr and pick the `grouped` or `grouped-pins` layout in Settings.

Optional settings in `~/.config/herdr-app/settings.json`:

```json
{
  "md_review_author": "YourName",
  "notepads_folder": "~/notepads",
  "new_space_folders": { "": "/path/new/spaces/start/in" }
}
```

## Using them from Claude

Every mouse action the mods add has a command, for example:

```bash
herdr-app do 'spaces-grouped.space-group:{"space":"my-space","group":"today","parent":"bugs"}'
herdr-app do 'pins.pin:{"space":"my-space"}'
```

The `herdr-mods` skill lists every command, the state each mod keeps, and how to open, message and steer other Claude sessions in Herdr.

## Credits

`system` is Lakris2407's system-load mod from herdr-quota (MIT, licence in `mods/system/`) with Windows support added. "Open from screen…" in `pane-menu` is based on Lakris2407's Path menu mod (github.com/Lakris2407/herdr-path-menu, Apache-2.0). The sidebar font is iA Writer Mono (licence in `mods/spaces-grouped/fonts/`). `spaces-grouped`, `pane-menu` and the menu role in `spaces-grouped` started as copies of Herdr's own `spaces` and `menu` mods.

## Licence

Apache-2.0, the same licence as Herdr. See `LICENSE`.

## A second window per context (e.g. work and a server)

Herdr runs one window per app home. To keep two contexts apart, start a second window with its own home, e.g. `HERDR_APP_HOME=~/.config/herdr-app-pi herdr-app`, whose `mods` is a symlink to the main home's `mods` (layouts, keys and settings are its own copies). Set each window's "Only show spaces from" in Mod settings (Ctrl+Shift+S), e.g. "this computer" in one and "pi" in the other: the sidebar then lists only that computer's spaces, and "Always pin spaces" pins only those. Pins and groups are per window; a remote machine's groups are still shared through its `groups.json`.
