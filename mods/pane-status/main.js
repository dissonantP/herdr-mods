// A copy of Herdr's `pane` header, plus a status: when the pane's terminal has the label
// `status`, the whole header turns into a coloured bar showing that text in bold (colour from
// `status.color`, one of COLORS; default red). Set it with
//   hc label <terminal> "status=Building the parts list" "status.color=blue"   (an agent: "$HC_TERMINAL_ID")
// or the pane right-click menu's "Set status…" (pane-menu opens this mod as a dialog, role
// "set"); clear it with "status=", the bar's ×, or "Clear status". No timers: render
// already re-runs whenever a terminal's labels change.
//
// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane-status" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { panes, props, run, theme, home, terminals, exec, closeOverlay } from "herdr";

const labelsOf = (terminal) => (terminal && terminals().find((t) => t.address === terminal)?.labels) || {};
const setStatus = (terminal, text, color) =>
  exec("hc", ["label", terminal, `status=${text}`, `status.color=${text ? color ?? "" : ""}`]).catch(() => null);

// The colours a status can have, by name (what agents write):
// blue working, yellow waiting for the user's answer, red blocked on the user, green done.
// Green is a fixed colour, not the theme's `done`, which is blue in some themes.
const COLORS = ["blue", "yellow", "red", "green"];
const colorOf = (t, name) =>
  ({ red: t.blocked, yellow: "#d9b54a", green: "#5cb85c", blue: t.ansi4 })[name] ?? t.blocked;

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init(_p, cx) {
    this.hovered = false;
    // Read the props with props(): init's first argument doesn't carry an overlay's props.
    const p = props();
    if (p?.role !== "set") return;
    // The "Set status…" dialog: Enter saves (empty clears), Esc cancels.
    const l = labelsOf(p.terminal);
    this.color = COLORS.includes(l["status.color"]) ? l["status.color"] : "red";
    this.input = InputState.new({ value: l.status ?? "", placeholder: "e.g. Restart computer" });
    this.input.on("submit", () => this.save());
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
  }

  save() {
    const p = props();
    setStatus(p.terminal, this.input.value().trim(), this.color);
    closeOverlay(p.overlay);
  }

  dialog() {
    const t = theme();
    return v_flex().id("status-set").size_full().p(16).gap(12).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Pane status"))
      .child(div().h(32).px(8).flex().items_center().rounded(6).border_1().border_color(t.input).child(Input.new(this.input).w_full()))
      .child(h_flex().gap(8).children(COLORS.map((c) =>
        div().id(`status-color-${c}`).size(20).rounded(10).cursor_pointer().bg(colorOf(t, c))
          .border_2().border_color(c === this.color ? t.foreground : t.popover)
          .on_click((_e, cx) => { this.color = c; this.input.focus(); cx.notify(); }))))
      .child(div().text_size(11.5).text_color(t.dim).child("Enter saves, empty clears, Esc cancels"));
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane-status/${icon}.svg`).size(14));
  }

  render(cx) {
    if (props()?.role === "set") return this.dialog();
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const terminal = props()?.terminal ?? p.terminal;
    const l = labelsOf(terminal);
    const status = l.status;
    if (status) {
      const pane = p.pane;
      return h_flex().id(`pane-status-${pane}`).size_full().px(10).gap(8).items_center()
        .bg(colorOf(t, l["status.color"])).text_color(t.background)
        .on_click(() => run("pane.focus", { pane }))
        .child(div().flex_1().truncate().text_size(15).font_bold().child(status))
        .child(div().id(`pane-status-x-${pane}`).px(6).rounded(4).text_size(14).font_bold().cursor_pointer()
          .hover((s) => s.bg(t.background + "33"))
          .on_click((_e, cx) => { cx.stop_propagation(); setStatus(terminal, ""); })
          .child("×"));
    }
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_t(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
