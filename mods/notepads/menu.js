// The `menu` role of notepads: the panel's pop-up menus (the panel opens them at the pointer):
//   props {menu: "new", folder, files}  the header's +: New to-do list / New plain text
//   props {menu: "tab", folder, file}   a tab's right-click: Open, Copy path, Rename, Delete
// Actions that need the panel (select the new notepad, rename, delete) go to it through
// shared("notepads.request") = {action, file, at}.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, run, setShared, writeTextFile, notify } from "herdr";

const icon = (name) => `mods/notepads/${name}.svg`;
const request = (action, file) => setShared("notepads.request", { action, file, at: Date.now() });

function newNotepad(folder, files, kind) {
  const names = new Set(files.map((f) => f.replace(/\.(md|txt)$/, "")));
  let n = 1;
  while (names.has(`Notepad ${n}`)) n++;
  return `Notepad ${n}${kind === "todo" ? ".md" : ".txt"}`;
}

export default class NotepadsMenu extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.at = 0;
  }

  items() {
    const p = props() ?? {};
    const path = `${p.folder}/${p.file}`;
    if (p.menu === "new") {
      const create = (kind) => (cx) => {
        const file = newNotepad(p.folder, p.files ?? [], kind);
        cx.spawn(async () => {
          try {
            await writeTextFile(`${p.folder}/${file}`, "", null);
            request("select", file);
          } catch (e) {
            notify({ title: "Couldn't create notepad", body: String(e), level: "error" });
          }
        });
      };
      return [["New to-do list", "circle-check", create("todo")], ["New plain text", "file-text", create("text")]];
    }
    return [
      ["Open", "file-text", () => run("pane.split", { direction: "right", mod: "md-review", props: { file: path } })],
      ["Copy path", "copy", (cx) => { cx.write_to_clipboard(path); notify({ title: "Path copied", level: "info", timeout: 2000 }); }],
      ["Rename", "pen", () => request("rename", p.file)],
      ["Delete", "x", () => request("delete", p.file)],
    ];
  }

  choose(i, cx) {
    const it = this.items()[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    it[2](cx);
  }

  render() {
    const t = theme();
    const list = this.items();
    return v_flex().id("notepads-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => h_flex().id(`npm-${i}`).h(31).px(8).gap(9).rounded(7).items_center()
        .text_color(it[1] === "x" ? t.blocked : t.foreground)
        .when(i === this.at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.choose(i, cx))
        .child(svg(icon(it[1])).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(it[0]))));
  }
}
