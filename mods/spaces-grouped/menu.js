// The `menu` role of spaces-grouped (a copy of Herdr's `menu` mod): adds
// "Move to group…" to a space's right-click menu (opens the `groups` role)
// and "Set status…" (opens the `status` role).
// Context menus (Herdr's items). Opened as a popup with
// props { tab: "pane" | "tab" | "space" | "global", target }.
// ↑/↓ move, Enter runs, Esc closes. An item is [label, command, args];
// a command "worktree" opens the worktree dialog instead.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, terminals, panes, exec, shared, setShared } from "herdr";
import { spaces } from "./machines-filter.js";

// Row colors the spaces-grouped sidebar draws. A space's own pick is in shared
// "space.color" ({ spaceId: key }, "dim": no color even in a colored group), a
// group's in shared "group.colors" ({ groupId: key }). A space with no pick takes
// its group's color, else none. Herdr's own "space.colors" (avatar colors it
// hands out by itself) is not used. Keys: Herdr's avatar color names or #rrggbb.
const SWATCHES = [
  ["ansi6", "#22a99a"], ["ansi4", "#5b8def"], ["ansi5", "#8b7cf6"], ["ansi1", "#d9649a"],
  ["ansi3", "#e3814f"], ["ansi2", "#3fae6a"], ["#d9b54a", "#d9b54a"], ["#d9534f", "#d9534f"], ["#8a8f98", "#8a8f98"],
];

// A row of color squares: an optional "same as group" square, "no color", then SWATCHES.
// now: the key shown as picked ("group" for the first square); pick(key | null) saves.
// A key starting "inv:" is that color inverted: the sidebar fills the row with the
// full color instead of the muted one, with black text. The last square toggles it
// on the picked color, and picking another color keeps it.
function swatchRow(t, now, pick, withGroup) {
  const inv = typeof now === "string" && now.startsWith("inv:");
  const base = inv ? now.slice(4) : now;
  const colored = SWATCHES.some(([key]) => key === base);
  const square = (id, key, tip) => div().id(id).size(17).flex_none().border(2)
    .when(Boolean(tip), (el) => el.tooltip(tip)).cursor_pointer().hover((s) => s.border_color(t.foreground)).on_click(() => pick(key));
  return h_flex().px(8).py(4).gap(5).items_center()
    .when(withGroup, (el) => el.child(square("color-group", null, "Same as its group").border_color(now === "group" ? t.foreground : t.dim)
      .items_center().justify_center().child(svg("mods/workspace-chrome/folder.svg").size(11).text_color(t.dim))))
    .child(square("color-none", "dim", "No color").border_color(now === "dim" ? t.foreground : t.dim)
      .items_center().justify_center().text_size(12).text_color(t.dim).child("\u2215"))
    .children(SWATCHES.map(([key, hex]) => square(`color-${key}`, inv ? `inv:${key}` : key, null).bg(hex).border_color(key === base ? t.foreground : hex)))
    .child(div().id("color-invert").size(17).flex_none().border(2).items_center().justify_center().text_size(12)
      .border_color(inv ? t.foreground : t.dim).text_color(inv ? t.foreground : t.dim).when(inv, (el) => el.bg(t.selected))
      .tooltip(colored ? "Invert: full color with black text" : "Pick a color to invert it")
      .when(colored, (el) => el.cursor_pointer().hover((s) => s.border_color(t.foreground)).on_click(() => pick(inv ? base : `inv:${base}`)))
      .child("\u25d0"));
}

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

function items(p, git) {
  p = p ?? {};
  const tg = p.target ?? {};
  switch (p.tab) {
    case "pane": {
      // A kept sub-agent can go back under its parent, still running.
      const all = terminals();
      const term = all.find((t) => t.address === tg.terminal);
      const parent = term?.parent && all.find((t) => t.address === term.parent);
      // Once they go to the program, Shift+right-click still opens this menu.
      const toProgram = term?.labels?.["herdr.right-click"] === "program";
      return [
        ["Split right", "pane.split", { direction: "right", pane: tg.pane }],
        ["Split down", "pane.split", { direction: "down", pane: tg.pane }],
        ["Zoom", "pane.zoom", { pane: tg.pane }],
        ...(term
          ? [
              toProgram
                ? ["Use Herdr right-click menu", "terminal.right_click", { terminal: term.address, to: "menu" }]
                : ["Send right-clicks to pane", "terminal.right_click", { terminal: term.address, to: "program" }],
            ]
          : []),
        ...(parent ? [[`Send back to ${parent.name || parent.address}`, "terminal.park", { terminal: term.address }]] : []),
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
        ["Set status…", "status", { space: tg.id }],
        ["Move to group…", "groups", { space: tg.id }],
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

function menuIcon(command) {
  const name = command.endsWith(".close") ? "x" : command.endsWith(".rename") ? "square-pen" : command.endsWith(".new") ? "plus" : command === "worktree" ? "git-branch" : command === "groups" ? "folder" : command === "status" ? "square-pen" : command === "app.help" ? "terminal" : command === "app.theme" ? "settings" : command === "pane.split" ? "panel-right" : command === "pane.zoom" ? "square" : "terminal";
  return `mods/workspace-chrome/${name}.svg`;
}

// The key bound to a command, for the hint on the right.
function shortcut(name, args) {
  // `pane.split:right` binds pane.split with { direction: "right" }.
  const value = args && Object.values(args)[0];
  const k = keys().find((b) => b.section === "global" && (b.action === name || b.action === `${name}:${value}`));
  return k ? k.keys : "";
}

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

  choose(i, cx) {
    const it = items(props(), this.git)[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    if (it[1] === "status") openOverlay({ mod: "spaces-grouped", kind: "dialog", width: 400, height: 560, props: { ...it[2], role: "status" } });
    else if (it[1] === "groups") openOverlay({ mod: "spaces-grouped", kind: "dialog", width: 340, height: 420, props: { ...it[2], role: "groups" } });
    else if (it[1] === "worktree") openOverlay({ mod: "worktree", kind: "dialog", ...(it[2].action === "open" ? { width: 560, height: 480 } : { width: 440, height: 260 }), props: it[2] });
    else run(it[1], it[2]);
  }

  render(cx) {
    const t = theme();
    const list = items(props(), this.git);
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
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(
        list.map((it, i) =>
          v_flex()
            .when(i > 0 && (it[1].endsWith(".close") || it[1] === "app.help" || (it[1] === "app.theme" && list[i - 1][1] !== "app.theme")), el => el.child(div().mx(7).my(4).h(1).bg(t.border)))
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
            .on_click((_e, cx) => this.choose(i, cx))
            .child(svg(menuIcon(it[1])).size(14).flex_none().text_color(t.muted))
            .child(div().flex_1().child(it[0]))
            .child(div().text_size(11).text_color(t.dim).child(shortcut(it[1], it[2])))),
        ),
      )
      .when(props()?.tab === "space", (el) => el.child(this.swatches(t)));
  }

  // A row of colors under a space's items; a click recolors the space and keeps the menu
  // open, so a color and its invert can be picked in one go (Esc or a click outside closes it).
  // In a group, the first square drops the space's own pick so it takes the group's color.
  swatches(t) {
    const id = props().target?.id;
    const grouped = Boolean((shared("space.groups") ?? {}).of?.[id]);
    const own = (shared("space.color") ?? {})[id];
    const pick = (key) => {
      const all = { ...(shared("space.color") ?? {}) };
      if (key) all[id] = key; else delete all[id];
      setShared("space.color", all);
    };
    return v_flex()
      .child(div().mx(7).my(4).h(1).bg(t.border))
      .child(swatchRow(t, own ?? (grouped ? "group" : "dim"), pick, grouped));
  }
}
