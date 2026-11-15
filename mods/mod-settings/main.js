// The mods' own settings: a dialog (mod.open:mod-settings, Ctrl+Shift+S) for keys Herdr's
// Settings screen doesn't show. Each entry in SETTINGS is one key of settings.json; Save
// changes only those keys and keeps every other key as it was.
//
// To add a setting, add an entry to SETTINGS:
//   kind "per-machine": an object keyed by machine name ("" is this computer), one field per
//                       machine (machines() plus this computer). Empty fields are left out.
//   kind "text":        one string field. Empty removes the key.
//   kind "toggle":      an on/off switch, saved as true, or removed when off.
// Whoever reads the key reads settings.json itself (see newSpace() in mods/spaces-grouped).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, machines, readTextFile, writeTextFile, appHome, notify, setShared } from "herdr";

const SETTINGS = [
  {
    key: "new_space_folders",
    kind: "per-machine",
    title: "New space folder",
    about: "Where a new space's first terminal starts (the sidebar's + and Ctrl+Shift+N).",
    placeholder: "Machine's home folder",
  },
  {
    key: "notepads_folder",
    kind: "text",
    title: "Notepads folder",
    about: "The folder the sidebar's Notepads keep their files in (mods/notepads). Empty: ~/notepads.",
    placeholder: "~/notepads",
  },
  {
    key: "sidebar_machine",
    kind: "text",
    title: "Only show spaces from",
    about: "This window's sidebar lists only one computer's spaces: \"this computer\", or a machine's name such as pi. Empty: every computer. For a second Herdr window (HERDR_APP_HOME) per context.",
    placeholder: "Every computer",
  },
  {
    key: "pin_spaces",
    kind: "toggle",
    title: "Always pin spaces",
    about: "A space you open from the sidebar, or make, is pinned in its own column right away (mods/pins), instead of showing as the selected space.",
  },
];

const settingsPath = () => `${appHome()}/settings.json`;
const machineLabel = (m) => (m === "" ? "This computer" : m);

export default class ModSettings extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.inputs = {}; // field id -> InputState, built by buildInputs() once settings.json is read
    this.focusedInput = null;
    this.error = null;
    this.loaded = false;
    cx.spawn(async (cx) => {
      try {
        this.values = JSON.parse((await readTextFile(settingsPath())) ?? "{}");
      } catch (e) {
        this.values = {};
        this.error = `Couldn't read settings.json: ${e}`;
      }
      this.buildInputs();
      this.loaded = true;
      cx.notify();
    });
  }

  // Machine names a per-machine setting gets a field for: this computer, the connected
  // machines, and any machine already in the setting (so a removed machine's value still shows).
  machineNames(setting) {
    const names = ["", ...machines().map((m) => m.name).filter(Boolean),
      ...Object.keys(this.values[setting.key] ?? {})];
    return [...new Set(names)];
  }

  // One InputState per field (gpui-kit won't create them during render).
  // Ids: `${setting.key}/${machine}` for "per-machine", setting.key for "text".
  buildInputs() {
    this.toggles = Object.fromEntries(SETTINGS.filter((s) => s.kind === "toggle").map((s) => [s.key, this.values[s.key] === true]));
    this.fields = SETTINGS.map((s) => {
      const v = this.values[s.key];
      if (s.kind === "toggle") return { setting: s, rows: [] };
      const rows = s.kind === "per-machine"
        ? this.machineNames(s).map((m) => ({ id: `${s.key}/${m}`, label: machineLabel(m), value: v?.[m] }))
        : [{ id: s.key, label: s.title, value: typeof v === "string" ? v : "" }];
      for (const r of rows) {
        const state = InputState.new({ value: r.value ?? "", placeholder: s.placeholder ?? "" });
        state.on("submit", (_e, cx) => this.save(cx));
        state.on("focus", (_e, cx) => { this.focusedInput = r.id; cx.notify(); });
        state.on("blur", (_e, cx) => { if (this.focusedInput === r.id) this.focusedInput = null; cx.notify(); });
        this.inputs[r.id] = state;
      }
      return { setting: s, rows };
    });
    this.inputs[this.fields.find((f) => f.rows.length)?.rows[0]?.id]?.focus();
  }

  // The settings' new values, from the fields: { key: value | undefined (remove) }.
  edited() {
    const out = {};
    for (const { setting: s, rows } of this.fields) {
      const value = (r) => this.inputs[r.id].value().trim();
      if (s.kind === "toggle") {
        out[s.key] = this.toggles[s.key] ? true : undefined;
      } else if (s.kind === "per-machine") {
        const map = Object.fromEntries(rows.map((r) => [r.id.slice(s.key.length + 1), value(r)]).filter(([, v]) => v));
        out[s.key] = Object.keys(map).length ? map : undefined;
      } else {
        out[s.key] = value(rows[0]) || undefined;
      }
    }
    return out;
  }

  save(cx) {
    cx.spawn(async (cx) => {
      const changes = this.edited();
      // Read again right before writing, so a change made elsewhere since the dialog opened
      // is kept; writeTextFile refuses if the file changed between this read and the write.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await readTextFile(settingsPath());
          const current = raw ? JSON.parse(raw) : {};
          for (const [k, v] of Object.entries(changes)) {
            if (v === undefined) delete current[k]; else current[k] = v;
          }
          await writeTextFile(settingsPath(), JSON.stringify(current, null, 2) + "\n", raw);
          // Mods that read these keys (mods/notepads) follow this instead of re-reading the file.
          setShared("settings.extra", Object.fromEntries(SETTINGS.map((s) => [s.key, current[s.key] ?? null])));
          notify({ title: "Settings saved", level: "info", timeout: 2500 });
          closeOverlay(props().overlay);
          return;
        } catch (e) {
          this.error = `Couldn't save settings.json: ${e}`;
        }
      }
      cx.notify();
    });
  }

  close() { closeOverlay(props().overlay); }

  render(cx) {
    const t = theme();
    const field = (r) => h_flex().gap(10).items_center()
      .child(div().w(120).flex_none().truncate().text_color(t.muted).child(r.label))
      .child(Input.new(this.inputs[r.id]).flex_1().h(34).px(10).rounded(8).border_1()
        .border_color(this.focusedInput === r.id ? t.accent : t.input).bg(t.background).text_color(t.foreground));
    const toggle = (s) => {
      const on = this.toggles[s.key];
      return h_flex().id(`toggle-${s.key}`).gap(10).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.toggles[s.key] = !on; cx.notify(); })
        .child(div().flex_1().text_size(13.5).font_semibold().child(s.title))
        .child(h_flex().w(36).h(20).flex_none().rounded(10).p(2).bg(on ? t.accent : t.input).when(on, (el) => el.justify_end())
          .child(div().size(16).rounded(8).bg(t.background)));
    };
    const section = ({ setting: s, rows }) => s.kind === "toggle"
      ? v_flex().gap(6).child(toggle(s)).when(Boolean(s.about), (el) => el.child(div().text_size(12).text_color(t.dim).child(s.about)))
      : v_flex().gap(8)
      .child(div().text_size(13.5).font_semibold().child(s.title))
      .when(Boolean(s.about), (el) => el.child(div().text_size(12).text_color(t.dim).child(s.about)))
      .children(rows.map(field));
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("mod-settings").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.close(); cx.stop_propagation(); } })
      .w_full().min_h(0).p(18).gap(14).bg(t.popover).text_color(t.foreground).text_size(12.8)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("Mod settings"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .when(!this.loaded, (el) => el.child(div().text_color(t.dim).child("Loading…")))
      .when(this.loaded, (el) => el.children(this.fields.map(section)))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().pt(4).gap(8).justify_end()
        .child(button("ms-cancel", "Cancel", false, () => this.close()))
        .child(button("ms-save", "Save", true, (_e, cx) => this.save(cx))));
  }
}
