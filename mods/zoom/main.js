// Ctrl+plus/minus/0 (keys.json "zoom.key-in" / "zoom.key-out" / "zoom.key-reset"): zooms the panel
// under the mouse (the spaces-grouped sidebar, an md-review pane), else every terminal's font size.
// Its own invisible block (0 px, e.g. in the status bar row), so the keys work whatever else
// the layout hides: a mod only runs while its block is shown.
import { View, div } from "gpui-kit";
import { run, shared, setShared, nextCommand, readTextFile, writeTextFile, appHome, notify } from "herdr";

// The terminals' font size (settings.json font_size; Herdr's default is 14), one px a step.
async function terminalZoom(dir) {
  const path = `${appHome()}/settings.json`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await readTextFile(path);
    const s = raw ? JSON.parse(raw) : {};
    if (dir === "reset") delete s.font_size;
    else s.font_size = Math.min(36, Math.max(8, (s.font_size ?? 14) + (dir === "in" ? 1 : -1)));
    try { await writeTextFile(path, JSON.stringify(s, null, 2) + "\n", raw); return; } catch {}
  }
  notify({ title: "zoom", body: "Couldn't change the font size: settings.json kept changing", level: "error" });
}

export default class Zoom extends View {
  init(_props, cx) {
    // shared "zoom.hover" is saved across restarts; at start the mouse is over nothing yet, and a
    // panel that closed while under the mouse (a zoomed md-review) never said it left.
    setShared("zoom.hover", null);
    cx.spawn(async (cx) => {
      for (;;) {
        const m = /^key-(in|out|reset)$/.exec(await nextCommand());
        cx.notify();
        if (!m) continue;
        // shared "zoom.hover": the zoomable panel the mouse is over, set by those panels.
        const over = shared("zoom.hover");
        if (over === "spaces-grouped" || over === "md-review") run(`${over}.zoom-${m[1]}`);
        else await terminalZoom(m[1]);
      }
    });
  }

  render() {
    return div().id("zoom").size_full();
  }
}
