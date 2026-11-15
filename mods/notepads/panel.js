// Notepads: a section at the bottom of the layout's sidebar (block "notepads"), one tab
// per notepad. Each notepad is one file in a folder (settings.json key "notepads_folder", set
// live from shared "settings.extra" if a settings mod publishes it, default ~/notepads), so agents can read and edit them:
//   <name>.txt  plain text, shown as a text box
//   <name>.md   a to-do list, one item per "- [ ] text" / "- [x] text" line, shown as a
//               checklist. Other lines in the file are kept but not shown.
// "+" and a tab's right-click open pop-up menus (the `menu` role, menu.js). A new notepad is named
// "Notepad <n>" (rename by double-click or right-click).
// The panel re-reads the folder when watchFolder reports a change (no timer polling).
// Collapsing resizes the block to its header with layout.resize.
// Ctrl+Alt+Shift+N toggles it open/closed. The arrows at the header's right resize it:
// drag up/down for its height, left/right for its width (the sidebar's).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { theme, shared, exec, home, appHome, readTextFile, writeTextFile, watchFolder, run, openOverlay, nextCommand } from "herdr";

const BLOCK = "notepads";
const HEADER = 31;
const DEFAULT_HEIGHT = 320;
const DEFAULT_FOLDER = "~/notepads";
const MIN_HEIGHT = 120;
const MIN_WIDTH = 180;   // narrower than 160 turns the sidebar into its compact rail
const MAX_WIDTH = 480;   // the sidebar's "max" in the layout
const icon = (name, size) => svg(`mods/notepads/${name}.svg`).size(size).flex_none();
const ITEM = /^(\s*[-*] \[)([ xX])(\] ?)(.*)$/;

const expand = (p) => (p.startsWith("~") ? home() + p.slice(1) : p).replace(/\/+$/, "");
const kindOf = (file) => (file.endsWith(".md") ? "todo" : "text");
const nameOf = (file) => file.replace(/\.(md|txt)$/, "");
const fileFor = (name, kind) => `${name}${kind === "todo" ? ".md" : ".txt"}`;
const validName = (n) => n && !n.includes("/") && !n.startsWith(".");

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) ?? "null");
    localStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
}

export default class Notepads extends View {
  init(_props, cx) {
    this.open = store("open") ?? true;
    this.height = store("height") ?? DEFAULT_HEIGHT;
    this.active = store("active");     // file name of the shown notepad
    this.files = [];                   // file names in the folder, sorted
    this.disk = {};                    // file -> text as last read or written
    this.textareas = {};               // file -> TextareaState (plain notepads)
    this.saveTick = new Map();         // TextareaState -> counter, so only the last pending save runs
    this.mode = null;                  // null | {kind: "rename"|"delete", file}
    this.editing = null;               // {file, line} of the to-do item being edited
    this.error = null;
    this.nameInput = InputState.new({ placeholder: "Notepad name" });
    this.nameInput.on("submit", (_e, cx) => this.submitName(cx));
    this.nameInput.on("blur", (_e, cx) => { if (this.mode?.kind === "rename") this.submitName(cx); });
    this.itemInput = InputState.new({ placeholder: "Add item…" });
    this.itemInput.on("submit", (_e, cx) => this.addItem(cx));
    this.editInput = InputState.new({});
    this.editInput.on("submit", (_e, cx) => this.finishEdit(cx));
    this.editInput.on("blur", (_e, cx) => this.finishEdit(cx));
    this.folder = null;
    this.wake = null;
    this.startedAt = Date.now();
    // Ctrl+Alt+Shift+N (keys.json "notepads.toggle") opens and closes the panel.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "toggle") this.toggleOpen(cx);
      }
    });
    cx.spawn(async (cx) => {
      let fileFolder = null;
      try { fileFolder = JSON.parse((await readTextFile(`${appHome()}/settings.json`)) ?? "{}").notepads_folder; } catch {}
      this.fileFolder = fileFolder;
      this.folder = this.wantedFolder();
      for (;;) {
        const folder = this.folder;
        await this.reload(folder);
        cx.notify();
        // Wait for a change in the folder, or for the folder setting to change (render wakes us).
        const changed = new Promise((r) => { this.wake = r; });
        await Promise.race([watchFolder(folder).catch(() => changed), changed]);
      }
    });
  }

  // The folder setting: what a settings mod last published this run (shared "settings.extra"), else settings.json.
  wantedFolder() {
    const saved = shared("settings.extra");
    return expand((saved ? saved.notepads_folder : this.fileFolder) || DEFAULT_FOLDER);
  }

  async reload(folder) {
    try {
      await exec("mkdir", ["-p", folder]);
      const r = await exec("ls", ["-1A", folder]);
      if (r.code !== 0) throw new Error(r.stderr.trim());
      const files = r.stdout.split("\n").filter((f) => /\.(md|txt)$/.test(f) && !f.startsWith("."))
        .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      const disk = {};
      for (const f of files) disk[f] = (await readTextFile(`${folder}/${f}`)) ?? "";
      if (folder !== this.folder) return;
      this.files = files;
      this.disk = disk;
      this.error = null;
      for (const f of files) {
        if (kindOf(f) !== "text") continue;
        const ta = this.textareas[f];
        if (!ta) {
          const state = TextareaState.new({ value: disk[f], placeholder: "Type here…" });
          state.set_soft_wrap(true);
          // Saves look the file up when they run, not here: a rename moves the state to a new name.
          state.on("change", (_e, cx) => this.queueSave(state, cx));
          this.textareas[f] = state;
        } else if (ta.value() !== disk[f] && !this.saveTick.has(ta)) {
          ta.set_value(disk[f]);
        }
      }
      if (!files.includes(this.active)) this.select(files[0] ?? null);
    } catch (e) {
      this.error = `Couldn't read ${folder}: ${e.message ?? e}`;
    }
  }

  path(file) { return `${this.folder}/${file}`; }

  select(file) {
    this.active = file;
    this.editing = null;
    store("active", file);
  }

  // Writes text over what was last read; refused if the file changed on disk since.
  async write(file, text) {
    try {
      await writeTextFile(this.path(file), text, this.disk[file] ?? null);
      this.disk[file] = text;
      this.error = null;
    } catch (e) {
      this.error = `Not saved, ${file} changed on disk. Showing the new version. (${e?.message ?? e})`;
      await this.reload(this.folder);
    }
  }

  // The file a plain-text state belongs to now (it changes on rename), or undefined once deleted.
  fileOf(state) { return Object.keys(this.textareas).find((f) => this.textareas[f] === state); }

  // Plain text: save half a second after the last keystroke.
  queueSave(state, cx) {
    const tick = (this.saveTick.get(state) ?? 0) + 1;
    this.saveTick.set(state, tick);
    cx.timer.after(500, (cx) => {
      if (this.saveTick.get(state) !== tick) return;
      cx.spawn(async (cx) => {
        const file = this.fileOf(state);
        try {
          if (file) await this.write(file, state.value());
        } catch (e) {
          this.error = `Not saved: ${e?.message ?? e}`;
        }
        if (this.saveTick.get(state) === tick) this.saveTick.delete(state);
        cx.notify();
      });
    });
  }

  // ---- notepads: new, rename, delete ----

  startName(mode, cx) {
    this.mode = mode;
    this.nameInput.set_value(mode.kind === "rename" ? nameOf(mode.file) : "");
    this.nameInput.focus();
    cx.notify();
  }

  submitName(cx) {
    const name = this.nameInput.value().trim();
    const mode = this.mode;
    if (mode?.kind !== "rename") return;
    if (!validName(name)) { this.error = "A name can't be empty, contain / or start with a dot."; cx.notify(); return; }
    const target = fileFor(name, kindOf(mode.file));
    if (this.files.includes(target) && target !== mode.file) { this.error = `"${name}" already exists.`; cx.notify(); return; }
    this.mode = null;
    cx.spawn(async (cx) => {
      if (target !== mode.file) {
        const r = await exec("mv", ["-n", this.path(mode.file), this.path(target)]);
        if (r.code !== 0) this.error = r.stderr.trim();
        if (r.code === 0 && this.textareas[mode.file]) { this.textareas[target] = this.textareas[mode.file]; delete this.textareas[mode.file]; }
        if (r.code === 0 && mode.file in this.disk) { this.disk[target] = this.disk[mode.file]; delete this.disk[mode.file]; }
      }
      this.select(target);
      await this.reload(this.folder);
      cx.notify();
    });
    cx.notify();
  }

  remove(file, cx) {
    this.mode = null;
    cx.spawn(async (cx) => {
      const r = await exec("trash-put", [this.path(file)]);
      if (r.code !== 0) this.error = r.stderr.trim() || "trash-put failed";
      delete this.textareas[file];
      await this.reload(this.folder);
      cx.notify();
    });
    cx.notify();
  }

  // ---- to-do items ----

  // Rewrites line `index` of a to-do file (null removes it) and saves.
  editLine(file, index, line, cx) {
    const lines = (this.disk[file] ?? "").split("\n");
    if (line === null) lines.splice(index, 1); else lines[index] = line;
    cx.spawn(async (cx) => { await this.write(file, lines.join("\n")); cx.notify(); });
  }

  toggle(file, item, cx) {
    const m = item.match;
    this.editLine(file, item.index, `${m[1]}${m[2] === " " ? "x" : " "}${m[3]}${m[4]}`, cx);
  }

  addItem(cx) {
    const text = this.itemInput.value().trim();
    const file = this.active;
    if (!text || !file) return;
    this.itemInput.set_value("");
    const old = this.disk[file] ?? "";
    const body = old === "" ? "" : old.endsWith("\n") ? old : old + "\n";
    cx.spawn(async (cx) => { await this.write(file, `${body}- [ ] ${text}\n`); cx.notify(); });
  }

  startEdit(file, item, cx) {
    this.editing = { file, line: item.index, original: item.text };
    this.editInput.set_value(item.text);
    this.editInput.focus();
    cx.notify();
  }

  finishEdit(cx) {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const text = this.editInput.value().trim();
    const line = (this.disk[ed.file] ?? "").split("\n")[ed.line];
    const m = line?.match(ITEM);
    if (m && text !== ed.original) this.editLine(ed.file, ed.line, text ? `${m[1]}${m[2]}${m[3]}${text}` : null, cx);
    cx.notify();
  }

  items(file) {
    return (this.disk[file] ?? "").split("\n").map((l, index) => ({ index, match: l.match(ITEM) }))
      .filter((i) => i.match).map((i) => ({ ...i, done: i.match[2] !== " ", text: i.match[4] }));
  }

  // ---- menus (the `menu` role, menu.js) ----

  menu(p, rows) {
    openOverlay({ mod: "notepads", kind: "popup", width: 190, height: 10 + rows * 31, props: { ...p, role: "menu" } });
  }

  // What the menu asked for, in shared("notepads.request"): select a new notepad, rename, delete.
  handleRequest() {
    const req = shared("notepads.request");
    if (!req || req.at <= (this.handledAt ?? 0)) return;
    this.handledAt = req.at;
    if (req.at < this.startedAt) return;
    if (req.action === "select") { this.select(req.file); this.mode = null; }
    else if (req.action === "rename") {
      this.mode = { kind: "rename", file: req.file };
      this.nameInput.set_value(req.file.replace(/\.(md|txt)$/, ""));
      this.nameInput.focus();
    } else if (req.action === "delete") this.mode = { kind: "delete", file: req.file };
  }

  // ---- resize grip (the arrows at the header's right) ----
  // Mods can't capture the mouse, so moves arrive only while the pointer is over this
  // panel. The panel's top edge follows the pointer up and its right edge (the sidebar's)
  // follows it sideways, so the pointer stays on the grip; if it does leave, or the
  // button is let go, the drag ends where it is.

  startResize(e, cx) {
    cx.stop_propagation();
    this.resizing = { x: e.position.x, y: e.position.y, height: this.height, width: this.width ?? 268 };
    cx.notify();
  }

  moveResize(e) {
    const r = this.resizing;
    if (!r) return;
    const height = Math.max(MIN_HEIGHT, Math.round(r.height + (r.y - e.position.y)));
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(r.width + (e.position.x - r.x))));
    if (height !== this.lastHeight) { this.lastHeight = height; run("layout.resize", { id: BLOCK, px: height }); }
    if (width !== this.lastWidth) { this.lastWidth = width; run("layout.resize", { id: "sidebar", px: width }); }
  }

  endResize(cx) {
    if (!this.resizing) return;
    this.resizing = null;
    this.resizeEndedAt = Date.now();   // the release lands on the header; don't let it toggle the panel
    cx.notify();
  }

  // ---- open / closed ----

  toggleOpen(cx) {
    this.open = !this.open;
    store("open", this.open);
    run("layout.resize", { id: BLOCK, px: this.open ? this.height : HEADER });
    cx.notify();
  }

  // ---- drawing ----

  render(cx) {
    const t = theme();
    this.handleRequest();
    const wanted = this.folder !== null ? this.wantedFolder() : null;
    if (wanted && wanted !== this.folder) { this.folder = wanted; this.files = []; this.disk = {}; this.textareas = {}; this.wake?.(); }

    const iconButton = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center()
      .rounded(5).text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(action).child(label);
    const smallButton = (id, label, primary, action) => div().id(id).h(24).px(9).flex().items_center().rounded(6)
      .text_size(11.5).cursor_pointer().border_1().border_color(primary ? t.solid : t.input)
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.opacity(0.88)).on_click(action).child(label);

    const grip = div().id("np-resize").size(26).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(this.resizing ? t.foreground : t.dim).when(Boolean(this.resizing), (el) => el.bg(t.hover))
      .cursor_nesw_resize().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (e, cx) => this.startResize(e, cx))
      .on_click((_e, cx) => cx.stop_propagation())
      .child(icon("move-diagonal", 13));
    const headerRight = h_flex().gap(2).items_center()
      .child(iconButton("np-new", icon("plus", 14), (_e, cx) => {
        cx.stop_propagation();
        this.mode = null;
        this.error = null;
        this.menu({ menu: "new", folder: this.folder, files: this.files }, 2);
        cx.notify();
      }))
      .child(grip);
    const header = h_flex().id("np-header").h(HEADER).flex_none().pl(16).pr(10).items_center().justify_between()
      .text_size(11.5).text_color(t.dim).cursor_pointer().on_click((_e, cx) => { if (Date.now() - (this.resizeEndedAt ?? 0) > 400) this.toggleOpen(cx); })
      .child(h_flex().gap(6).items_center().child(icon(this.open ? "chevron-down" : "chevron-right", 12)).child("Notepads"))
      .when(this.open, (el) => el.child(headerRight));

    const root = v_flex().id("notepads").size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .font_family("iA Writer Mono S").text_size(12)
      .on_mouse_move((e) => this.moveResize(e))
      .on_mouse_up("left", (_e, cx) => this.endResize(cx))
      .on_hover((hovered, cx) => { if (!hovered) this.endResize(cx); })
      .on_size_change((size, cx) => {
        this.width = size.width;
        // Dragging the border above a closed panel open opens it.
        if (!this.open && size.height > HEADER + 20) { this.open = true; store("open", true); cx.notify(); }
        if (this.open && size.height > HEADER + 20 && Math.abs(size.height - this.height) > 1) { this.height = size.height; store("height", size.height); }
      })
      .child(header);
    if (!this.open) return root;

    const tab = (f) => {
      const active = f === this.active;
      if (this.mode?.kind === "rename" && this.mode.file === f) {
        return div().id(`np-tab-${f}`).w(150).on_key_down((e, cx) => {
          if (e.key === "escape") { this.mode = null; this.error = null; cx.stop_propagation(); cx.notify(); }
        }).child(Input.new(this.nameInput).h(24).px(7).rounded(6).border_1().border_color(t.accent).bg(t.background));
      }
      return h_flex().id(`np-tab-${f}`).h(24).px(9).gap(5).items_center().rounded(6).cursor_pointer()
        .bg(active ? t.selected : t.chrome).text_color(active ? t.foreground : t.muted)
        .hover((s) => s.bg(active ? t.selected : t.hover))
        .on_click((e, cx) => {
          if (e.click_count >= 2) this.startName({ kind: "rename", file: f }, cx);
          else { this.select(f); this.mode = null; cx.notify(); }
        })
        .on_mouse_down("right", (_e, cx) => { this.select(f); this.mode = null; this.menu({ menu: "tab", folder: this.folder, file: f }, 4); cx.notify(); })
        .child(div().text_color(t.dim).child(icon(kindOf(f) === "todo" ? "circle-check" : "file-text", 12)))
        .child(div().max_w(140).truncate().child(nameOf(f)));
    };
    const tabs = h_flex().flex_wrap().gap(4).px(8).pb(6).flex_none().children(this.files.map(tab));

    // The strip under the tabs: the delete confirmation.
    let bar = null;
    const m = this.mode;
    if (m?.kind === "delete") {
      bar = h_flex().gap(6).px(10).pb(8).flex_none().items_center()
        .child(div().flex_1().truncate().text_color(t.muted).child(`Delete "${nameOf(m.file)}"?`))
        .child(smallButton("np-del-no", "Cancel", false, (_e, cx) => { this.mode = null; cx.notify(); }))
        .child(smallButton("np-del-yes", "Delete", true, (_e, cx) => this.remove(m.file, cx)));
    }

    const body = this.active ? (kindOf(this.active) === "todo" ? this.todoBody(t) : this.textBody(t))
      : div().px(16).py(8).text_color(t.dim).child(this.folder === null ? "Loading…" : "No notepads yet. Click + to add one.");

    return root
      .child(tabs)
      .when(bar !== null, (el) => el.child(bar))
      .when(Boolean(this.error), (el) => el.child(div().px(12).pb(6).text_size(11).text_color(t.blocked).child(this.error)))
      .child(v_flex().flex_1().min_h(0).child(body));
  }

  textBody(t) {
    const state = this.textareas[this.active];
    if (!state) return div();
    return v_flex().size_full().min_h(0).px(8).pb(8)
      .child(Textarea.new(state).size_full().p(8).rounded(6).border_1().border_color(t.border).bg(t.background).text_size(12));
  }

  todoBody(t) {
    const file = this.active;
    const row = (item) => {
      const editing = this.editing?.file === file && this.editing.line === item.index;
      const box = div().id(`np-check-${item.index}`).size(15).flex_none().mt(2).rounded(4).border_1()
        .border_color(item.done ? t.accent : t.input).bg(item.done ? t.accent : t.background)
        .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground).cursor_pointer()
        .on_click((_e, cx) => this.toggle(file, item, cx)).when(item.done, (el) => el.child(icon("check", 11)));
      const text = editing
        ? Input.new(this.editInput).flex_1().h(24).px(6).rounded(5).border_1().border_color(t.accent).bg(t.background)
        : div().id(`np-text-${item.index}`).flex_1().min_w(0).cursor_text()
          .text_color(item.done ? t.dim : t.foreground).when(item.done, (el) => el.line_through())
          .on_click((_e, cx) => this.startEdit(file, item, cx)).child(item.text || " ");
      return h_flex().id(`np-row-${item.index}`)
        .on_hover((h, cx) => { if (h) this.hoverRow = item.index; else if (this.hoverRow === item.index) this.hoverRow = null; cx.notify(); }).px(8).py(3).gap(8).items_start().rounded(6)
        .hover((s) => s.bg(t.hover))
        .child(box).child(text)
        .when(!editing && this.hoverRow === item.index, (el) => el.child(div().id(`np-del-${item.index}`).flex_none().px(4).text_color(t.dim).cursor_pointer()
          .hover((s) => s.text_color(t.blocked)).on_click((_e, cx) => this.editLine(file, item.index, null, cx)).child(icon("x", 12))));
    };
    const items = this.items(file);
    return v_flex().size_full().min_h(0)
      .child(v_flex().flex_1().min_h(0).px(4).overflow_y_scrollbar().children(items.map(row))
        .when(items.length === 0, (el) => el.child(div().px(12).py(4).text_color(t.dim).child("Nothing here yet."))))
      .child(div().px(8).pt(4).pb(8).flex_none()
        .child(Input.new(this.itemInput).h(28).px(8).rounded(6).border_1().border_color(t.input).bg(t.background)));
  }
}
