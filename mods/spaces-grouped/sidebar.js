// A copy of Herdr's `spaces` sidebar, with space groups: under each machine,
// spaces without a group come first, then each group under a header (click folds it,
// right-click renames or deletes it, "+" makes a new space in it). A space joins a group from its right-click
// menu ("Move to group…", the `space-menu` mod), by dragging it onto a group's header,
// or by dragging it onto a space in that group. Drag a group by its header onto another
// group's box (top half: before it, bottom half: after it) to reorder the groups. Groups live in shared("space.groups"),
// written by this mod and the `space-groups` dialog.
//
// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { runCommand } from "./commands.js";
import { panes, terminals, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, focused, nextCommand, readTextFile, writeTextFile, appHome, notify } from "herdr";
import { spaces, machines, machineShown } from "./machines-filter.js";

// Makes a space on `machine` (null: this computer) in the folder settings.json's
// "new_space_folders" gives that machine (e.g. {"wsl": "/home/user/code"}; "" is this computer).
// Without one, Herdr's default: that machine's home. Read on each click, so edits apply at once.
// First asks for its name and what runs in it (Terminal or Claude) in the `new-space` dialog,
// which makes the space on Enter; Esc makes none.
async function newSpace(machine) {
  let folder;
  try { folder = JSON.parse(await readTextFile(`${appHome()}/settings.json`)).new_space_folders?.[machine ?? ""]; } catch {}
  openOverlay({ mod: "spaces-grouped", kind: "dialog", width: 380, height: 300, props: { role: "new-space", machine: machine ?? "", folder } });
}
const focusedMachine = () => spaces().find((s) => s.id === focused()?.space)?.machine ?? null;

const groupsOf = () => {
  const g = shared("space.groups") ?? {};
  return { list: g.list ?? [], of: g.of ?? {} };
};
const setGroup = (space, groupId) => {
  const g = groupsOf();
  const of = { ...g.of };
  if (groupId) of[space] = groupId; else delete of[space];
  setShared("space.groups", { list: g.list, of });
};

// Replaces machine `on`'s groups here with those in its groups.json (`data`, see groupsBody),
// keeping their place among other machines' groups. Spaces the file doesn't list keep their
// group. Colours are taken only from a version 2 file (one without them comes from an older sidebar).
function applyGroups(on, data) {
  const g = groupsOf();
  const file = data.groups ?? [];
  const idOf = (name) => file.find((x) => x.name === name)?.id ?? null;
  const mine = file.map((x) => {
    const parent = x.parentId ?? (x.parent ? idOf(x.parent) : null);
    return { id: x.id, name: x.name, machine: on, ...(parent ? { parent } : {}) };
  });
  const at = g.list.findIndex((x) => x.machine === on);
  const others = g.list.filter((x) => x.machine !== on);
  const before = at < 0 ? others.length : g.list.slice(0, at).filter((x) => x.machine !== on).length;
  const list = [...others.slice(0, before), ...mine, ...others.slice(before)];
  const of = { ...g.of };
  const spaceColor = { ...(shared("space.color") ?? {}) };
  for (const [local, s] of Object.entries(data.spaces ?? {})) {
    const id = `${on}/${local}`;
    const group = s.groupId ?? (s.group ? idOf(s.group) : null);
    if (group) of[id] = group; else delete of[id];
    if (data.version >= 2) { if (s.color) spaceColor[id] = s.color; else delete spaceColor[id]; }
  }
  setShared("space.groups", { list, of });
  if (data.version >= 2) {
    const groupColor = { ...(shared("group.colors") ?? {}) };
    for (const x of g.list) if (x.machine === on) delete groupColor[x.id];
    for (const x of file) if (x.color) groupColor[x.id] = x.color;
    setShared("group.colors", groupColor);
    setShared("space.color", spaceColor);
  }
}

// A group can sit inside another: its `parent` is that group's id (none, or a parent
// that no longer exists: top level). Returns the groups in the order the sidebar draws
// them, each followed by the groups inside it, with `depth` (0: top level).
const treeOrder = (list) => {
  const ids = new Set(list.map((x) => x.id)), seen = new Set(), out = [];
  const walk = (x, depth) => {
    if (seen.has(x.id)) return;
    seen.add(x.id);
    out.push({ ...x, depth });
    for (const y of list) if (y.parent === x.id) walk(y, depth + 1);
  };
  for (const x of list) if (!x.parent || !ids.has(x.parent)) walk(x, 0);
  for (const x of list) walk(x, 0); // a parent loop written by hand: shown at top level
  return out;
};
// Whether group `id` is `root` or sits somewhere inside it.
const within = (list, id, root) => {
  for (let x = list.find((y) => y.id === id), n = 0; x && n <= list.length; x = list.find((y) => y.id === x.parent), n++)
    if (x.id === root) return true;
  return false;
};

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Pinning is on in any layout that holds the `pins` mod's engine block (id "pins-engine").
const pinsOn = () => !!find(layout(), "pins-engine");

// The `pins` mod's pin button (see mods/pins/main.js): only while pinning is on (pinsOn),
// shown on hover, and always while pinned. Click toggles shared "pins.spaces".
// The mouse down/up are stopped so the click doesn't also select or drag the row.
// `dragging` (a space is being dragged): the release isn't a pin click, so it goes on to
// the row and drops the dragged space there.
// Not an empty div when hidden: the row's gap would still push its neighbours over.
function showPin(w, hovered) {
  return pinsOn() && (hovered || (shared("pins.spaces") ?? []).includes(w.id));
}
function isPinned(w) {
  return pinsOn() && (shared("pins.spaces") ?? []).includes(w.id);
}
function pinButton(w, t, ink, dragging) {
  const list = shared("pins.spaces") ?? [];
  const pinned = list.includes(w.id);
  return div().id(`pin-${w.id}`).size(z(18)).flex_none().flex().items_center().justify_center().rounded(z(4))
    .hover((s) => s.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_mouse_up("left", (_e, cx) => {
      if (dragging) return;
      cx.stop_propagation();
      setShared("pins.spaces", pinned ? list.filter((s) => s !== w.id) : [...list, w.id]);
    })
    .child(svg("mods/workspace-chrome/pin.svg").size(z(12)).text_color(pinned ? (ink ?? t.accent) : (ink ?? t.dim)));
}

// While pinning is on, the highlighted row follows the keyboard: when a pane in a
// pinned section has it, focused() names its terminal but no model pane, and that
// terminal's space is lit instead of the selected one. Null: light the selected space.
function litSpace() {
  const f = focused();
  if (!pinsOn() || !f || f.pane || !f.terminal) return null;
  const tab = panes().find((p) => p.terminal === f.terminal)?.tab;
  return spaces().find((s) => s.tabs.some((c) => c.id === tab))?.id ?? null;
}

// A click on a space's row. While pinning is on, a pinned space is already on
// screen in its section, so the click doesn't switch spaces (the normal view keeps
// what it shows); it gives the keyboard to that space's first pane instead.
function selectOrFocusPinned(id) {
  if (pinsOn() && (shared("pins.spaces") ?? []).includes(id)) {
    const s = spaces().find((x) => x.id === id);
    const tabs = new Set((s?.tabs ?? []).map((c) => c.id));
    const terminal = panes().find((p) => tabs.has(p.tab) && p.terminal)?.terminal;
    if (terminal) { run("pane.focus", { terminal }); return; }
  }
  run("space.select", { id });
  // Clicking the space the normal view already shows doesn't move the keyboard by
  // itself, so a pinned pane would keep it (and the sidebar highlight). Hand it back
  // to the normal view: a pane in the space's shown tab.
  if (pinsOn() && focused() && !focused().pane) {
    const tab = spaces().find((x) => x.id === id)?.tabs.find((c) => c.active)?.id;
    const pane = panes().find((p) => p.tab === tab)?.pane;
    if (pane) run("pane.focus", { pane });
  }
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? z(28) : z(30));
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// This panel's own zoom, on top of Herdr's: Ctrl+plus/minus/0 with the mouse over it or Ctrl+scroll over the panel
// change it, and it is kept between restarts. Every size below goes through z().
let Z = 1;
try { Z = Number(localStorage.getItem("zoom")) || 1; } catch {}
const z = (n) => n * Z;
// "zoom-in", "zoom-out" or "zoom-reset" (keys.json sends them); true when it was one.
function zoomCommand(c) {
  if (c !== "zoom-in" && c !== "zoom-out" && c !== "zoom-reset") return false;
  Z = c === "zoom-reset" ? 1 : Math.min(2.5, Math.max(0.6, Math.round((Z + (c === "zoom-in" ? 0.1 : -0.1)) * 10) / 10));
  try { localStorage.setItem("zoom", String(Z)); } catch {}
  return true;
}
// Which zoomable panel the mouse is over, in shared "zoom.hover", so Ctrl+plus/minus
// zoom that panel (the `zoom` mod reads it) and the terminals everywhere else.
function hoverMod(name, hovered) {
  if (hovered) setShared("zoom.hover", name);
  else if (shared("zoom.hover") === name) setShared("zoom.hover", null);
}


function zoomWheel(e, cx) {
  if (!e.modifiers.control) return;
  cx.stop_propagation();
  const dy = e.delta_lines?.y ?? e.delta.y;
  if (Math.abs(dy) < 0.01) return;
  zoomCommand(dy > 0 ? "zoom-in" : "zoom-out");
  cx.notify();
}

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

// A softer row fill: the space's color mixed into the sidebar's background.
function mix(hex, base, amount) {
  const a = /^#([0-9a-f]{6})/i.exec(hex ?? ""), b = /^#([0-9a-f]{6})/i.exec(base ?? "");
  if (!a || !b) return hex;
  return "#" + [0, 2, 4].map((i) => Math.round(parseInt(a[1].slice(i, i + 2), 16) * amount + parseInt(b[1].slice(i, i + 2), 16) * (1 - amount))
    .toString(16).padStart(2, "0")).join("");
}

// Text on a solid fill: black on light colors, white on dark ones.
function inkOn(hex) {
  const h = /^#([0-9a-f]{6})/i.exec(hex ?? "");
  if (!h) return "#ffffff";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.25 ? "#000000" : "#ffffff";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.pressedGroup = null; // a group whose header is held down (dragging it reorders groups)
    this.groupOver = null; // { id, before }: the group box the dragged group would land beside
    this.groupDragged = false; // the held group has been over another group: no fold on release
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.groupFolded = new Set(JSON.parse(localStorage.getItem("groups.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
    // Agents on any machine group their space with a terminal label (see groupLabels).
    this.inbox = { home: {}, mirrored: {}, mirroring: false, labels: new Set() };
    this.trees = {}; // machine -> its herdr-tree doc (see readTree), { text, value, readAt }
    // keys.json binds Ctrl+Shift+plus/minus/0 to "spaces-grouped.zoom-in"/"zoom-out"/"zoom-reset".
    // keys.json binds Ctrl+Shift+N to "spaces-grouped.new-space": a new space on the focused space's machine.
    // "group:<space id>=<group name>" (from `herdr-app do`, e.g. the herdr-launch skill): puts that space in that group, making the group first when none has that name.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (zoomCommand(c)) { cx.notify(); continue; }
        if (c === "new-space") await newSpace(focusedMachine());
        if (await runCommand(c, this, cx)) { cx.notify(); continue; }
        const m = /^group:(.+)=(.+)$/.exec(c);
        if (m) {
          // A name with no group yet makes a new group, as the space-groups dialog's "New group" does.
          const g = groupsOf();
          const space = spaces().find((s) => s.id === m[1]);
          if (space) {
            const group = g.list.find((x) => x.name === m[2]);
            if (group) setGroup(m[1], group.id);
            else {
              const id = `g${Date.now().toString(36)}`;
              setShared("space.groups", { list: [...g.list, { id, name: m[2], machine: space.machine ?? null }], of: { ...g.of, [m[1]]: id } });
            }
          }
        }
        cx.notify();
      }
    });
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    // A space made from a group's "+": the first new one on that machine joins the group.
    if (this.newIn) {
      const made = sp.find((s) => (s.machine ?? null) === this.newIn.machine && !this.newIn.known.has(s.id));
      if (made) setGroup(made.id, this.newIn.group);
      if (made || now - this.newIn.at > 120000) this.newIn = null; // time to type a name
    }
    this.groupLabels(cx);
    this.mirrorAll(cx);
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  // Groups live here, on this screen, so an agent on another machine can't set them
  // itself. Instead it labels its own terminal, and Herdr's live connection brings the label here
  // (terminals() is in memory: checking it costs no trip to the machine):
  //   hc label "$HC_TERMINAL_ID" group="meta tasks"     (group=- takes its space out of its group)
  // This puts that terminal's space in the group (made if missing; only that machine's groups),
  // then removes the label. A terminal with no space here yet keeps its label until it has one.
  groupLabels(cx) {
    for (const t of terminals()) {
      const want = t.labels?.group;
      if (want == null || want === "" || this.inbox.labels.has(t.address)) continue;
      const local = t.labels["herdr.space"];
      if (!local) continue;
      const slash = t.address.indexOf("/");
      const on = slash > 0 ? t.address.slice(0, slash) : undefined;
      const space = on ? `${on}/${local}` : local;
      if (!spaces().some((s) => s.id === space)) continue;
      this.inbox.labels.add(t.address);
      cx.spawn(async (cx) => {
        try {
          await runCommand(`space-group:${JSON.stringify({ space: local, group: want === "-" ? null : want })}`, this, cx, on);
          await hc(["label", t.address, "group="]);
        } catch {} finally {
          this.inbox.labels.delete(t.address);
          cx.notify();
        }
      });
    }
  }

  // A remote machine's groups and colours live in a file on that machine,
  // ~/.local/state/herdr-groups/groups.json, shared by every computer whose Herdr shows it
  // (e.g. two computers both showing one server), and read by agents there. See syncGroups.
  mirrorAll(cx) {
    if (this.inbox.mirroring) return;
    const ready = machines().filter((m) => m.name && m.layout === "ready").map((m) => m.name);
    if (!ready.length) return;
    this.inbox.mirroring = true;
    cx.spawn(async (cx) => {
      try {
        for (const on of ready) {
          try {
            this.inbox.home[on] ??= (await exec("sh", ["-c", "printf %s \"$HOME\""], { on })).stdout.trim();
            if (await this.syncGroups(on, `${this.inbox.home[on]}/.local/state/herdr-groups`)) cx.notify();
          } catch {}
          try { if (await this.readTree(on)) cx.notify(); } catch {}
        }
      } finally { this.inbox.mirroring = false; }
    });
  }

  // Machine `on`'s groups (in sidebar order), its spaces' groups and the colours of both,
  // as written to its groups.json. `parent` and `group` are names, for agents reading the file.
  groupsBody(on) {
    const g = groupsOf();
    const list = g.list.filter((x) => x.machine === on);
    const ids = new Set(list.map((x) => x.id));
    const named = (id) => list.find((x) => x.id === id)?.name ?? null;
    const strip = (id) => id.slice(on.length + 1);
    const groupColor = shared("group.colors") ?? {};
    const spaceColor = shared("space.color") ?? {};
    return JSON.stringify({
      version: 2,
      groups: list.map((x) => ({ id: x.id, name: x.name, parent: named(x.parent), parentId: ids.has(x.parent) ? x.parent : null, color: groupColor[x.id] ?? null })),
      spaces: Object.fromEntries(spaces().filter((s) => s.machine === on)
        .map((s) => [strip(s.id), { name: s.name, group: ids.has(g.of[s.id]) ? named(g.of[s.id]) : null, groupId: ids.has(g.of[s.id]) ? g.of[s.id] : null, color: spaceColor[s.id] ?? null }])),
    }, null, 1) + "\n";
  }

  // Two-way sync with machine `on`'s groups.json. A change made here is written there; a change
  // there (another computer's edit) is read every READ_EVERY ms and applied here. On the first
  // pass the file wins, so a computer that doesn't know the machine's groups can't erase them;
  // only an empty or missing file is started from this computer's groups.
  // Returns true when it changed this computer's groups.
  async syncGroups(on, dir) {
    const READ_EVERY = 3000;
    // Right after connecting, spaces() can briefly list none of the machine's spaces: a write
    // then would drop every space from the file.
    if (!spaces().some((s) => s.machine === on)) return false;
    const sync = this.inbox.mirrored[on] ??= { local: null, remote: null, readAt: 0 };
    const write = async (body) => {
      const put = 'mkdir -p "$1" && printf %s "$2" > "$1/groups.json.tmp" && mv "$1/groups.json.tmp" "$1/groups.json"';
      const r = await exec("sh", ["-c", put, "sh", dir, body], { on });
      if (r.code === 0) sync.local = sync.remote = body;
    };
    const body = this.groupsBody(on);
    if (sync.local !== null && body !== sync.local) { await write(body); return false; }
    if (sync.local !== null && Date.now() - sync.readAt < READ_EVERY) return false;
    sync.readAt = Date.now();
    const r = await exec("sh", ["-c", '[ -f "$1/groups.json" ] && cat "$1/groups.json" || true', "sh", dir], { on });
    if (r.code !== 0) return false;
    const text = r.stdout;
    let data = null;
    try { data = JSON.parse(text); } catch {}
    const empty = !data?.groups?.length && !Object.values(data?.spaces ?? {}).some((s) => s.group || s.color);
    if (sync.local === null && empty) { await write(body); return false; }
    if (!data) return false;
    if (text === sync.remote) return false;
    applyGroups(on, data);
    sync.remote = text;
    sync.local = this.groupsBody(on);
    return true;
  }

  // Space nesting from the herdr web app: the herdr-core doc `herdr-tree` on machine `on`,
  // { root, spaces: { "<local space id>": { parent: "<local space id>" | null, quiet } } }.
  // Read like groups.json, every READ_EVERY ms, through hc on that machine. Read-only: this
  // sidebar never writes it. Returns true when it changed.
  async readTree(on) {
    const READ_EVERY = 3000;
    const tree = this.trees[on] ??= { text: null, value: null, readAt: 0 };
    if (Date.now() - tree.readAt < READ_EVERY) return false;
    tree.readAt = Date.now();
    const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "doc.get", params: { name: "herdr-tree" } });
    const get = 'p=$(command -v hc) || p=$HOME/.local/bin/hc; printf "%s\\n" "$1" | "$p" connect';
    const r = await exec("sh", ["-c", get, "sh", req], { on, timeout: 10000 });
    if (r.code !== 0) return false;
    const line = r.stdout.split("\n").find((l) => l.includes('"id":1'));
    let reply = null;
    try { reply = JSON.parse(line); } catch {}
    if (!reply || reply.error) return false;
    const text = JSON.stringify(reply.result?.value ?? null);
    if (text === tree.text) return false;
    tree.text = text;
    tree.value = reply.result?.value ?? null;
    return true;
  }

  // Space `w`'s parent space's id from its machine's herdr-tree, or null.
  treeParent(w) {
    const on = w.machine;
    if (!on) return null;
    const parent = this.trees[on]?.value?.spaces?.[w.id.slice(on.length + 1)]?.parent;
    return parent ? `${on}/${parent}` : null;
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary && machineShown(m.name)); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "spaces-grouped", kind: "popup", width: 280, height: 320, props: { role: "menu", tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const nestedOut = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      nestedOut.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => nestedOut.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Spaces without a group first, then each group in the order it was made. A
    // worktree goes with its repo's space. Sorting here also moves the real order,
    // so alt+1..9 matches what the sidebar shows.
    const gr = groupsOf();
    const flat = treeOrder(gr.list);
    const rank = (id) => flat.findIndex((x) => x.id === gr.of[id]);
    const own = [];
    for (const r of nestedOut) {
      if (r.tree && own.length) own[own.length - 1].push(r);
      else own.push([{ ...r, nest: 0 }]);
    }
    // A child space (its machine's herdr-tree, see readTree) goes right after its parent's
    // block, one step further in, with its worktrees and its own children. It goes where its
    // parent goes, so its own group is ignored. A missing parent or a parent loop: top level.
    const byId = new Map(own.map((b) => [b[0].w.id, b]));
    const parentOf = (b) => { const p = this.treeParent(b[0].w); return p && byId.has(p) ? p : null; };
    const childrenOf = new Map();
    for (const b of own) { const p = parentOf(b); if (p) childrenOf.set(p, [...(childrenOf.get(p) ?? []), b]); }
    const rooted = (b) => { const seen = new Set(); for (let x = b; x; x = byId.get(parentOf(x))) { if (seen.has(x)) return false; seen.add(x); } return true; };
    const used = new Set();
    const subtree = (b, nest) => {
      used.add(b);
      return [...b.map((r) => ({ ...r, nest })), ...(childrenOf.get(b[0].w.id) ?? []).filter((c) => !used.has(c)).flatMap((c) => subtree(c, nest + 1))];
    };
    const blocks = [];
    for (const b of own) if ((!parentOf(b) || !rooted(b)) && !used.has(b)) blocks.push(subtree(b, 0));
    // Sort within each machine only: Herdr keeps a machine's spaces together, so a group on
    // this computer made after another machine's groups can't put its spaces after that
    // machine's. Sorting across machines asked for an order Herdr never reaches, and the
    // retries kept shuffling the other machine's spaces.
    const machineAt = new Map();
    for (const w of sp) if (!machineAt.has(w.machine ?? null)) machineAt.set(w.machine ?? null, machineAt.size);
    const mach = (b) => machineAt.get(b[0].w.machine ?? null) ?? 0;
    blocks.sort((a, b) => mach(a) - mach(b) || rank(a[0].w.id) - rank(b[0].w.id));
    const out = blocks.flatMap((b) => b.map((r) => ({ ...r, group: rank(b[0].w.id) < 0 ? null : gr.of[b[0].w.id] })));
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(z(28)).flex_none().px(z(8)).text_size(z(12)).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : this.withGroups(rows, null, t, collapsed, draw);
    const machineNames = [null, ...remote].filter((m) => machineShown(m));
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(z(26)).flex_none().px(collapsed ? 2 : 8).gap(z(7)).items_center().text_size(z(11)).text_color(t.foreground).bg(t.raised)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(z(13)).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(z(3)).items_center()
            .child(div().max_w(z(140)).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(z(4)).rounded(z(4)).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(() => newSpace(m)); }).child("+")))
          .child(div().size(z(6)).rounded(z(3)).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(z(11)).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(z(28)).flex_none().px(z(8)).gap(z(7)).items_center().rounded(z(7))
        .text_size(z(12)).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => cx.spawn(() => newSpace(m)))
        .child(svg("mods/workspace-chrome/plus.svg").size(z(12))).when(!collapsed, el => el.child("New space there"));
      if (!collapsed && rebuilt) return [head];
      return [head, ...(folded ? [] : mine.length ? this.withGroups(mine, m, t, collapsed, draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // One machine's rows: those without a group, then each of its top-level groups in a box.
  // A group's box holds its header, its own spaces, then the boxes of the groups inside it.
  withGroups(rows, m, t, collapsed, draw) {
    if (collapsed) return rows.map(draw);
    const list = groupsOf().list.filter((x) => (x.machine ?? null) === m);
    const loose = rows.filter((r) => !list.some((x) => x.id === r.group));
    const flat = treeOrder(list);
    const kids = (x) => flat.filter((y) => y.parent === x.id && y.depth > 0);
    const total = (x) => rows.filter((r) => r.group === x.id).length + kids(x).reduce((n, y) => n + total(y), 0);
    // While a group is dragged, it and the groups inside it are no drop target.
    const dragging = () => this.pressedGroup !== null && list.some((g) => g.id === this.pressedGroup);
    const target = (x) => !within(list, x.id, this.pressedGroup);
    const box = (x) => {
      const members = rows.filter((r) => r.group === x.id);
      const inner = kids(x);
      const folded = this.groupFolded.has(x.id);
      // An outline around the group's header, its spaces and the groups inside it: the
      // group's color (its right-click dialog), else off-white.
      const color = (shared("group.colors") ?? {})[x.id]?.replace(/^inv:/, "");
      const edge = !color || color === "dim" ? "#d8d4c8" : color.startsWith("#") ? color : (MARK[color] ?? t[color]);
      const drop = this.groupOver?.id === x.id && !this.groupOver.into ? this.groupOver : null;
      return v_flex().relative().id(`group-box-${x.id}`).mt(z(6)).flex_none().border(2).border_color(edge).p(z(3))
        .when(this.pressedGroup === x.id && this.groupDragged, (el) => el.opacity(0.5))
        // Where the dragged group will land: in the gap above or below this box.
        .when(Boolean(drop), (el) => el.child(div().absolute().left(0).right(0).h(z(3)).bg(t.accent)
          .when(drop?.before, (line) => line.top(z(-5)))
          .when(!drop?.before, (line) => line.bottom(z(-5)))))
        // The innermost box under the mouse decides; stopping here keeps the boxes around it from overriding.
        .on_mouse_move((e, cx) => {
          if (!dragging()) return;
          cx.stop_propagation();
          const over = target(x) ? { id: x.id, before: e.local_position.y < e.bounds.height / 2 } : null;
          this.setGroupOver(over, cx);
        })
        .child(this.groupHead(x, total(x), folded, t, () => dragging() && target(x)))
        .when(!folded && members.length > 0, (el) => el.child(div().h(z(3))).children(members.map(draw)))
        .when(!folded, (el) => el.children(inner.map(box)));
    };
    return [...loose.map(draw), ...flat.filter((x) => x.depth === 0).map(box)];
  }

  setGroupOver(over, cx) {
    if (over) this.groupDragged = true;
    const a = this.groupOver, same = a?.id === over?.id && a?.before === over?.before && a?.into === over?.into;
    if (!same) { this.groupOver = over; cx.notify(); }
  }

  // nestable(): whether a group dragged now could be dropped into this one (then the header shows it).
  groupHead(x, count, folded, t, nestable) {
    const key = `group:${x.id}`;
    const into = this.groupOver?.into && this.groupOver.id === x.id;
    // The group's color (its right-click dialog) fills the header the way it fills a
    // space's row (see row()): muted, or the full color with black text for "inv:".
    // No color: the plain surface.
    const picked = (shared("group.colors") ?? {})[x.id] ?? "dim";
    const inverted = picked.startsWith("inv:");
    const color = inverted ? picked.slice(4) : picked;
    const plain = color === "dim";
    const fill = plain ? t.surface : inverted ? (color.startsWith("#") ? color : (MARK[color] ?? t[color]))
      : mix(color.startsWith("#") ? color : (MARK[color] ?? t[color]), t.chrome, 0.32);
    const ink = plain ? t.foreground : inverted ? "#000000" : inkOn(fill);
    return h_flex().id(`group-${x.id}`).h(z(26)).flex_none().px(z(8)).gap(z(7)).items_center().bg(fill)
      .text_size(z(12)).text_color(ink).cursor_pointer()
      .hover((s) => plain ? s.bg(t.hover) : s.opacity(0.88))
      .when((this.pressed !== null && this.over === key) || into, (el) => el.bg(t.selected))
      .on_mouse_down("left", () => { this.pressed = null; this.pressedGroup = x.id; this.groupOver = null; this.groupDragged = false; })
      .on_mouse_move((_e, cx) => {
        if (this.pressed !== null && this.over !== key) { this.over = key; cx.notify(); }
        // A group dragged onto this header goes inside this group.
        if (this.pressedGroup !== null && this.pressedGroup !== x.id) {
          cx.stop_propagation();
          this.setGroupOver(nestable() ? { id: x.id, into: true } : null, cx);
        }
      })
      // The group drop itself happens in the list's mouse up (dropGroup), wherever the release is.
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        this.pressed = null;
        this.over = null;
        if (from !== null) setGroup(from, x.id);
        else if (this.pressedGroup === x.id && !this.groupDragged) {
          folded ? this.groupFolded.delete(x.id) : this.groupFolded.add(x.id);
          localStorage.setItem("groups.folded", JSON.stringify([...this.groupFolded]));
        }
        cx.notify();
      })
      // The dialog lists the machine's groups (to pick the one this group sits inside): taller per group.
      .on_mouse_down("right", () => openOverlay({ mod: "spaces-grouped", kind: "dialog", width: 340,
        height: Math.min(640, 330 + 30 * groupsOf().list.filter((y) => (y.machine ?? null) === (x.machine ?? null)).length), props: { role: "groups", group: x.id } }))
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(z(11)).flex_none())
      .child(svg("mods/workspace-chrome/folder.svg").size(z(13)).flex_none())
      .child(div().flex_1().truncate().child(x.name))
      .child(div().flex_none().text_size(z(11)).text_color(plain ? t.dim : ink).child(String(count)))
      .child(div().id(`group-add-${x.id}`).flex_none().px(z(4)).rounded(z(4)).text_color(plain ? t.dim : ink)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_up("left", (_e, cx) => {
          if (this.groupDragged) return; // a group dropped here: the list's mouse up places it
          cx.stop_propagation();
          this.pressedGroup = null;
          if (this.pressed !== null) return;
          this.newIn = { group: x.id, machine: x.machine ?? null, known: new Set(spaces().map((s) => s.id)), at: Date.now() };
          cx.spawn(() => newSpace(x.machine ?? null));
        })
        .child("+"));
  }

  // Moves the dragged group: into the group whose header it was over (last inside it), or
  // before or after the group whose box it was over, beside it (same parent, so dropping
  // beside a top-level group takes it out of its parent). Groups are listed in
  // shared("space.groups").list order, and ordered() then moves their spaces to match.
  dropGroup() {
    const from = this.pressedGroup, over = this.groupOver;
    if (from === null || !over || !this.groupDragged) return;
    const g = groupsOf();
    const old = g.list.find((y) => y.id === from);
    const host = g.list.find((y) => y.id === over.id);
    if (!old || !host || within(g.list, over.id, from)) return;
    const { parent: _, ...moved } = old;
    const parent = over.into ? host.id : host.parent;
    if (parent) moved.parent = parent;
    const next = g.list.filter((y) => y.id !== from);
    const at = next.findIndex((y) => y.id === over.id);
    next.splice(over.into ? next.length : over.before ? at : at + 1, 0, moved);
    setShared("space.groups", { list: next, of: g.of });
  }

  endDrag() {
    this.pressed = null;
    this.over = null;
    this.pressedGroup = null;
    this.groupOver = null;
    this.groupDragged = false;
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t, ink) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(z(5))
      .justify_end()
      .items_center()
      .text_size(z(11.5))
      .text_color(ink ? `${ink}a6` : t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(ink ?? t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(ink ?? t.ansi1).child(`\u2193${g.behind}`)));
  }

  // nest: how deep the space sits under other spaces (its machine's herdr-tree); each step indents the row.
  row({ w, i, g, tree, group, nest = 0 }, t) {
    const on = this.lit ? this.lit === w.id : w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    // The space's own pick (its right-click menu), else its group's (the group's
    // right-click dialog), else none ("dim"). See SWATCHES in the space-menu mod.
    const own = (shared("space.color") ?? {})[w.id];
    const picked = own ?? (group ? (shared("group.colors") ?? {})[group] : undefined) ?? "dim";
    // "inv:<key>": the color inverted (see swatchRow in space-menu).
    const inverted = picked.startsWith("inv:");
    const color = inverted ? picked.slice(4) : picked;
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    // A space's row is filled with its color (worktree rows too); a space with
    // no color stays plain. Inverted, the row is filled with the full color (not
    // the muted one) and its text is black.
    const plain = color === "dim";
    const soft = inverted ? fill : mix(fill, t.chrome, 0.32);
    const ink = plain ? null : inverted ? "#000000" : inkOn(soft);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(z(8))
      .when(nest > 0, (el) => el.ml(z(16 * nest)))
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .overflow_hidden()
      // Working: diagonal lines slide across the row's background while an agent
      // in it is mid-turn, so a busy space shows from across the room. The lines
      // are the rim of a big spinning wheel (stripes.svg), since spin() is the only
      // native animation that keeps going one way. They darken a colored row,
      // lighten an inverted one (black text), and are faint on a plain one.
      .when(w.status === "working", (el) => el.child(
        div().absolute().left(z(-650)).top(z(-200)).opacity(plain ? 0.1 : 0.16)
          .child(svg("mods/spaces-grouped/stripes.svg").size(z(1600)).spin(200000)
            .text_color(plain ? t.working : inverted ? "#ffffff" : "#000000"))))
      // Pinned (pinning on): a bar down the row's left edge, in the row's text
      // color on a colored row and the accent on a plain one, so pinned spaces show
      // at a glance without fighting the row's fill or its selected border.
      .when(isPinned(w), (el) => el.child(
        div().absolute().left(0).top(0).bottom(0).w(z(4)).bg(ink ?? t.accent)))
      .when(!plain, (el) => el.mb(z(3)).bg(soft).border(2).border_color(on ? mix(t.foreground, soft, 0.7) : soft).hover((s) => s.opacity(0.88)))
      .when(plain, (el) => el.mb(tree ? 0 : 3).rounded(z(8)).when(on, (r) => r.bg(t.selected)).when(!on, (r) => r.hover((s) => s.bg(t.hover))))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(z(2)).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressedGroup = null;
        this.groupOver = null;
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        if (this.pressedGroup !== null) return;
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.pressedGroup !== null) return; // a group drag: the list's mouse up places it
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
          setGroup(from, group);
        } else if (from === w.id) selectOrFocusPinned(w.id);
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .on_hover((h, cx) => { if (h) this.hoverRow = w.id; else if (this.hoverRow === w.id) this.hoverRow = null; cx.notify(); })
      .child(
        h_flex()
          .gap(z(9))
          .items_center()
          .when(Boolean(tree), el => el.pl(z(22)).child(svg("mods/workspace-chrome/branch.svg").size(z(13)).text_color(t.dim)))
          // The name always shows whole; the git tail after it gives way first.
          // The space's status (its right-click "Set status…", shared "space.status"), as a badge before the name.
          .when(Boolean((shared("space.status") ?? {})[w.id]), el => el.child(
            div().flex_none().max_w(z(60)).truncate().text_size(z(12.5)).child((shared("space.status") ?? {})[w.id])))
          .child(div().min_w(0).truncate().text_color(ink ?? t.foreground)
            // Bold when it's the space you're in, or when a session in it has stopped
            // and wants you (done or blocked), so waiting spaces stand out.
            .when(on || w.status === "done" || w.status === "blocked", (n) => n.font_bold()).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t, ink) : div().flex_1())
          // The pin sits before the status mark, so a pinned space's spinner lines up with the others'.
          .when(showPin(w, this.hoverRow === w.id), el => el.child(pinButton(w, t, ink, this.pressed !== null && this.pressed !== w.id)))
          // Done: a session finished while you weren't looking. Blocked: one waits for you, so it pulses.
          .when(w.status === "done" || w.status === "blocked", el => el.child(
            div().size(z(9)).flex_none().rounded(z(5)).bg(tone(t, w.status)).when(Boolean(ink), (dot) => dot.border(1).border_color(ink))
              .when(w.status === "blocked", dot => dot.loop("opacity", { from: 0.25, to: 1, period: 1200 }))))
          // Working: an agent in it is mid-turn, the same spinner the tab bar shows.
          .when(w.status === "working", el => el.child(
            svg("mods/workspace-chrome/spinner.svg").size(z(11)).flex_none().text_color(ink ?? t.working).spin(900)))
      );
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(z(26))
      .flex_none()
      .justify_center()
      .gap(z(4))
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    const t = theme();
    this.lit = litSpace();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    // Forget spaces that are gone, but only once every machine's spaces have loaded,
    // and never while the list is empty (a reload can briefly see no spaces).
    const gr = groupsOf();
    if (sp.length > 0 && machines().every((m) => m.layout === "ready") && Object.keys(gr.of).some((id) => !ids.has(id)))
      setShared("space.groups", { list: gr.list, of: Object.fromEntries(Object.entries(gr.of).filter(([id]) => ids.has(id))) });
    return v_flex().id("spaces-zoom").size_full().min_h(0).bg(t.chrome).font_family("iA Writer Mono S").text_size(z(12)).on_scroll_wheel(zoomWheel).on_hover((h, cx) => {
        hoverMod("spaces-grouped", h);
        // Let go outside the sidebar: the drag is over, nothing moves.
        if (!h && (this.pressed !== null || this.pressedGroup !== null)) { this.endDrag(); cx.notify(); }
      })
      .child(h_flex().h(z(31)).pl(z(16)).pr(z(10)).items_center().justify_between().text_size(z(11.5)).text_color(t.dim)
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(z(26)).flex_none().flex().items_center().justify_center().rounded(z(6)).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => cx.spawn(() => newSpace(focusedMachine()))).child(svg("mods/workspace-chrome/plus.svg").size(z(14)))))
      .child(v_flex().flex_1().min_h(0).px(z(8)).pb(z(14)).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.dropGroup(); this.endDrag(); cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
