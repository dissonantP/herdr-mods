// Ctrl+Shift+R (keys.json "session-keys.key-toggle"): wakes the focused pane's sleeping Claude
// session (or the last one started there, if a reboot killed it), or puts it to sleep when Claude is running there. The same as the pane menu's
// "Wake session" / "Sleep session" (pane-menu/session.py). Its own invisible 0 px block (in the
// status bar row), because a mod only gets keys while its block is shown, and the pane menu
// exists only while it's open. No timers.
import { View, div } from "gpui-kit";
import { focused, terminals, panes, exec, appHome, notify, nextCommand } from "herdr";

export default class SessionKeys extends View {
  init(_props, cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        cx.notify();
        if (c !== "key-toggle") continue;
        const address = focused()?.terminal;
        const term = address && terminals().find((t) => t.address === address);
        if (!term) { notify({ title: "No terminal focused", level: "info", timeout: 2000 }); continue; }
        // Not running Claude (Herdr keeps `app` after Claude exits and clears `status`): wake it,
        // from sleep.session or, after a reboot or crash, claude.session (see session.py).
        const p = panes().find((x) => x.terminal === address);
        const asleep = !(p?.app === "claude-code" && p?.status != null) && Boolean(term.labels?.["sleep.session"] || term.labels?.["claude.session"]);
        const where = term.labels?.where ?? address;
        notify({ title: asleep ? "Waking session" : "Putting session to sleep", body: where, level: "info", timeout: 2500 });
        await exec("python3", [`${appHome()}/mods/pane-menu/session.py`, asleep ? "wake" : "sleep", address], { timeout: 60000 }).catch(() => null);
      }
    });
  }

  render() {
    return div().id("session-keys").size_full();
  }
}
