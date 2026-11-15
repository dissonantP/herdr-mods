// The space groups dialog (the `groups` role). Opened with props { space } from the space menu's
// "Move to group…" (pick a group, "No group", or type a new one), or with
// props { group } from a group header's right-click (rename or delete it).
// Groups live in shared("space.groups"): { list: [{ id, name, machine, parent? }], of: { spaceId: groupId } },
// where `parent` is the id of the group it sits inside (none: top level).
// The `spaces-grouped` sidebar draws them.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared } from "herdr";
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


export const groups = () => {
  const g = shared("space.groups") ?? {};
  return { list: g.list ?? [], of: g.of ?? {} };
};

// The groups in the sidebar's order (each followed by the groups inside it), with `depth`.
// Same as treeOrder() in spaces-grouped.
const treeOrder = (list) => {
  const ids = new Set(list.map((x) => x.id)), seen = new Set(), out = [];
  const walk = (x, depth) => {
    if (seen.has(x.id)) return;
    seen.add(x.id);
    out.push({ ...x, depth });
    for (const y of list) if (y.parent === x.id) walk(y, depth + 1);
  };
  for (const x of list) if (!x.parent || !ids.has(x.parent)) walk(x, 0);
  for (const x of list) walk(x, 0);
  return out;
};
// Whether group `id` is `root` or sits somewhere inside it.
const within = (list, id, root) => {
  for (let x = list.find((y) => y.id === id), n = 0; x && n <= list.length; x = list.find((y) => y.id === x.parent), n++)
    if (x.id === root) return true;
  return false;
};

export default class SpaceGroups extends View {
  init(_props, cx) {
    const p = props() ?? {};
    const group = p.group && groups().list.find((x) => x.id === p.group);
    this.text = group?.name ?? "";
    this.input = InputState.new({ value: this.text, placeholder: group ? "" : "New group name" });
    if (this.text) this.input.set_selected_range({ start: 0, end: this.text.length });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  close() { closeOverlay(props().overlay); }

  // Puts the space in a group (null: no group).
  assign(groupId) {
    const p = props(), g = groups();
    const of = { ...g.of };
    if (groupId) of[p.space] = groupId; else delete of[p.space];
    setShared("space.groups", { list: g.list, of });
    this.close();
  }

  submit() {
    const p = props(), g = groups(), name = this.text.trim();
    if (!name) return;
    if (p.group) {
      setShared("space.groups", { list: g.list.map((x) => (x.id === p.group ? { ...x, name } : x)), of: g.of });
      return this.close();
    }
    const space = spaces().find((s) => s.id === p.space);
    const machine = space?.machine ?? null;
    const same = g.list.find((x) => x.name === name && x.machine === machine);
    if (same) return this.assign(same.id);
    const id = `g${Date.now().toString(36)}`;
    setShared("space.groups", { list: [...g.list, { id, name, machine }], of: { ...g.of, [p.space]: id } });
    this.close();
  }

  // Deletes the group. Its spaces and the groups inside it move up to its parent group
  // (top level: its spaces get no group).
  remove() {
    const p = props(), g = groups();
    const parent = g.list.find((x) => x.id === p.group)?.parent ?? null;
    const of = Object.fromEntries(Object.entries(g.of).flatMap(([s, id]) => (id !== p.group ? [[s, id]] : parent ? [[s, parent]] : [])));
    const list = g.list.filter((x) => x.id !== p.group).map(({ parent: up, ...x }) => {
      const next = up === p.group ? parent : up;
      return next ? { ...x, parent: next } : x;
    });
    setShared("space.groups", { list, of });
    this.close();
  }

  // Puts this group inside another (null: top level), last among that group's groups.
  setParent(parentId) {
    const p = props(), g = groups();
    const old = g.list.find((x) => x.id === p.group);
    if (!old || (parentId && within(g.list, parentId, p.group))) return;
    const { parent: _, ...moved } = old;
    if (parentId) moved.parent = parentId;
    setShared("space.groups", { list: [...g.list.filter((x) => x.id !== p.group), moved], of: g.of });
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const g = groups();
    const space = p.space && spaces().find((s) => s.id === p.space);
    const machine = space?.machine ?? null;
    const current = p.space ? g.of[p.space] ?? null : null;
    const group = p.group && g.list.find((x) => x.id === p.group);
    const parentNow = group && g.list.some((x) => x.id === group.parent) ? group.parent : null;
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    // depth: how far the row is indented (a group inside another sits under it).
    const choice = (id, name, groupId, depth = 0, now = current, pick = (x) => this.assign(x)) => h_flex().id(id).h(30).px(8).pl(8 + 16 * depth).gap(8).items_center().rounded(7)
      .flex_none().cursor_pointer().hover((s) => s.bg(t.hover)).when(now === groupId, (el) => el.bg(t.selected))
      .on_click(() => pick(groupId))
      .child(svg(`mods/workspace-chrome/${groupId ? "folder" : "minus"}.svg`).size(13).flex_none().text_color(t.muted))
      .child(div().flex_1().truncate().child(name))
      .when(now === groupId, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(13).flex_none().text_color(t.accent)));
    const title = p.group ? "Group" : `Move ${space?.name ?? "space"} to group`;
    // A group's color: its spaces without a pick of their own take it.
    const groupColor = p.group ? (shared("group.colors") ?? {})[p.group] ?? "dim" : null;
    const pickGroupColor = (key) => {
      const all = { ...(shared("group.colors") ?? {}) };
      if (key && key !== "dim") all[p.group] = key; else delete all[p.group];
      setShared("group.colors", all);
    };
    return v_flex().id("space-groups").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).gap(10).bg(t.popover).text_color(t.foreground).text_size(12.8)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().truncate().child(title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .when(!p.group, (el) => el.child(v_flex().gap(2)
        .child(choice("sg-none", "No group", null))
        .children(treeOrder(g.list.filter((x) => (x.machine ?? null) === machine)).map((x) => choice(`sg-${x.id}`, x.name, x.id, x.depth)))))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.inputFocused ? t.accent : t.input)
        .bg(t.background).text_size(12.8).text_color(t.foreground))
      .when(Boolean(p.group), (el) => el.child(v_flex().gap(2)
        .child(div().text_size(11.5).text_color(t.muted).pb(2).child("Inside group"))
        .child(choice("sg-parent-none", "Top level", null, 0, parentNow, (x) => this.setParent(x)))
        // Not itself or a group inside it: that would put the group inside itself.
        .children(treeOrder(g.list.filter((x) => (x.machine ?? null) === (group?.machine ?? null)))
          .filter((x) => !within(g.list, x.id, p.group))
          .map((x) => choice(`sg-parent-${x.id}`, x.name, x.id, x.depth, parentNow, (y) => this.setParent(y))))))
      .when(Boolean(p.group), (el) => el.child(v_flex().gap(4)
        .child(div().text_size(11.5).text_color(t.muted).child("Color for its spaces"))
        .child(swatchRow(t, groupColor, pickGroupColor, false).px(0))))
      .child(h_flex().pt(6).gap(8).justify_end()
        .when(Boolean(p.group), (el) => el.child(div().flex_1().child(button("sg-delete", "Delete group", false, () => this.remove()))))
        .child(button("sg-cancel", "Cancel", false, () => this.close()))
        .child(button("sg-save", p.group ? "Save" : "Create", true, () => this.submit())));
  }
}
