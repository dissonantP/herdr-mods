// The dialog for a space's status (the `status` role): a short freeform text (usually one emoji) that the
// `spaces-grouped` sidebar shows as a badge left of the space's name. Opened from a
// space's right-click menu (the `menu` role). props { space }.
// Saved in shared "space.status" ({ spaceId: text }); empty text clears it.
// The quick row shows the last statuses saved (shared "space.status.recent", newest
// first), then QUICK fills it to 10. Below it, an emoji picker: a tab per Unicode group,
// and typing letters in the text box searches every emoji by name. Clicking an emoji
// saves it; Enter saves the typed text itself; Esc closes.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, shared, setShared } from "herdr";
import { GROUPS } from "./emoji.js";

const QUICK = ["\u{1F7E2}", "\u{1F7E1}", "\u{1F534}", "\u{1F6A7}", "\u{1F440}", "✅", "⏳", "\u{1F525}", "\u{1F41B}", "\u{1F4AC}"];
const PER_ROW = 10;
const CELL = 32;

function quickRow() {
  const recent = shared("space.status.recent") ?? [];
  return [...recent, ...QUICK.filter((q) => !recent.includes(q))].slice(0, 10);
}

function save(text) {
  const p = props();
  const all = { ...(shared("space.status") ?? {}) };
  const value = text.trim();
  if (value) all[p.space] = value; else delete all[p.space];
  setShared("space.status", all);
  if (value) setShared("space.status.recent", [value, ...(shared("space.status.recent") ?? []).filter((r) => r !== value)].slice(0, 10));
  closeOverlay(p.overlay);
}

// How well one typed word matches an emoji's name, lower is better; null: no match.
// A word inside the name beats one at a word's start beats the letters in order with gaps
// ("smil" finds "grinning face with smiling eyes"; "sml" finds it too, ranked later).
function score(word, name) {
  const at = name.indexOf(word);
  if (at === 0 || (at > 0 && name[at - 1] === " ")) return 0;
  if (at > 0) return 1;
  let i = 0, gaps = 0, last = -1;
  for (let j = 0; j < name.length && i < word.length; j++)
    if (name[j] === word[i]) { if (last >= 0 && j > last + 1) gaps++; last = j; i++; }
  return i === word.length ? 2 + gaps : null;
}

// The emoji to show: when the text has letters, every emoji whose name matches each
// typed word (case-insensitive, fuzzy), best first; else the picked group's.
function shown(text, group) {
  const words = text.toLowerCase().split(/\s+/).filter((w) => /[a-z]/.test(w));
  if (!words.length) return GROUPS[group][1];
  const hits = [];
  for (const e of GROUPS.flatMap((g) => g[1])) {
    const name = e[1].toLowerCase();
    let total = 0;
    for (const w of words) { const s = score(w, name); if (s === null) { total = null; break; } total += s; }
    if (total !== null) hits.push([total, e]);
  }
  return hits.sort((a, b) => a[0] - b[0]).map((h) => h[1]);
}

export default class SpaceStatus extends View {
  init(_props, cx) {
    const now = (shared("space.status") ?? {})[props()?.space] ?? "";
    this.text = now;
    this.group = 0;
    this.input = InputState.new({ value: now });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => save(this.text));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  cell(t, id, [emoji, name]) {
    return h_flex().id(id).size(CELL).flex_none().justify_center().items_center().rounded(7).text_size(18)
      .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(name).on_click(() => save(emoji)).child(emoji);
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const list = shown(this.text, this.group);
    const rows = Math.ceil(list.length / PER_ROW);
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover(s => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("space-status").track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(p.overlay); cx.stop_propagation(); } })
      .size_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("Space status"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(14).pb(7).text_size(11.5).text_color(t.dim).child("Type to search emoji. Enter saves the typed text itself."))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(14).text_color(t.foreground))
      // Recent statuses: may be words, so these cells grow to fit.
      .child(h_flex().pt(10).gap(2).children(quickRow().map((e, i) =>
        h_flex().id(`st-${i}`).h(CELL).min_w(CELL).max_w(90).px(4).truncate().justify_center().items_center().rounded(7).text_size(18)
          .cursor_pointer().hover(s => s.bg(t.hover)).on_click(() => save(e)).child(e))))
      .child(div().my(8).h(1).bg(t.border))
      // Group tabs, shown each by its first emoji.
      .child(h_flex().gap(2).children(GROUPS.map(([name, items], i) =>
        h_flex().id(`grp-${i}`).h(30).flex_1().justify_center().items_center().rounded(7).text_size(16).cursor_pointer()
          .tooltip(name).when(i === this.group, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.group = i; if (/[a-z]/i.test(this.text)) { this.input.set_value(""); this.text = ""; } this.input.focus(); cx.notify(); })
          .child(items[0][0]))))
      .child(div().pt(6).pb(4).text_size(11).text_color(t.dim)
        .child(/[a-z]/i.test(this.text) ? `${list.length} found` : GROUPS[this.group][0]))
      // A plain scrolling column of rows: a group has at most a few hundred emoji.
      .child(v_flex().id(`grid-${this.group}`).flex_1().min_h(0).overflow_y_scroll()
        .children(Array.from({ length: rows }, (_, r) =>
          h_flex().h(CELL).flex_none().children(list.slice(r * PER_ROW, (r + 1) * PER_ROW).map((e, j) => this.cell(t, `e-${r}-${j}`, e))))))
      .child(h_flex().pt(12).gap(8).justify_end()
        .child(button("st-clear", "Clear", false, () => save("")))
        .child(button("st-save", "Save", true, () => save(this.text))));
  }
}
