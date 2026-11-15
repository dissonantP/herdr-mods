// The dialog for a new space (the `new-space` role), opened by the `spaces-grouped` sidebar's "+" buttons and Ctrl+Shift+N:
// its name and what runs in it (a plain terminal, or Claude with its session named after the space).
// props { machine, folder }. Enter makes the space, Esc makes none. The last kind picked is remembered.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme } from "herdr";

const KINDS = [["terminal", "Terminal"], ["claude", "Claude"]];

export default class NewSpace extends View {
  init(_props, cx) {
    this.text = "";
    try { this.kind = localStorage.getItem("kind") ?? "claude"; } catch { this.kind = "claude"; }
    this.input = InputState.new({ value: "" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  submit() {
    const p = props();
    const name = this.text.trim();
    try { localStorage.setItem("kind", this.kind); } catch {}
    closeOverlay(p.overlay);
    run("space.new", {
      machine: p.machine ?? "",
      ...(p.folder ? { folder: p.folder } : {}),
      ...(name ? { name } : {}),
      // The Claude session is named after the space, spaces as dashes ("bay area" -> "bay-area").
      ...(this.kind === "claude" ? { argv: name ? ["claude", "--name", name.replace(/\s+/g, "-")] : ["claude"] } : {}),
    });
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
  }

  render() {
    const t = theme();
    const p = props() ?? {};
    const label = (text) => div().pt(16).pb(7).text_size(11.5).text_color(t.dim).child(text);
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover(s => s.opacity(0.88)).on_click(action).child(text);
    const kind = ([k, text]) => h_flex().id(`ns-kind-${k}`).flex_1().h(32).justify_center().items_center().rounded(8)
      .border_1().border_color(this.kind === k ? t.accent : t.input).bg(this.kind === k ? t.hover : t.background)
      .text_color(this.kind === k ? t.foreground : t.dim).text_size(12.5).cursor_pointer()
      .on_click((_e, cx) => { this.kind = k; this.input.focus(); cx.notify(); }).child(text);
    return v_flex().id("new-space").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child("New space"))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(label("Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(div().pt(6).text_size(11.5).text_color(t.dim).child("Empty: Herdr picks the name."))
      .child(label("Runs"))
      .child(h_flex().gap(8).children(KINDS.map(kind)))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("ns-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("ns-create", "Create", true, () => this.submit())));
  }
}
