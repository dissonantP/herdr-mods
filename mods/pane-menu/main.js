// A copy of Herdr's `menu` mod, used for terminal right-clicks (the layout's
// "terminal_menu"). Adds "Move to new tab" and "Move into tab…" (space, then tab) to the pane menu:
// Herdr can't drag a pane between tabs, but parking a terminal (terminal.park: pane
// gone, program still running) and giving it a pane again (terminal.keep) moves it.
// "Open from screen…" opens a level listing the files and folders on the clicked terminal's
// screen (from Lakris2407's Path menu mod, see paths.js): a .md file opens in md-review in a
// new tab, anything else in the system's app for it (see openPath). The list fills in once the
// scan finishes, so it lives in its own level and the first menu never changes under the pointer.
// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, notify, theme, keys, terminals, spaces, panes, exec, shared, setShared, window, home, appHome, readTextFile } from "herdr";
import { pathsOnScreen } from "./paths.js";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

// A space's checkout: "main" (a repo's own), "linked" (a worktree), or null.
async function checkout(folder, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on });
  const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder, on });
  if (top.code !== 0 || common.code !== 0) return null;
  return common.stdout.trim() === `${top.stdout.trim()}/.git` ? "main" : "linked";
}

// The machine a terminal or pane lives on: "wsl/t11" -> "wsl", "t3" -> null (this computer).
const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);

// Where the pane can move: every space on its machine, with its tabs other than the pane's own,
// and whether a new tab there is a move (not in its own space when it's already alone in its tab).
function moveTargets(tg) {
  const from = panes().find((x) => x.pane === tg.pane || (tg.terminal && x.terminal === tg.terminal))?.tab;
  const alone = panes().filter((x) => x.tab === from).length <= 1;
  return spaces()
    .filter((s) => (s.machine ?? null) === machineOf(tg.terminal ?? tg.pane))
    .map((s) => {
      const own = (s.tabs ?? []).some((c) => c.id === from);
      return { space: s, tabs: (s.tabs ?? []).filter((c) => c.id !== from), newTab: !own || !alone };
    })
    .filter((x) => x.tabs.length || x.newTab);
}

// "Move into tab…" opens a level inside this same menu (a second popup never showed):
// sub "spaces" lists spaces, a space id lists its tabs. Every space opens its tab list, even with
// one tab: a row that moved straight there read as the space, and a new tab looked missing.
// A group's name with the groups it sits inside (shared "space.groups" `parent`): "Work › Bugs".
function pathOf(list, g) {
  const names = [];
  for (let x = g, n = 0; x && n <= list.length; x = list.find((y) => y.id === x.parent), n++) names.unshift(x.name);
  return names.join(" \u203a ");
}
function moveMenu(tg, sub) {
  const back = ["Back", "move.back", {}];
  // "Move to new space…" picks the new space's group: none, one of the groups on the
  // pane's machine (shared "space.groups", drawn by spaces-grouped), or a new one.
  if (sub === "newspace") {
    const machine = machineOf(tg.terminal);
    const list = (shared("space.groups")?.list ?? []).filter((g) => (g.machine ?? null) === machine);
    return [back, ["No group", "move.newspace", { ...tg, group: null }],
      // A group inside another shows as "Parent › Group".
      ...list.map((g) => [pathOf(list, g), "move.newspace", { ...tg, group: g.id }]),
      ["New group…", "move.newspace", { ...tg, group: "new" }]];
  }
  const targets = moveTargets(tg);
  if (sub === "spaces")
    return [back, ...targets.map(({ space }) => [`${space.name}  ›`, "move.space", { space: space.id }])];
  const one = targets.find((x) => x.space.id === sub);
  return [back, ...(one?.newTab ? [["New tab", "move.newtab", { ...tg, space: one.space.id }]] : []),
    ...(one?.tabs ?? []).map((c) => [`${c.name}`, "move.into", { ...tg, tab: c.id }])];
}

function items(p, git, sub, paths, asleep) {
  p = p ?? {};
  const tg = p.target ?? {};
  if (p.tab === "pane" && sub === "paths")
    return [["Back", "move.back", {}], ...(paths ?? []).map((f) => [f.path.split("/").pop() + (f.dir ? "/" : ""), "open", f])];
  if (p.tab === "pane" && sub) return moveMenu(tg.mod ? tg : { terminal: tg.terminal, pane: tg.pane }, sub);
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      // A mod pane (md-review) can't be parked: it moves by closing and opening again with the same props.
      const tabOf = panes().find((y) => y.pane === tg.pane)?.tab;
      const crowded = panes().filter((x) => x.tab === tabOf).length > 1;
      if (tg.mod)
        return [
          ...(tg.copy?.block ? [["Copy this block", "copy", { text: tg.copy.block }]] : []),
          ...(tg.copy?.doc ? [["Copy whole document", "copy", { text: tg.copy.doc }]] : []),
          ...(crowded ? [["Move to new tab", "move.newtab", tg]] : []),
          ...(moveTargets(tg).length ? [["Move into tab…", "move.menu", {}]] : []),
          ["Close pane", "pane.close", { pane: tg.pane }],
        ];
      return [
        // Hidden for a terminal running directly on Windows: the path search needs sh and find,
        // which a WSL or Linux machine has and Windows doesn't.
        ...(tg.terminal && !(window()?.platform === "windows" && machineOf(tg.terminal) === null) ? [["Open from screen…", "paths.menu", {}]] : []),
        ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
        ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
        ["Zoom", "pane.zoom", { pane: tg.pane }],
        // Sleep closes the Claude in this pane (/exit, back to its shell) and labels the terminal with
        // its session (sleep.session / sleep.cwd, the labels auto-sleep uses too); Wake
        // resumes it in the same pane. See session.py.
        ...(tg.terminal && isClaude(tg) ? [["Sleep session", "session.sleep", { terminal: tg.terminal }]] : []),
        // claude.session (a SessionStart hook) is the last session started here, so a Claude
        // killed without sleeping (a reboot, a crash) can be woken too.
        ...(tg.terminal && !isClaude(tg) && (term?.labels?.["sleep.session"] || term?.labels?.["claude.session"]) ? [["Wake session", "session.wake", { terminal: tg.terminal }]] : []),
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
        // The pane-status header's coloured bar (the terminal's "status" and "status.color" labels).
        ...(term
          ? [
              [term.labels?.status ? "Change status…" : "Set status…", "status.set", { terminal: term.address }],
              ...(term.labels?.status ? [["Clear status", "status.clear", { terminal: term.address }]] : []),
            ]
          : []),
        ...(tg.terminal
          ? [
              ...(crowded
                ? [["Move to new tab", "move.newtab", { terminal: tg.terminal }]]
                : []),
              ...(moveTargets({ terminal: tg.terminal, pane: tg.pane }).length ? [["Move into tab…", "move.menu", {}]] : []),
              ["Move to new space…", "move.newspacemenu", {}],
            ]
          : []),
        ["Close pane", "pane.close", { pane: tg.pane }],
      ];
    }
    case "tab":
      return [
        ["Rename", "tab.rename", { id: tg.id }],
        ["New tab", "tab.new", { space: tg.space }],
        ["Close", "tab.close", { id: tg.id }],
      ];
    case "space":
      return [
        ["Rename", "space.rename", { id: tg.id }],
        ...(git ? [["New worktree", "worktree", { space: tg.id, action: "new" }], ["Open worktree", "worktree", { space: tg.id, action: "open" }]] : []),
        ...(git === "linked" ? [["Remove worktree", "worktree", { space: tg.id, action: "remove" }]] : []),
        ["Close", "space.close", { id: tg.id }],
      ];
    default:
      return [
        ["New space", "space.new", {}],
        ["Keybinds", "app.help", {}],
        ["Theme: graphite", "app.theme", { name: "graphite" }],
        ["Theme: ink", "app.theme", { name: "ink" }],
        ["Theme: moss", "app.theme", { name: "moss" }],
        ["Theme: atom one dark", "app.theme", { name: "atom-one-dark" }],
      ];
  }
}

// Claude is running: Herdr keeps `app` after Claude exits and only clears `status`, so both count.
const isClaude = (tg) => {
  const p = panes().find((x) => x.pane === tg.pane || x.terminal === tg.terminal);
  return p?.app === "claude-code" && p?.status != null;
};
// session.py runs detached, since the menu closes (and its tasks stop) before it's done.
// It takes a few seconds (Claude has to exit, or start), so say so at once.
const session = (action, terminal) =>
  notify({ title: action === "sleep" ? "Putting session to sleep…" : "Waking session…", level: "info", timeout: 3000 }) &&
  exec("sh", ["-c", 'nohup python3 "$0" "$@" >/dev/null 2>&1 &', `${appHome()}/mods/pane-menu/session.py`, action, terminal]).catch(() => null);

function menuIcon(command, args) {
  if (command === "copy") return "mods/notepads/copy.svg";
  if (command === "open") return `mods/files/${args.dir ? "folder" : "file"}.svg`;
  if (command === "paths.menu") return "mods/files/file.svg";
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : command === "session.sleep" ? "clock" : command === "copy" ? "copy" : command === "move.newtab" ? "plus" : command === "move.back" ? "chevron-left" : command === "move.space" || command === "move.newspacemenu" ? "layers" : command === "move.newspace" ? "folder" : command.startsWith("move.") ? "panel-right" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

// A .md file opens in md-review in a new tab; anything else in the system's app for it
// (Explorer on Windows, `open` on a Mac, xdg-open on Linux).
// reveal shows it selected in its folder instead.
function openPath(f, reveal) {
  if (!reveal && !f.dir && /\.md$/i.test(f.path)) return run("tab.new", { mod: "md-review", props: { file: f.win ?? f.path } });
  const win = f.win ?? f.path;
  if (window()?.platform === "windows") return exec("explorer", reveal ? [`/select,${win}`] : [win]).catch(() => null);
  if (window()?.platform === "macos") return exec("open", reveal ? ["-R", f.path] : [f.path]).catch(() => null);
  exec("xdg-open", [reveal ? f.path.replace(/\/[^/]*$/, "") || "/" : f.path]).catch(() => null);
}

// Whether a divider goes above item i (the same rule render draws).
const divided = (list, i) => i > 0 && ((list[i][1] === "pane.split" && list[i - 1][1] === "paths.menu") || list[i][1].endsWith(".close") || list[i][1] === "app.help" || (list[i][1] === "app.theme" && list[i - 1][1] !== "app.theme") || (list[i][1].startsWith("move.") && !list[i - 1][1].startsWith("move.")));

export default class Menu extends View {
  init(_props, cx) {
    this.at = 0;
    this.git = null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    const p = props();
    const space = p?.tab === "space" && spaces().find((s) => s.id === p.target?.id);
    const folder = space && place(space);
    if (folder)
      cx.spawn(async (cx) => {
        this.git = await checkout(folder, space.machine).catch(() => null);
        cx.notify();
      });
  }

  // Fills the "Open from screen…" level: null while scanning, then the paths found.
  scan(cx) {
    this.paths = null;
    const tg = props()?.target ?? {};
    cx.spawn(async (cx) => {
      const cwd = panes().find((x) => x.pane === tg.pane)?.cwd;
      const found = await pathsOnScreen(tg.terminal, cwd, machineOf(tg.terminal)).catch(() => []);
      if (this.sub !== "paths") return;
      this.paths = found;
      cx.notify();
    });
  }

  // One level up: the paths and spaces levels go back to the top, a space's tabs to the spaces.
  back() {
    this.sub = this.sub === "spaces" || this.sub === "newspace" || this.sub === "paths" ? null : "spaces";
    this.at = 0;
  }

  choose(i, cx) {
    const it = items(props(), this.git, this.sub, this.paths, this.asleep)[i];
    if (!it) return;
    if (it[1] === "paths.menu") {
      this.sub = "paths";
      this.at = 0;
      this.scan(cx);
      cx.notify();
      return;
    }
    if (it[1] === "move.back") {
      this.back();
      cx.notify();
      return;
    }
    // Moving between menu levels keeps the menu open.
    if (it[1] === "move.menu" || it[1] === "move.space" || it[1] === "move.newspacemenu") {
      this.sub = it[1] === "move.menu" ? "spaces" : it[1] === "move.space" ? it[2].space : "newspace";
      this.at = 0;
      cx.notify();
      return;
    }
    if (it[1] === "move.newspace") return this.moveToNewSpace(it[2], cx);
    // terminal.keep sent while terminal.park is still pending is dropped, which left the
    // program running with no pane. So park, wait until its pane is gone, then keep;
    // the menu stays open until then, because its timers stop once it closes.
    if ((it[1] === "move.newtab" || it[1] === "move.into") && !it[2].mod) {
      const { terminal, space, tab } = it[2];
      run("terminal.park", { terminal });
      const started = Date.now();
      const wait = cx.timer.every(100, (cx) => {
        if (panes().some((x) => x.terminal === terminal) && Date.now() - started < 3000) return;
        wait.cancel();
        if (it[1] === "move.newtab") {
          // A new tab lands in the focused space, so go to the chosen one first.
          if (space) run("space.select", { id: space });
          run("terminal.keep", { terminal, place: "tab" });
        } else {
          run("tab.select", { id: tab });
          run("terminal.keep", { terminal, place: "right" });
        }
        closeOverlay(props()?.overlay);
      });
      return;
    }
    closeOverlay(props()?.overlay);
    if (it[1] === "copy") cx.write_to_clipboard(it[2].text);
    else if (it[1] === "open") openPath(it[2], false);
    else if (it[1] === "session.sleep") session("sleep", it[2].terminal);
    else if (it[1] === "session.wake") session("wake", it[2].terminal);
    else if (it[1] === "move.newtab" && it[2].mod) {
      run("pane.close", { pane: it[2].pane });
      run("tab.new", { mod: it[2].mod, props: it[2].props, ...(it[2].space ? { space: it[2].space } : {}) });
    } else if (it[1] === "move.into" && it[2].mod) {
      run("pane.close", { pane: it[2].pane });
      run("tab.select", { id: it[2].tab });
      run("pane.split", { direction: "right", mod: it[2].mod, props: it[2].props });
    } else if (it[1] === "status.set") openOverlay({ mod: "pane-status", kind: "dialog", width: 420, height: 186, props: { role: "set", terminal: it[2].terminal } });
    else if (it[1] === "status.clear") exec("hc", ["label", it[2].terminal, "status=", "status.color="]).catch(() => null);
    else if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else run(it[1], it[2]);
  }

  // Moves a terminal into a new space: park it, make the space (in the terminal's folder,
  // on its machine), give the terminal a pane beside the shell space.new starts, close
  // that shell, then set the group. Each step waits for the one before (see choose()).
  moveToNewSpace({ terminal, group }, cx) {
    const from = panes().find((x) => x.terminal === terminal);
    const machine = machineOf(terminal);
    // Unnamed, the new space would take its folder's name ("Code"), so carry over the
    // name of the tab the terminal was in, else of its space, if someone named it.
    const old = spaces().flatMap((s) => (s.tabs ?? []).map((t) => ({ s, t }))).find((x) => x.t.id === from?.tab);
    const name = old?.t.named ? old.t.name : old?.s.named ? old.s.name : null;
    const before = new Set(spaces().map((s) => s.id));
    const started = Date.now();
    let step = "park", space = null;
    run("terminal.park", { terminal });
    const wait = cx.timer.every(100, () => {
      const late = Date.now() - started > 5000;
      if (step === "park" && (late || !panes().some((x) => x.terminal === terminal))) {
        run("space.new", { machine: machine ?? "", ...(name ? { name } : {}), ...(from?.cwd ? { folder: from.cwd } : {}) });
        step = "space";
      } else if (step === "space") {
        space = spaces().find((s) => !before.has(s.id) && (s.machine ?? null) === machine);
        const tabs = new Set((space?.tabs ?? []).map((c) => c.id));
        if (space && panes().some((x) => tabs.has(x.tab))) {
          run("terminal.keep", { terminal, place: "right" });
          step = "keep";
        } else if (late) step = "done";
      } else if (step === "keep") {
        const tabs = new Set((space.tabs ?? []).map((c) => c.id));
        const here = panes().filter((x) => tabs.has(x.tab));
        if (here.some((x) => x.terminal === terminal) || late) {
          for (const x of here) if (x.terminal !== terminal) run("pane.close", { pane: x.pane });
          step = "done";
        }
      }
      if (step !== "done") return;
      wait.cancel();
      closeOverlay(props()?.overlay);
      if (!space) return notify({ title: "Move to new space", body: "The new space didn't appear.", level: "error" });
      if (group === "new") openOverlay({ mod: "spaces-grouped", kind: "dialog", width: 340, height: 420, props: { role: "groups", space: space.id } });
      else if (group) {
        const g = shared("space.groups") ?? {};
        setShared("space.groups", { list: g.list ?? [], of: { ...(g.of ?? {}), [space.id]: group } });
      }
    });
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.git, this.sub, this.paths, this.asleep);
    const status = this.sub !== "paths" ? null : this.paths === null ? "Looking for paths…" : this.paths.length ? null : "No files or folders on screen";
    return v_flex()
      .id("menu")
      .track_focus(this.handle)
      .w_full()
      .min_h(0)
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "left" && this.sub) this.back();
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .when(this.sub === "paths", (el) => el.child(div().px(8).pt(4).pb(5).text_size(11).text_color(t.dim).child("On screen")))
      .children(
        list.map((it, i) =>
          v_flex()
            .when(divided(list, i), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
            .child(h_flex()
            .id(`mi-${i}`)
            .h(31)
            .px(8)
            .gap(9)
            .rounded(7)
            .items_center()
            .justify_between()
            .text_color(t.foreground)
            .when(i === this.at, (el) => el.bg(t.selected))
            .hover((s) => s.bg(t.hover))
            .when(it[1] !== "open", (el) => el
              .on_click((_e, cx) => this.choose(i, cx))
              .child(svg(menuIcon(it[1], it[2])).size(14).flex_none().text_color(t.muted))
              .child(div().flex_1().child(it[0]))
              .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2]))))
            // A path row: the name opens it, the button beside it shows it in its folder.
            .when(it[1] === "open", (el) => el
              .child(h_flex().id(`open-${i}`).flex_1().min_w(0).h_full().gap(9).items_center().tooltip(it[2].path)
                .on_click((_e, cx) => this.choose(i, cx))
                .child(svg(menuIcon(it[1], it[2])).size(14).flex_none().text_color(t.muted))
                .child(div().flex_1().min_w(0).truncate().child(it[0])))
              .child(div().id(`reveal-${i}`).flex_none().px(6).py(2).rounded(5).text_size(11).text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground))
                .on_click(() => { closeOverlay(props()?.overlay); openPath(it[2], true); })
                .child("Folder")))),
        ),
      )
      .when(status, (el) => el.child(div().px(8).py(8).text_color(t.dim).child(status)));
  }
}
