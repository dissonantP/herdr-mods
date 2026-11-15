// A grouped spaces sidebar, as one mod in roles (the way Herdr's win98 mod works).
// Each copy of this mod gets props { role }; the layout places the sidebar with no role.
//   sidebar    the spaces list with groups, colours, status badges and zoom (sidebar.js)
//   menu       a space's right-click menu: Herdr's items plus "Move to group…" and "Set status…" (menu.js)
//   groups     the dialog that moves a space into a group, or renames/deletes a group (groups.js)
//   status     the dialog that sets a space's emoji status badge (status.js)
//   new-space  the dialog for a new space's name and whether it runs a terminal or Claude (new-space.js)
// The sidebar opens the menu, groups and new-space roles with openOverlay({ mod: "spaces-grouped", props: { role } }),
// the menu opens groups and status, and the pane-menu mod opens groups for "Move to new space → New group…".

import { View, div } from "gpui-kit";
import { props } from "herdr";
import Sidebar from "./sidebar.js";
import Menu from "./menu.js";
import Groups from "./groups.js";
import Status from "./status.js";
import NewSpace from "./new-space.js";

const ROLES = { sidebar: Sidebar, menu: Menu, groups: Groups, status: Status, "new-space": NewSpace };

export default class SpacesGrouped extends View {
  init(p, cx) {
    const pr = props() ?? p ?? {};
    const R = ROLES[pr.role ?? "sidebar"];
    this.role = R ? new R() : null;
    this.role?.init?.(pr, cx);
  }

  render(cx) {
    if (!this.role) return div().child(`spaces-grouped: no role "${props()?.role}"`);
    return this.role.render(cx);
  }
}
