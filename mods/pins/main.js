// Pinned spaces: each pinned space keeps a section of the main area, showing every
// tab and pane of that space at once, beside the normal view of whichever space is
// selected in the sidebar. Only active in a layout that holds this mod's `pins-engine` block; switch to one without it
// to turn the whole feature off.
//
// One mod, two roles:
// - With no props (the `pins-engine` block in the layout): keeps the layout in step.
//   Every 800 ms it checks the pinned list (shared "pins.spaces"), each space's
//   shown tab, the arrangement, the selected space and the live panes. When any of
//   those changed, it reads each pinned space's pane trees from herdr-core's docs.json
//   (the same node format as layout files), copies them into the layout's `work-body`
//   row as sections, and runs layout.set.
// - With props.space (one per section): the section's header bar: a drag grip, the
//   space's name, its tabs (click one to show it), + for a new tab, − to minimize it to the
//   dock bar, and a pin to unpin.
// - With props.dock: the dock bar above the sections, one chip per minimized pinned space.
//   With props.main: the normal view's header bar, the same for the selected space, with a pin to pin it.
//
// The pin button on each sidebar row lives in spaces-grouped/main.js (`pinButton`).

import { View, div, svg } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, theme, shared, setShared, layout, home, readTextFile, exec, nextCommand, focused, notify, openOverlay, closeOverlay, machines, appHome, props as herdrProps } from "herdr";

const PREFIX = "pin-";
// Bump when the generated tree changes shape: a reloaded mod keeps its old state, so
// without this the engine wouldn't redraw until something else changed.
const BUILD = 20;
const DOCS = () => `${home()}/.local/state/herdr-core/default/docs.json`;
// A machine's spaces from its herdr-core docs.json: this computer's file here, another
// machine's read over its connection, with its ids given the "<machine>/" prefix
// they carry on this screen (its docs.json says "sp12", "p3", "t7"; here they're "pi/sp12"...).
const remoteHome = {};
async function docsOf(on) {
  if (!on) return JSON.parse(await readTextFile(DOCS()))["herdr-app"].value.spaces;
  remoteHome[on] ??= (await exec("sh", ["-c", 'printf %s "$HOME"'], { on })).stdout.trim();
  const sp = JSON.parse(await readTextFile(`${remoteHome[on]}/.local/state/herdr-core/default/docs.json`, { on }))["herdr-app"].value.spaces;
  const id = (x) => (x ? `${on}/${x}` : x);
  const node = (n) => ({ ...n, id: id(n.id),
    ...(n.content?.terminal ? { content: { ...n.content, terminal: id(n.content.terminal) } } : {}),
    ...(n.children ? { children: n.children.map(node) } : {}) });
  return sp.map((s) => ({ ...s, id: id(s.id), tabs: (s.tabs ?? []).map((t) => ({ ...t, id: id(t.id), root: node(t.root) })) }));
}

export const pinnedIds = () => shared("pins.spaces") ?? [];
// The space's colour as the sidebar picks it (spaces-grouped): its own pick, else its
// group's; "dim" means none, "inv:<key>" is the inverted style of <key>.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
function spaceColor(id, t) {
  if (!id) return null;
  const group = (shared("space.groups") ?? {}).of?.[id];
  const picked = (shared("space.color") ?? {})[id] ?? (group ? (shared("group.colors") ?? {})[group] : undefined);
  if (!picked || picked === "dim") return null;
  const c = picked.startsWith("inv:") ? picked.slice(4) : picked;
  return c.startsWith("#") ? c : MARK[c] ?? t[c] ?? null;
}

// The tab a pinned space shows: Herdr's own pick for that space (TabInfo.active).
const shownTab = (space) => spaces().find((s) => s.id === space)?.tabs.find((t) => t.active)?.id ?? null;

// tab.select and tab.new also switch to the tab's space, which would move a pinned
// space out of its section into the normal view; run them, then switch straight back.
function inPinned(space, command, args) {
  const back = spaces().find((x) => x.active)?.id;
  run(command, args);
  if (back && back !== space) run("space.select", { id: back });
}

// Minimized pinned spaces (shared "pins.minimized"): still pinned, but their section is
// hidden and they wait as a chip in the dock bar above the sections until restored.
export const minimizedIds = () => shared("pins.minimized") ?? [];
// A restored space moves to the right of the other pinned spaces (just before the normal
// view), the same spot a newly pinned space takes, so the order follows what you did last.
export function setMinimized(space, on) {
  const was = minimizedIds().includes(space);
  const list = minimizedIds().filter((s) => s !== space);
  setShared("pins.minimized", on ? [...list, space] : list);
  if (!on && was) moveToEnd(space);
}

export function togglePin(space) {
  const list = pinnedIds();
  setShared("pins.spaces", list.includes(space) ? list.filter((s) => s !== space) : [...list, space]);
}

// Dock a space: pin it if it isn't, minimize it to the dock bar, and when it's the selected
// space, select the first pinned space still showing, so it leaves the view. The header's
// double-click and − button, and the dock key (pins.key-dock), all come here.
// Selected spaces, most recent first: the engine's copy, shared here (a mod file's top runs
// once for all its copies) so the header's dock button sees it too.
let recentSelected = [];
export function dockSpace(space) {
  if (!space) return;
  // A pinned section's space: give the keyboard to the normal view first, as the hide key does,
  // so Herdr doesn't follow the section's focused pane and select that space as it goes.
  if (space !== spaces().find((s) => s.active)?.id) {
    focusNormalView();
    if (!pinnedIds().includes(space)) togglePin(space);
    setMinimized(space, true);
    return;
  }
  if (!pinnedIds().includes(space)) togglePin(space);
  setMinimized(space, true);
  // Same choice as the hide key (Ctrl+Shift+M): a pinned space still on screen, most recently
  // selected first, fills the normal view, so no space that wasn't showing appears.
  const next = previousSpace(space, recentSelected);
  if (next) run("space.select", { id: next });
}

// What the normal view shows once `space` leaves it. Herdr always shows a selected space, so
// pick a pinned space still showing: selected, it fills the normal view and its own section
// steps aside, so no new space appears on screen. With none, the space selected before
// `space` (recent: selected ids, most recent first, kept by the engine's sync).
function previousSpace(space, recent = []) {
  const ids = spaces().map((s) => s.id);
  const pinned = pinnedIds().filter((id) => id !== space && ids.includes(id) && !minimizedIds().includes(id));
  return recent.find((id) => pinned.includes(id)) ?? pinned[0]
    ?? recent.find((id) => id !== space && ids.includes(id)) ?? ids.find((id) => id !== space);
}

// Give the keyboard to the normal view (a pane of the selected space's shown tab), so a
// pinned section can go away without Herdr following its focused pane to that space.
function focusNormalView() {
  const s = spaces().find((x) => x.active);
  const tab = s?.tabs.find((t) => t.active)?.id;
  const terminal = panes().find((p) => p.tab === tab && p.terminal)?.terminal;
  if (terminal) run("pane.focus", { terminal });
}

// The pin key (pins.key-toggle-active) swaps a space between the normal view and a pinned section:
// - the selected space gets pinned (if it isn't) and the normal view goes back to the space
//   selected before it, so it moves into its own section;
// - a pinned section's space gets unpinned and selected, so it moves into the normal view.
// The terminal to give the keyboard back to once the next layout is drawn (swapPinned moves a
// space without hiding it, so its focused pane keeps the keyboard). Dropped after a few seconds.
let refocus = null;
function refocusNow() {
  if (!refocus) return;
  const { terminal, until } = refocus;
  refocus = null;
  if (Date.now() < until) run("pane.focus", { terminal });
}

export function swapPinned(space, recent) {
  if (!space) return;
  const f = focused();
  if (f?.terminal) refocus = { terminal: f.terminal, until: Date.now() + 4000 };
  if (space === spaces().find((s) => s.active)?.id) {
    if (!pinnedIds().includes(space)) togglePin(space);
    setMinimized(space, false);
    const back = previousSpace(space, recent);
    if (back) run("space.select", { id: back });
    return;
  }
  togglePin(space);
  run("space.select", { id: space });
}

// Take a space off screen (pins.key-hide): unpin it if it's pinned, and when it's the selected
// space, go back to the space selected before it. It keeps running and stays in the sidebar.
export function hideSpace(space, recent) {
  if (!space) return;
  if (space !== spaces().find((s) => s.active)?.id) {
    focusNormalView();
    if (pinnedIds().includes(space)) togglePin(space);
    return;
  }
  if (pinnedIds().includes(space)) togglePin(space);
  const back = previousSpace(space, recent);
  if (back) run("space.select", { id: back });
}

// Commands for scripts and agents: herdr-app do 'pins.<verb>:<json>' (needs a layout with
// this mod's pins-engine block on screen). Spaces by id or name.
//   pin       {space, pinned}            pinned false unpins; left out: pins
//   minimize  {space, minimized}         shrink a pinned space to a chip in the dock bar, or restore it
//   place     {space, beside, side}      move a pinned space's section next to another pinned space
//                                        (or "main", the normal view); side: left, right, top,
//                                        bottom, or swap (trade places)
// Errors are posted as a notification.
function pinCommand(c) {
  const m = /^(pin|minimize|place):([\s\S]*)$/.exec(c);
  if (!m) return;
  const fail = (msg) => { try { notify({ title: "pins command", body: msg, level: "error" }); } catch {} };
  let a;
  try { a = JSON.parse(m[2]); } catch { return fail(`${m[1]}: the part after ":" isn't JSON`); }
  const find = (ref) => ref === "main" ? "main" : (spaces().find((s) => s.id === ref) ?? spaces().find((s) => s.name === ref))?.id;
  const space = find(a.space);
  if (!space || space === "main") return fail(`${m[1]}: no space "${a.space}"`);
  const pinned = pinnedIds().includes(space);
  if (m[1] === "pin") {
    if ((a.pinned !== false) !== pinned) togglePin(space);
  } else if (m[1] === "minimize") {
    if (!pinned) return fail("minimize: that space isn't pinned");
    setMinimized(space, a.minimized !== false);
  } else {
    const beside = find(a.beside);
    if (!pinned || !beside || (beside !== "main" && !pinnedIds().includes(beside))) return fail("place: both spaces must be pinned (or beside \"main\")");
    if (!["left", "right", "top", "bottom", "swap"].includes(a.side)) return fail("place: side must be left, right, top, bottom or swap");
    dropLeaf(space, beside, a.side, true);
  }
}

function dbg(line) {
  exec("sh", ["-c", 'echo "$1" >> "$2"', "sh", `${new Date().toISOString()} ${line}`, `${home()}/.config/herdr-app/mods/pins/.debug`]);
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// A tab's pane tree from docs.json, as layout nodes: ids prefixed (so they never clash
// with the normal view's), and each pane framed like the normal view frames its panes.
function copyTree(n) {
  const out = { id: PREFIX + n.id, type: n.type };
  if (n.size) out.size = n.size;
  if (n.type === "block") {
    // A frame with a pane title bar (pane-status: Herdr's `pane` mod plus a status bar) on top. Its split
    // and close buttons pass the real pane id, so they act on the space's own panes;
    // the engine then sees the new pane and redraws the section.
    out.type = "column";
    out.background = "background";
    out.border = { width: 1, color: "border" };
    out.focus = { border: { width: 1, color: "accent" } };
    out.radius = 10;
    // The header sits under the terminal, like the normal view's (its pane header position "bottom").
    out.children = [
      { id: `${PREFIX}${n.id}-view`, type: "block", content: n.content },
      { id: `${PREFIX}${n.id}-head`, type: "block", size: { px: 30 },
        content: { mod: "pane-status", props: { pane: n.id, terminal: n.content?.terminal ?? null } } },
    ];
  } else {
    out.gap = 8;
    out.children = (n.children ?? []).map(copyTree);
  }
  return out;
}

function terminalsIn(n, acc = new Set()) {
  if (n.content?.terminal) acc.add(n.content.terminal);
  for (const c of n.children ?? []) terminalsIn(c, acc);
  return acc;
}

// Pane keys while pinning is on (a keys.json "layout:<name>" section sends these here).
// Herdr's own pane.split/pane.close without a pane id fail while a pinned pane has the
// keyboard (it's a layout block, not the tab's pane), so look up the real pane and
// pass its id. In the normal view, the plain command runs as usual.
const PANE_KEYS = {
  "split-right": ["pane.split", { direction: "right" }],
  "split-down": ["pane.split", { direction: "down" }],
  "close": ["pane.close", {}],
};
function paneKey(command, args) {
  const f = focused();
  if (f?.pane || !f?.terminal) { run(command, args); return; }
  const pane = panes().find((p) => p.terminal === f.terminal)?.pane;
  if (pane) run(command, { ...args, pane });
}

// The close-tab key while pinning is on. Herdr's tab.close with no id closes the shown tab
// of the selected space, even while a pinned pane has the keyboard, so it closed (or asked to
// close the space of) the wrong one. Pass the tab of the focused pane instead.
function closeTabKey() {
  const f = focused();
  if (f?.pane || !f?.terminal) { run("tab.close", {}); return; }
  const tab = panes().find((p) => p.terminal === f.terminal)?.tab;
  if (tab) run("tab.close", { id: tab });
}

// The space holding the focused pane. focused().space is the selected space even while a
// pinned section's terminal (a layout block) has the keyboard, so find that terminal's space.
function focusedSpace() {
  const f = focused();
  if (!f) return spaces().find((s) => s.active)?.id;
  if (!f.pane && f.terminal) {
    const tab = panes().find((p) => p.terminal === f.terminal)?.tab;
    const s = tab && spaces().find((x) => x.tabs.some((t) => t.id === tab));
    if (s) return s.id;
  }
  return f.space;
}

// A mod pane's block content ({mod, props}) from Herdr's saved layout (docs.json), or null.
async function modContent(pane) {
  try {
    const d = JSON.parse((await readTextFile(`${home()}/.local/state/herdr-core/default/docs.json`)) ?? "{}")["herdr-app"]?.value;
    const walk = (n) => n?.id === pane ? n : (n?.children ?? []).map(walk).find(Boolean);
    for (const s of d?.spaces ?? []) for (const t of s.tabs ?? []) {
      const n = walk(t.root);
      if (n?.content?.mod) return n.content;
    }
  } catch {}
  return null;
}

export default class Pins extends View {
  init(props, cx) {
    this.space = props?.space ?? herdrProps()?.space ?? null;
    this.tabScroll = ScrollHandle.new(); // the header's tab row (see tabRow)
    this.zoomOf = herdrProps()?.zoom ?? null;
    // Only the engine block (no props) runs the timer and the key loop; header and
    // zoom-bar copies don't. (The normal view's header once ran them too: keys ran twice.)
    if (this.space || this.zoomOf || herdrProps()?.main || herdrProps()?.dock || herdrProps()?.spacer) return;
    this.sig = null;
    // settings.json "pin_spaces" (Mod settings' "Always pin spaces"), read once here; the
    // settings dialog publishes later changes in shared "settings.extra".
    cx.spawn(async () => {
      try {
        const st = JSON.parse((await readTextFile(`${appHome()}/settings.json`)) ?? "{}");
        this.pinNewFile = st.pin_spaces === true;
        this.sideMachineFile = st.sidebar_machine ?? null;
      } catch {}
    });
    cx.timer.every(800, (cx) => this.sync(cx));
    // `herdr-app do pins.key-toggle-active` (Ctrl+Shift+P in keys.json): swap the focused space between
    // the normal view and a pinned section (swapPinned). pins.key-hide (Ctrl+Shift+M): hideSpace.
    // The loop touches its cx after each command: when this file is saved, Herdr stops
    // the old build's tasks at their next cx use, so an old copy can't handle keys too.
    // (Before this, saved builds kept their loops alive and each key ran twice: the zoom
    // opened and the old loop closed it again.) Commands are named key-*; the old loops
    // don't know those names.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = (await nextCommand()).replace(/^key-/, "");
        cx.notify();
        const active = spaces().find((s) => s.active)?.id;
        // Swap the space holding the focused pane between the normal view and a pinned section.
        if (c === "toggle-active") swapPinned(focusedSpace() ?? active, this.recent);
        // Dock the space holding the focused pane (a pinned section or the normal view).
        if (c === "dock") dockSpace(focusedSpace() ?? active);
        // Take the space holding the focused pane off screen (unpin it, leave it if selected).
        if (c === "hide") hideSpace(focusedSpace() ?? active, this.recent);
        if (c === "rebuild") { this.sig = null; this.force = true; }
        if (c === "ping") dbg("ping");
        if (PANE_KEYS[c]) paneKey(...PANE_KEYS[c]);
        if (c === "close-tab") closeTabKey();
        if (c === "zoom") await this.zoom();
        if (c === "pane-zoom") this.paneZoom();
        pinCommand(c);
      }
    });
  }

  // The zoom key (a keys.json "layout:<name>" section): the focused terminal pane opens
  // in a dialog over nearly the whole window, with a bar on top (the `pins` mod with
  // props.zoom) to close it; the zoom key closes it too (Esc goes to the terminal, as agents need it). The terminal is the
  // same one, shown in a second place, so nothing restarts.
  async zoom() {
    // shared "pins.zoomed": the open zoom dialog, cleared by its bar's close() however it
    // closes (its button, this key), so the key never needs pressing twice.
    const open = shared("pins.zoomed");
    if (open) { closeOverlay(open); setShared("pins.zoomed", null); return; }
    // A markdown pane under the mouse opens over the whole window (md-review records its file
    // in shared "md-review.hover"), whatever pane has the keyboard.
    const hovered = shared("zoom.hover") === "md-review" && shared("md-review.hover");
    if (hovered) { this.openZoom(hovered, { mod: "md-review", props: { file: hovered } }); return; }
    const f = focused();
    // Any terminal pane, pinned or in the normal view, opens over the whole window, since
    // Herdr's own zoom only fills the normal view and leaves the pinned sections showing.
    // A mod pane (md-review) opens the same way: a second copy of the mod with the pane's
    // props, read from Herdr's saved layout (panes() doesn't give a mod pane's props).
    if (!f?.terminal) {
      const p = f?.pane && panes().find((x) => x.pane === f.pane);
      const content = p?.mod ? await modContent(p.pane) : null;
      if (!content) { run("pane.zoom", {}); return; }
      this.openZoom(p.pane, content);
      return;
    }
    const terminal = f.terminal;
    this.openZoom(terminal, { terminal });
    run("pane.focus", { terminal });
  }

  // The zoom dialog: the bar (this mod with props.zoom: the terminal or mod pane id) over `content`.
  openZoom(of, content) {
    const id = openOverlay({
      kind: "dialog", width: 0.98, height: 0.96,
      layout: { id: "pins-zoom", type: "column", children: [
        { id: "pins-zoom-bar", type: "block", size: { px: 30 }, content: { mod: "pins", props: { zoom: of } } },
        { id: "pins-zoom-view", type: "block", content },
        // The pane's own header (pane-status) under it, so its status bar shows while zoomed too.
        ...(content.terminal ? [{ id: "pins-zoom-head", type: "block", size: { px: 30 },
          content: { mod: "pane-status", props: { pane: panes().find((p) => p.terminal === content.terminal)?.pane ?? null, terminal: content.terminal } } }] : []),
      ] },
    });
    setShared("pins.zoomed", id);
  }

  // Herdr's zoom key, made to work in pinned sections: a pane there (a layout block, so
  // Herdr's own pane.zoom fails) toggles showing alone within its section, nothing else
  // changes. In the normal view (or a mod pane) it's Herdr's own zoom.
  paneZoom() {
    const f = focused();
    if (f?.pane || !f?.terminal) { run("pane.zoom", {}); return; }
    const p = panes().find((x) => x.terminal === f.terminal);
    if (!p) return;
    this.sectionZoom ??= {};
    if (this.sectionZoom[p.tab]) delete this.sectionZoom[p.tab];
    else if (panes().filter((x) => x.tab === p.tab).length > 1) this.sectionZoom[p.tab] = p.pane;
    else return;
    this.sig = null;
    run("pane.focus", { terminal: f.terminal });
  }

  async close() {
    if (this.zoomOf) setShared("pins.zoomed", null);
  }

  // "Always pin spaces" on: a space that gets selected (opened from the sidebar, or new) is
  // pinned at once, the way the pin key (Ctrl+Shift+P) does it, and the normal view goes back
  // to the space shown before. A space that appears while its machine is connected is new and
  // is pinned too. Spaces seen on the first sync, or appearing because their machine just
  // connected, are only remembered.
  pinNewSpaces(sp, ready) {
    const extra = shared("settings.extra");
    const on = extra && "pin_spaces" in extra ? extra.pin_spaces === true : this.pinNewFile === true;
    const machineOf = (id) => (id.includes("/") ? id.split("/")[0] : "");
    // A window that shows one computer's spaces (Mod settings' "Only show spaces from") pins
    // only that computer's: "this computer" is "", a machine name is itself.
    const sm = String((extra && "sidebar_machine" in extra ? extra.sidebar_machine : this.sideMachineFile) ?? "").trim();
    const mine = (id) => !sm || machineOf(id) === (/^(this computer|this|local|here)$/i.test(sm) ? "" : sm);
    const first = !this.seenSpaces;
    this.seenSpaces ??= new Set();
    for (const s of sp) {
      if (this.seenSpaces.has(s.id)) continue;
      this.seenSpaces.add(s.id);
      // The selected one is pinned below, which also gives the normal view back.
      if (!first && on && mine(s.id) && !s.active && this.readyBefore?.has(machineOf(s.id)) && !pinnedIds().includes(s.id)) togglePin(s.id);
    }
    this.readyBefore = ready;
    const active = sp.find((s) => s.active)?.id ?? null;
    // Like swapPinned, but without its refocus: the keyboard is already on the opened space's
    // pane, and focusing it again made Herdr select that space again.
    // The space shown before goes back into the normal view, even when it's minimized (it was on
    // screen, being the selected one); choosing another pinned space instead made it vanish into
    // the dock. When the space shown before was closed, Herdr picked the new one itself: nothing
    // is pinned then.
    const prev = this.lastActive;
    const prevThere = Boolean(prev) && sp.some((s) => s.id === prev);
    // A pinned space shown from the dock (Cmd+E, the sidebar) comes back as its own section.
    const fromDock = pinnedIds().includes(active) && minimizedIds().includes(active);
    if (!first && on && active && mine(active) && active !== prev && (prevThere || !prev) && (!pinnedIds().includes(active) || fromDock)) {
      if (fromDock) setMinimized(active, false);
      else togglePin(active);
      const back = prevThere ? prev : previousSpace(active, this.recent);
      if (back) {
        run("space.select", { id: back });
        // The keyboard is still in the new space's pane, now a pinned section, and Herdr selects
        // the space whose pane has the keyboard: give it to the space shown before. Herdr also
        // drops a space.select sent right after it switched spaces itself, so both go again a
        // moment later through the CLI.
        const tab = spaces().find((x) => x.id === back)?.tabs.find((t) => t.active)?.id;
        const term = (tab && panes().find((p) => p.tab === tab && p.terminal)?.terminal) || "";
        exec("sh", ["-c", 'sleep 0.5; herdr-app do space.select --id "$1"; [ -n "$2" ] && herdr-app do pane.focus --terminal "$2"', "sh", back, term]).catch(() => null);
      }
    }
    this.lastActive = active;
  }

  sync(cx) {
    if (!find(layout(), "pins-engine")) return;
    const sp = spaces();
    if (sp.length === 0) return; // a reload can briefly see no spaces
    const ids = new Set(sp.map((s) => s.id));
    // Another machine's spaces only appear once it connects (after a restart, or while it's
    // offline), so a pin is forgotten only when its machine is connected and the space is gone.
    // Until then it's kept, just not drawn.
    const ready = new Set(machines().filter((m) => m.layout === "ready").map((m) => m.name ?? ""));
    const gone = (id) => !ids.has(id) && ready.has(id.includes("/") ? id.split("/")[0] : "");
    this.pinNewSpaces(sp, ready);
    const keptPins = pinnedIds().filter((id) => !gone(id));
    if (keptPins.length !== pinnedIds().length) setShared("pins.spaces", keptPins);
    const keptMin = minimizedIds().filter((id) => keptPins.includes(id));
    if (keptMin.length !== minimizedIds().length) setShared("pins.minimized", keptMin);
    const pins = keptPins.filter((id) => ids.has(id));
    const minimized = keptMin.filter((id) => pins.includes(id));
    let active = sp.find((s) => s.active)?.id ?? null;
    // Selected spaces, most recent first, for the hide key to go back to.
    if (active && this.recent?.[0] !== active) this.recent = [active, ...(this.recent ?? []).filter((id) => id !== active && ids.has(id))].slice(0, 20);
    recentSelected = this.recent ?? [];
    // When the selected space is closed, Herdr selects a neighbour in the sidebar, which
    // would take the normal view. Select a pinned space instead, so the pinned spaces
    // fill the area: the selected one shows in the normal view and its section steps aside.
    const closed = this.lastActive && !ids.has(this.lastActive);
    this.lastActive = active;
    if (closed && pins.length && !pins.includes(active)) {
      active = pins[0];
      this.lastActive = active;
      run("space.select", { id: active });
    }
    const ps = panes();
    const sig = JSON.stringify([BUILD, pins, minimized, pins.map(shownTab), shared("pins.arrange") ?? null, active, ps.map((p) => [p.pane, p.tab, p.terminal]), this.sectionZoom ?? {}]);
    // Herdr sometimes drops a layout.set sent right after a space switch (the section
    // of the space you just left never appears). Check that the last tree took, else redo it.
    if (sig === this.sig && this.want) {
      const body = find(layout(), "work-body");
      if (body && JSON.stringify(body.children.filter(ours).map(strip)) + workShape(layout()) !== this.want) this.sig = null;
    }
    if (sig === this.sig) return;
    if (this.build !== BUILD) { this.build = BUILD; this.force = true; }
    this.sig = sig;
    cx.spawn(async () => {
      const docs = [];
      try {
        for (const on of new Set(pins.map((id) => sp.find((s) => s.id === id)?.machine ?? null))) docs.push(...await docsOf(on));
      } catch { this.sig = null; return; }
      const sectionOf = {};
      // The selected space shows in the normal view, with real splits and keys, so its
      // section steps aside rather than show it twice; it comes back when you leave it.
      // A minimized space has no section (selected, it still shows in the normal view).
      const hidden = new Set(minimized.filter((id) => id !== active));
      const shown = pins.filter((id) => id !== active && !hidden.has(id));
      for (const id of shown) {
        const space = docs.find((s) => s.id === id);
        if (!space) { this.sig = null; return; } // docs.json not written yet: try next tick
        // docs.json can lag the live panes for a moment; retry until it has them all.
        // Like a space in the normal view, a section shows one tab: the one the space shows
        // (switched from the tab names in its header bar).
        const tab = space.tabs.find((t) => t.id === shownTab(id)) ?? space.tabs[0];
        const want = new Set(ps.filter((p) => p.terminal && p.tab === tab.id).map((p) => p.terminal));
        const have = terminalsIn(tab.root);
        if ([...want].some((t) => !have.has(t))) this.sig = null;
        // A pane zoomed inside its section (the zoom key, pane-zoom): the section shows only it.
        const zoomedLeaf = this.sectionZoom?.[tab.id] ? find(tab.root, this.sectionZoom[tab.id]) : null;
        if (this.sectionZoom?.[tab.id] && !zoomedLeaf) delete this.sectionZoom[tab.id];
        sectionOf[id] = {
          id: PREFIX + id, type: "column", size: { weight: 1 }, min: 220,
          background: "surface", radius: 12, padding: 6, gap: 6,
          children: [
            { id: `${PREFIX}${id}-head`, type: "block", size: { px: 32 }, content: { mod: "pins", props: { space: id } } },
            { id: `${PREFIX}${id}-body`, type: "column", children: [copyTree(zoomedLeaf ?? tab.root)] },
          ],
        };
      }
      const l = layout();
      const body = find(l, "work-body");
      const main = find(l, "main");
      if (!body || !main) return;
      // The normal view is never hidden: hiding it (layout.hide) right before layout.set
      // lost the new tree and left the window empty. Older builds left it hidden: undo that once.
      if (main.hidden) { delete main.hidden; this.force = true; run("layout.show", { id: "main" }); }
      // The pinned sections and the normal view, arranged as shared "pins.arrange" says
      // (dragged by their header bars). The normal view always gets a header bar too, so
      // it can be dragged and dropped on like the others, and its pin pins the selected space.
      const { size: mainSize, ...mainRest } = main;
      const mainLeaf = {
        id: `${PREFIX}main`, type: "column", size: mainSize ?? { weight: 1 }, min: 220, gap: 6,
        // A selected pinned space keeps its section's frame, so its header lines up with the others'.
        ...(pins.includes(active) ? { background: "surface", radius: 12, padding: 6 } : {}),
        children: [
          { id: `${PREFIX}main-head`, type: "block", size: { px: 32 }, content: { mod: "pins", props: { main: true } } },
          mainRest,
        ],
      };
      // A selected pinned space shows in the normal view, in its own section's spot and
      // with its own header (pin button, no "selected space"), so selecting it doesn't move it.
      // Minimized spaces keep their spot in "pins.arrange"; only this drawing leaves them out.
      let tree = arrangement(pins);
      if (hidden.size) tree = prune(tree, new Set([...leavesOf(tree)].filter((x) => !hidden.has(x)))) ?? "main";
      if (typeof tree === "string") tree = { type: "row", children: [tree] };
      if (active && pins.includes(active)) {
        const swapIn = (n) => (typeof n === "string" ? (n === active ? "main" : n) : { type: n.type, children: n.children.map(swapIn) });
        tree = swapIn(prune(tree, new Set([...leavesOf(tree)].filter((x) => x !== "main"))));
      }
      const sections = toNodes(tree, (leaf) => (leaf === "main" ? mainLeaf : sectionOf[leaf] ?? null), "root");
      // With any space minimized, the dock bar sits above the sections, listing them.
      const root = sections;
      const kept = body.children.filter((c) => !ours(c) && c.id !== "main");
      const nextChildren = [root, ...kept];
      // With any space minimized, the dock bar sits flush under the tab bar, full width, and
      // the sections flush under it: the work area drops its 8px top and bottom padding, and an
      // 8px spacer under it puts the bottom gap back.
      const work = find(l, "work");
      if (!work) return;
      const dockOn = minimized.length > 0;
      const nextWork = work.children.filter((c) => !ours(c));
      if (dockOn) {
        nextWork.splice(nextWork.findIndex((c) => c.id === "tabs") + 1, 0,
          { id: `${PREFIX}dock`, type: "block", size: { px: 32 }, content: { mod: "pins", props: { dock: true } } });
        nextWork.splice(nextWork.findIndex((c) => c.id === "work-body") + 1, 0,
          { id: `${PREFIX}dock-space`, type: "block", size: { px: 8 }, content: { mod: "pins", props: { spacer: true } } });
      }
      const nextPadding = dockOn ? [0, 8] : 8;
      const want = JSON.stringify(nextChildren.filter(ours).map(strip)) + JSON.stringify([nextWork.map((c) => c.id), nextPadding]);
      if (JSON.stringify(nextChildren.map(strip)) === JSON.stringify(body.children.map(strip))
        && JSON.stringify([nextWork.map((c) => c.id), nextPadding]) === workShape(l) && !this.force) { this.want = want; refocusNow(); return; }
      this.force = false;
      work.children = nextWork;
      body.padding = nextPadding;
      body.children = nextChildren;
      this.want = want;
      // Through the CLI: the same layout.set run from inside the mod was dropped every
      // time for some trees (re-adding a section), while `herdr-app do` applies it.
      await exec("herdr-app", ["do", "layout.set", JSON.stringify({ layout: l })]).catch(() => null);
      refocusNow();
    });
  }

  // A header's tabs, scrolling sideways when they don't fit (see render).
  tabRow(s, pill) {
    const tabs = s?.tabs ?? [];
    const active = tabs.findIndex((x) => x.active);
    // A copy reloaded after an edit may not have run init again: plain row until it's recreated.
    if (!this.tabScroll) return h_flex().min_w(0).gap(2).overflow_hidden().children(tabs.map(pill));
    // Brings the shown tab into view only when it (or the space, or the tab count) changes.
    const key = `${s?.id}:${active}:${tabs.length}`;
    if (key !== this.tabScrollKey && active >= 0) { this.tabScrollKey = key; this.tabScroll.scroll_to_item(active); }
    // The wheel and trackpad scroll the row itself (no tab switching: selecting a pinned
    // space's tab briefly selects that space, which made scrolling jump).
    return h_flex().id("pin-tabs").min_w(0).h_full().items_center().gap(2).overflow_x_scrollbar().track_scroll(this.tabScroll)
      .children(tabs.map(pill));
  }

  // The bar over a zoomed pinned pane: which space and pane it is, and a close button.
  zoomBar() {
    const t = theme();
    const p = panes().find((x) => x.terminal === this.zoomOf || x.pane === this.zoomOf);
    const space = spaces().find((s) => s.tabs.some((c) => c.id === p?.tab));
    return h_flex().size_full().px(10).gap(8).items_center().text_size(12.5).bg(t.surface).border_b(1).border_color(t.border)
      .child(svg("mods/workspace-chrome/pin.svg").size(13).text_color(t.accent))
      .child(div().font_bold().text_color(t.foreground).child(space?.name ?? ""))
      .child(div().truncate().text_color(t.dim).child(p?.title ?? String(this.zoomOf ?? "").split(/[\\/]/).pop()))
      .child(div().flex_1())
      .child(div().text_color(t.dim).child("Ctrl+Shift+Z to close"))
      .child(h_flex().id("pins-zoom-close").size(22).items_center().justify_center().rounded(6).text_color(t.muted)
        .hover((st) => st.bg(t.hover).text_color(t.foreground))
        .on_click(() => closeOverlay(herdrProps()?.overlay))
        .child(svg("mods/pane/close.svg").size(14)));
  }

  render(cx) {
    // The engine also syncs on every redraw (live data changed), since a mod reloaded
    // after an edit keeps running without its init's timer.
    if (this.zoomOf) return this.zoomBar();
    if (herdrProps()?.dock) return this.dockBar();
    if (herdrProps()?.spacer) return div();
    // The normal view's header, when it shows a pinned space, acts as that space's header
    // (its drag and drop move the pinned section's spot, see sync()).
    const activeId = spaces().find((x) => x.active)?.id;
    const leaf = this.space ?? (herdrProps()?.main ? (pinnedIds().includes(activeId) ? activeId : "main") : null);
    if (!leaf) { this.sync(cx); return div(); }
    const t = theme();
    const drag = shared("pins.drag");
    if (drag && drag !== leaf) return this.dropBar(t, drag, leaf);
    const bar = h_flex().size_full().px(6).gap(6).items_center().text_size(12.5).text_color(t.foreground);
    if (drag === leaf) {
      return bar.bg(t.selected).rounded(6)
        .child(div().font_bold().child(`Moving ${leafName(leaf)}`))
        .child(div().text_color(t.dim).truncate().child("release on, or click, a spot in another header bar"))
        .child(div().flex_1())
        .child(this.textButton(t, "pin-cancel", "Cancel", () => setShared("pins.drag", null)));
    }
    // The grip: press it to pick this block up (shared "pins.drag").
    const grip = div().id("pin-grip").px(2).text_size(14).text_color(t.dim).hover((st) => st.text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); setShared("pins.drag", leaf); })
      .child("⠿");
    // The normal view's bar shows the selected space the same way, with a dim pin to pin it.
    const s = leaf === "main" ? spaces().find((x) => x.active) : spaces().find((x) => x.id === leaf);
    const btn = (id, icon, onClick, label, color) => h_flex().id(id).size(22).flex_none().items_center().justify_center()
      .rounded(6).text_color(color ?? t.muted).hover((st) => st.bg(t.hover).text_color(color ?? t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(); })
      .child(icon ? svg(icon).size(14) : div().text_size(13).child(label));
    // The space's tabs as names, like the tab bar: click one to show it in this section.
    const pill = (tab) => div().id(`pin-tabpill-${tab.id}`).px(8).h(22).flex_none().flex().items_center().rounded(6)
      .when(tab.active, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!tab.active, (el) => el.text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); inPinned(s.id, "tab.select", { id: tab.id }); }))
      .child(tab.name);
    // Minimize: the space stays pinned but its section goes to the dock bar (see dockSpace).
    const minimize = () => dockSpace(s.id);
    return bar.child(grip)
      // The name, larger, after a bar in the space's sidebar colour, so the section is
      // easy to place at a glance.
      .when(Boolean(spaceColor(s?.id, t)), (el) => el.child(div().w(4).h(18).flex_none().rounded(2).bg(spaceColor(s?.id, t))))
      // Double-click the name of a pinned space to minimize it, the same as its − button.
      // On the selected space's bar (not pinned), double-click pins it and docks it at once.
      .child(div().id("pin-name").flex_none().max_w(260).truncate().font_bold().text_size(15)
        .when(Boolean(s), (el) => el.on_click((e, cx) => {
          if (e.click_count !== 2) return;
          cx.stop_propagation();
          minimize();
        }))
        .child(s?.name ?? "(gone)"))
      // More tabs than fit scroll sideways (wheel, trackpad or scrollbar); the shown tab stays in view.
      .child(this.tabRow(s, pill))
      .child(btn("pin-tab", "mods/workspace-chrome/plus.svg", () => inPinned(s.id, "tab.new", { space: s.id })))
      .child(div().flex_1())
      .child(leaf === "main" ? h_flex().gap(4).items_center().child(div().text_color(t.dim).child("selected space"))
        // Minimize, a down arrow after "selected space": Herdr always has a selected space,
        // so "unselecting" it selects the first pinned one instead, and the pinned spaces
        // fill the area (the same as closing the selected space, see sync()). Only for a
        // space that isn't pinned.
        .when(Boolean(s) && pinnedIds().length > 0 && !pinnedIds().includes(s?.id), (el) =>
          el.child(btn("pin-minimize", "mods/workspace-chrome/chevron-down.svg", () => run("space.select", { id: pinnedIds()[0] }))))
        // A dim pin, like the sidebar's for an unpinned space: click to pin the selected space.
        .when(Boolean(s), (el) => el.child(btn("pin-on", "mods/workspace-chrome/pin.svg", () => togglePin(s.id))))
        : h_flex().gap(2).items_center()
          .child(btn("pin-min", "mods/workspace-chrome/minus.svg", minimize))
          // A plain pin in the accent colour, like the sidebar's: click to unpin.
          .child(btn("pin-off", "mods/workspace-chrome/pin.svg", () => togglePin(s.id), null, t.accent)));
  }

  // The dock bar over the sections: one chip per minimized pinned space, in its sidebar
  // colour, with the sidebar's status mark. Click a chip to show the space's section again.
  dockBar() {
    const t = theme();
    const chip = (id) => {
      const s = spaces().find((x) => x.id === id);
      const color = spaceColor(id, t);
      const status = s?.status;
      // Done (finished while you weren't looking) or blocked (waits for you): bold name and a dot.
      const wants = status === "done" || status === "blocked";
      return h_flex().id(`pin-dock-${id}`).h(22).px(8).gap(6).flex_none().items_center().rounded(6)
        .bg(t.hover).text_color(t.foreground).hover((st) => st.bg(t.selected))
        .on_click((_e, cx) => { cx.stop_propagation(); setMinimized(id, false); })
        .when(Boolean(color), (el) => el.child(div().w(4).h(14).flex_none().rounded(2).bg(color)))
        .child(div().max_w(220).truncate().when(wants, (n) => n.font_bold()).child(s?.name ?? "(gone)"))
        .when(wants, (el) => el.child(
          div().size(9).flex_none().rounded(5).bg(t[status] ?? t.unknown)
            .when(status === "blocked", (dot) => dot.loop("opacity", { from: 0.25, to: 1, period: 1200 }))))
        // Working: an agent in it is mid-turn, the same spinner the sidebar and tab bar show.
        .when(status === "working", (el) => el.child(
          svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)));
    };
    // A full-width band under the tab bar, a step lighter than the sections (theme "raised");
    // its chips one step lighter again.
    return h_flex().size_full().px(16).gap(6).items_center().text_size(12.5).bg(t.raised)
      .child(svg("mods/workspace-chrome/pin.svg").size(13).flex_none().text_color(t.dim))
      .child(h_flex().min_w(0).gap(4).overflow_hidden().children(minimizedIds().map(chip)))
      .child(div().flex_1());
  }

  textButton(t, id, label, onUp) {
    // Mouse up, not click: a drag pressed in another header ends with a release here.
    return div().id(id).px(8).h(22).flex_none().flex().items_center().rounded(6).bg(t.raised).text_color(t.foreground)
      .hover((st) => st.bg(t.accent).text_color(t.accent_foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); onUp(); })
      .child(label);
  }

  // While another block is picked up, this header offers where to put it.
  dropBar(t, drag, leaf) {
    const spot = (side, label) => this.textButton(t, `pin-drop-${side}`, label, () => dropLeaf(drag, leaf, side));
    return h_flex().size_full().px(6).gap(6).items_center().text_size(12.5).bg(t.selected).rounded(6).text_color(t.foreground)
      .child(div().min_w(0).truncate().text_color(t.dim).child(`Put ${leafName(drag)}`))
      .child(div().flex_1())
      .child(spot("left", "◀ left"))
      .child(spot("top", "▲ above"))
      .child(spot("bottom", "▼ below"))
      .child(spot("right", "right ▶"))
      .child(spot("swap", "⇄ swap"));
  }
}

// Layout nodes as compared: Herdr adds fields when it reads a tree back, so only the
// parts this mod decides count (ids, types, and what a block shows).
function strip(n) {
  const c = n.content;
  return { id: n.id, type: n.type, content: c ? [c.mod ?? null, c.terminal ?? null, c.tab ?? null, c.props?.space ?? null, c.props?.pane ?? null] : null,
    children: (n.children ?? []).map(strip) };
}
const ours = (n) => String(n.id).startsWith(PREFIX);
// The work column's blocks and the work area's padding, which the dock bar changes.
function workShape(l) {
  const work = find(l, "work");
  return JSON.stringify([(work?.children ?? []).map((c) => c.id), find(l, "work-body")?.padding ?? null]);
}

// --- Arrangement: where the pinned sections and the normal view ("main") sit ---------
// shared "pins.arrange" is a tree of { type: "row" | "column", children } whose leaves
// are space ids and "main". It's read through arrangement(), which drops spaces no
// longer pinned and adds newly pinned ones just before the normal view.

const leafName = (leaf) => (leaf === "main" ? "the selected space" : spaces().find((s) => s.id === leaf)?.name ?? "space");

function prune(n, keep) {
  if (typeof n === "string") return keep.has(n) ? n : null;
  const children = (n.children ?? []).map((c) => prune(c, keep)).filter((c) => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { type: n.type === "column" ? "column" : "row", children };
}

function leavesOf(n, acc = new Set()) {
  if (typeof n === "string") acc.add(n);
  else for (const c of n.children ?? []) leavesOf(c, acc);
  return acc;
}

export function arrangement(pins) {
  const saved = shared("pins.arrange");
  let t = saved && typeof saved === "object" ? prune(saved, new Set([...pins, "main"])) : null;
  if (t === null) t = "main";
  if (typeof t === "string") t = { type: "row", children: [t] };
  else t = JSON.parse(JSON.stringify(t)); // no structuredClone in Herdr's JS
  const have = leavesOf(t);
  if (!have.has("main")) t.children.push("main");
  for (const id of pins) {
    if (have.has(id)) continue;
    const at = t.children.findIndex((c) => leavesOf(c).has("main"));
    t.children.splice(at === -1 ? t.children.length : at, 0, id);
  }
  return t;
}

// Moves a pinned space's section to the right of the other pinned spaces: out of the
// arrangement, then back in where arrangement() puts a newly pinned space.
function moveToEnd(space) {
  const t = arrangement(pinnedIds());
  const rest = prune(t, new Set([...leavesOf(t)].filter((x) => x !== space)));
  setShared("pins.arrange", typeof rest === "string" ? { type: "row", children: [rest] } : rest);
}

// Layout nodes for an arrangement: a group with one shown child is just that child.
function toNodes(n, leafNode, path) {
  if (typeof n === "string") return leafNode(n);
  const kids = n.children.map((c, i) => toNodes(c, leafNode, `${path}-${i}`)).filter(Boolean);
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  return { id: `${PREFIX}g-${path}`, type: n.type, size: { weight: 1 }, gap: 8, children: kids };
}

// Puts block `a` beside block `b` (side: left, right, top, bottom), or swaps them.
// fromCommand: called by the "place" command, with no block picked up by the mouse.
function dropLeaf(a, b, side, fromCommand) {
  if (!fromCommand && shared("pins.drag") !== a) return;
  setShared("pins.drag", null);
  if (a === b) return;
  let t = arrangement(pinnedIds());
  if (side === "swap") {
    const swap = (n) => (typeof n === "string" ? (n === a ? b : n === b ? a : n) : { type: n.type, children: n.children.map(swap) });
    setShared("pins.arrange", swap(t));
    return;
  }
  t = prune(t, new Set([...leavesOf(t)].filter((x) => x !== a)));
  if (typeof t === "string") t = { type: "row", children: [t] };
  const axis = side === "left" || side === "right" ? "row" : "column";
  const before = side === "left" || side === "top";
  const place = (n) => {
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i];
      if (c === b) {
        if (n.type === axis) n.children.splice(before ? i : i + 1, 0, a);
        else n.children[i] = { type: axis, children: before ? [a, b] : [b, a] };
        return true;
      }
      if (typeof c !== "string" && place(c)) return true;
    }
    return false;
  };
  place(t);
  setShared("pins.arrange", t);
}
