// Notepads, as one mod in roles (the way Herdr's win98 mod works). Each copy gets props { role };
// the layout places the panel with no role.
//   panel  the Notepads section of the sidebar: one tab per notepad file (panel.js, which explains the files)
//   menu   its pop-up menus: the header's "+" and a tab's right-click (menu.js)
// The panel opens the menu with openOverlay({ mod: "notepads", props: { role: "menu", ... } }).

import { View, div } from "gpui-kit";
import { props } from "herdr";
import Panel from "./panel.js";
import Menu from "./menu.js";

const ROLES = { panel: Panel, menu: Menu };

export default class NotepadsMod extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    const R = ROLES[pr.role ?? "panel"];
    this.role = R ? new R() : null;
    this.role?.init?.(pr, cx);
  }

  render(cx) {
    if (!this.role) return div().child(`notepads: no role "${props()?.role}"`);
    return this.role.render(cx);
  }
}
