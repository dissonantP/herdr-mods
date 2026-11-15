// Commands that let a script or agent do everything the sidebar's mouse actions do.
// Sent as: herdr-app do 'spaces-grouped.<verb>:<json>'   e.g.
//   herdr-app do 'spaces-grouped.space-group:{"space":"sp12","group":"bugs: today","parent":"bugs"}'
// Herdr delivers a mod command only while that mod is on screen, so the sidebar must be shown.
// Groups are referred to by id or by name (a name shared by groups on different machines picks
// the one on the space's machine, else the first). Errors are posted as a notification.
//
//   space-group   {space, group, parent?}      put a space in a group, made (inside parent) if missing;
//                                              group null: take the space out of its group
//   group-new     {name, parent?, machine?}    make a group (inside parent); nothing if one has that name
//   group-rename  {group, name}
//   group-delete  {group}                      its spaces and groups move up to its parent
//   group-move    {group, parent?, before?, after?}
//                                              parent: group to nest it in (null: top level; left out:
//                                              unchanged); before/after: a group to sit next to
//   group-fold    {group, folded}              true folds, false unfolds
//   group-color   {group, color}               color: see COLORS; null: no color
//   space-color   {space, color}               color: see COLORS, "dim": none even in a colored group;
//                                              null: same as its group
//   space-status  {space, text}                the badge left of the name; "" clears it
//   pane-move     {terminal | pane, to, space?, tab?, name?, group?}
//                                              move a pane (a terminal, or a mod pane such as md-review):
//                                              to "new-tab" (in `space`, default its own), "tab" (beside
//                                              the panes of `tab`), or "new-space" (named `name`, else
//                                              after its tab; in group `group`, made if missing).
//                                              Herdr places panes only in the shown space, so this shows
//                                              the target briefly, then goes back to the space that was shown.
//
// COLORS: ansi6 (teal), ansi4 (blue), ansi5 (purple), ansi1 (pink), ansi3 (orange), ansi2 (green),
// #d9b54a (yellow), #d9534f (red), #8a8f98 (grey), or any #rrggbb; "inv:<color>" fills the row with
// the full color and black text.
// State, for reading: ~/.config/herdr-app/shared.json keys "space.groups"
// ({ list: [{ id, name, machine, parent? }], of: { spaceId: groupId } }), "space.color",
// "group.colors", "space.status". Herdr owns that file while it runs: change it only through commands.

import { panes, run, shared, setShared, notify, readTextFile, home } from "herdr";
import { spaces } from "./machines-filter.js";

const groupsOf = () => {
  const g = shared("space.groups") ?? {};
  return { list: g.list ?? [], of: g.of ?? {} };
};
const within = (list, id, root) => {
  for (let x = list.find((y) => y.id === id), n = 0; x && n <= list.length; x = list.find((y) => y.id === x.parent), n++)
    if (x.id === root) return true;
  return false;
};
const newId = () => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function fail(msg) {
  try { notify({ title: "spaces-grouped command", body: msg, level: "error" }); } catch {}
  return true;
}
// origin: a remote machine whose terminal label sent the command (see sidebar.js groupLabels):
// only that machine's spaces, by its own id ("sp12" there is "pi/sp12" here) or name.
function spaceOf(ref, origin) {
  if (origin === undefined) return spaces().find((s) => s.id === ref) ?? spaces().find((s) => s.name === ref);
  const mine = spaces().filter((s) => (s.machine ?? null) === origin);
  return mine.find((s) => s.id === ref || s.id === `${origin}/${ref}`) ?? mine.find((s) => s.name === ref);
}
// strict: only a group on `machine` (a space can't sit in another machine's group).
function groupOf(list, ref, machine, strict = false) {
  if (ref == null) return null;
  const byId = list.find((x) => x.id === ref);
  if (byId) return !strict || (byId.machine ?? null) === (machine ?? null) ? byId : null;
  const named = list.filter((x) => x.name === ref);
  return named.find((x) => (x.machine ?? null) === (machine ?? null)) ?? (strict ? null : named[0] ?? null);
}
function setKey(key, id, value) {
  const all = { ...(shared(key) ?? {}) };
  if (value == null || value === "") delete all[id]; else all[id] = value;
  setShared(key, all);
}
// Finds the group named `name` (inside `parentRef`, if given) or makes it. Returns [list, group].
function ensureGroup(list, name, parentRef, machine) {
  const parent = parentRef == null ? null : groupOf(list, parentRef, machine, true) ?? null;
  if (parentRef != null && !parent) {
    [list] = ensureGroup(list, parentRef, null, machine);
    return ensureGroup(list, name, parentRef, machine);
  }
  const same = list.find((x) => x.name === name && (x.machine ?? null) === (machine ?? null) && (x.parent ?? null) === (parent?.id ?? null))
    ?? (parentRef == null ? groupOf(list, name, machine, true) : null);
  if (same) return [list, same];
  const made = { id: newId(), name, machine: machine ?? null, ...(parent ? { parent: parent.id } : {}) };
  return [[...list, made], made];
}

// Runs one command; resolves true when `c` was one of these (handled or reported).
// view: the sidebar, for fold state (kept per window in its localStorage); cx: for waiting.
// origin: set for a command from a remote machine's terminal label (the machine's name): it reaches only
// that machine's spaces and groups, and can't move panes or fold groups (this window's view).
export async function runCommand(c, view, cx, origin) {
  const m = /^([a-z-]+):([\s\S]*)$/.exec(c);
  if (!m) return false;
  const verb = m[1];
  if (origin !== undefined && ["pane-move", "group-fold"].includes(verb)) return fail(`${verb}: not taken from ${origin}`);
  if (verb === "pane-move") {
    let a;
    try { a = JSON.parse(m[2]); } catch { return fail(`${verb}: the part after ":" isn't JSON`); }
    await paneMove(a, cx);
    return true;
  }
  const VERBS = ["space-group", "group-new", "group-rename", "group-delete", "group-move", "group-fold", "group-color", "space-color", "space-status"];
  if (!VERBS.includes(verb)) return false;
  let a;
  try { a = JSON.parse(m[2]); } catch { return fail(`${verb}: the part after ":" isn't JSON`); }
  const g = groupsOf();
  const space = a.space != null ? spaceOf(a.space, origin) : null;
  if (a.space != null && !space) return fail(`${verb}: no space "${a.space}"${origin !== undefined ? ` on ${origin}` : ""}`);
  const machine = origin !== undefined ? origin : space?.machine ?? a.machine ?? null;
  const strict = origin !== undefined;
  const group = a.group != null && verb !== "space-group" ? groupOf(g.list, a.group, machine, strict) : null;
  if (a.group != null && verb !== "space-group" && !group) return fail(`${verb}: no group "${a.group}"`);

  switch (verb) {
    case "space-group": {
      if (!space) return fail("space-group: needs space");
      const of = { ...g.of };
      if (a.group == null) { delete of[space.id]; setShared("space.groups", { list: g.list, of }); return true; }
      const [list, target] = ensureGroup(g.list, a.group, a.parent ?? null, machine);
      of[space.id] = target.id;
      setShared("space.groups", { list, of });
      return true;
    }
    case "group-new": {
      if (!a.name) return fail("group-new: needs name");
      const [list] = ensureGroup(g.list, a.name, a.parent ?? null, machine);
      setShared("space.groups", { list, of: g.of });
      return true;
    }
    case "group-rename": {
      if (!group || !a.name) return fail("group-rename: needs group and name");
      setShared("space.groups", { list: g.list.map((x) => (x.id === group.id ? { ...x, name: a.name } : x)), of: g.of });
      return true;
    }
    case "group-delete": {
      if (!group) return fail("group-delete: needs group");
      const parent = group.parent ?? null;
      const of = Object.fromEntries(Object.entries(g.of).flatMap(([s, id]) => (id !== group.id ? [[s, id]] : parent ? [[s, parent]] : [])));
      const list = g.list.filter((x) => x.id !== group.id).map(({ parent: up, ...x }) => {
        const next = up === group.id ? parent : up;
        return next ? { ...x, parent: next } : x;
      });
      setShared("space.groups", { list, of });
      return true;
    }
    case "group-move": {
      if (!group) return fail("group-move: needs group");
      const { parent: oldParent, ...moved } = group;
      let parentId = oldParent ?? null;
      if ("parent" in a) {
        const p = a.parent == null ? null : groupOf(g.list, a.parent, group.machine, strict);
        if (a.parent != null && !p) return fail(`group-move: no group "${a.parent}"`);
        if (p && within(g.list, p.id, group.id)) return fail("group-move: can't put a group inside itself");
        parentId = p?.id ?? null;
      }
      const sibRef = a.before ?? a.after;
      const sib = sibRef != null ? groupOf(g.list, sibRef, group.machine, strict) : null;
      if (sibRef != null && !sib) return fail(`group-move: no group "${sibRef}"`);
      if (sib && !("parent" in a)) parentId = sib.parent ?? null;
      if (parentId) moved.parent = parentId;
      const next = g.list.filter((x) => x.id !== group.id);
      const at = sib ? next.findIndex((x) => x.id === sib.id) : -1;
      next.splice(at === -1 ? next.length : a.before != null ? at : at + 1, 0, moved);
      setShared("space.groups", { list: next, of: g.of });
      return true;
    }
    case "group-fold": {
      if (!group) return fail("group-fold: needs group");
      if (a.folded === false) view.groupFolded.delete(group.id); else view.groupFolded.add(group.id);
      try { localStorage.setItem("groups.folded", JSON.stringify([...view.groupFolded])); } catch {}
      return true;
    }
    case "group-color": {
      if (!group) return fail("group-color: needs group");
      setKey("group.colors", group.id, a.color ?? null);
      return true;
    }
    case "space-color": {
      if (!space) return fail("space-color: needs space");
      setKey("space.color", space.id, a.color ?? null);
      return true;
    }
    case "space-status": {
      if (!space) return fail("space-status: needs space");
      const text = String(a.text ?? "").trim();
      setKey("space.status", space.id, text || null);
      if (text) setShared("space.status.recent", [text, ...(shared("space.status.recent") ?? []).filter((r) => r !== text)].slice(0, 10));
      return true;
    }
  }
  return false;
}

// Waits until test() is true, checking every 100 ms; false after `ms`.
async function until(cx, test, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await cx.sleep(100)) if (test()) return true;
  return test();
}

// pane-move. A terminal moves by parking it (terminal.park: the pane goes, the program keeps
// running) and, once its pane is gone, giving it a pane again (terminal.keep) where it should
// go: a keep sent while the park is still pending is dropped. A mod pane closes and opens
// again with the same props. Same steps as the pane-menu mod's "Move to…" items.
async function paneMove(a, cx) {
  const from = panes().find((x) => (a.terminal && x.terminal === a.terminal) || (a.pane && x.pane === a.pane));
  if (!from) return fail(`pane-move: no pane with ${a.terminal ? `terminal "${a.terminal}"` : `pane "${a.pane}"`}`);
  if (!["new-tab", "tab", "new-space"].includes(a.to)) return fail('pane-move: to must be "new-tab", "tab" or "new-space"');
  const owner = spaces().find((s) => (s.tabs ?? []).some((t) => t.id === from.tab));
  const target = a.space != null ? spaceOf(a.space) : owner;
  if (a.to === "new-tab" && !target) return fail(`pane-move: no space "${a.space}"`);
  if (a.to === "tab" && !spaces().some((s) => (s.tabs ?? []).some((t) => t.id === a.tab))) return fail(`pane-move: no tab "${a.tab}"`);
  const shown = spaces().find((s) => s.active)?.id;
  const terminal = from.terminal;
  const mod = !terminal ? from.mod : null;
  // panes() leaves out a mod pane's props (which file md-review shows); Herdr's saved layout has them.
  let props = null;
  if (mod) {
    try {
      const d = JSON.parse(await readTextFile(`${home()}/.local/state/herdr-core/default/docs.json`))["herdr-app"].value;
      const find = (n) => n?.id === from.pane ? n : (n?.children ?? []).map(find).find(Boolean);
      for (const sp of d.spaces) for (const t of sp.tabs) props ??= find(t.root)?.content?.props ?? null;
    } catch {}
    if (!props) return fail("pane-move: couldn't read that mod pane's props from docs.json");
  }

  if (terminal) {
    run("terminal.park", { terminal });
    await until(cx, () => !panes().some((x) => x.terminal === terminal), 3000);
  } else run("pane.close", { pane: from.pane });

  let made = null;
  if (a.to === "new-tab") {
    run("space.select", { id: target.id });
    if (terminal) run("terminal.keep", { terminal, place: "tab" });
    else run("tab.new", { space: target.id, mod, props });
  } else if (a.to === "tab") {
    run("tab.select", { id: a.tab });
    if (terminal) run("terminal.keep", { terminal, place: "right" });
    else run("pane.split", { direction: "right", mod, props });
  } else {
    const old = owner?.tabs?.find((t) => t.id === from.tab);
    const name = a.name ?? (old?.named ? old.name : owner?.named ? owner.name : null);
    const before = new Set(spaces().map((s) => s.id));
    const machine = owner?.machine ?? null;
    run("space.new", { machine: machine ?? "", ...(name ? { name } : {}), ...(from.cwd ? { folder: from.cwd } : {}) });
    const ready = () => {
      made = spaces().find((s) => !before.has(s.id) && (s.machine ?? null) === machine);
      const tabs = new Set((made?.tabs ?? []).map((t) => t.id));
      return Boolean(made) && panes().some((x) => tabs.has(x.tab));
    };
    if (!(await until(cx, ready, 5000))) return fail("pane-move: the new space didn't appear");
    const tabs = new Set((made.tabs ?? []).map((t) => t.id));
    const shells = panes().filter((x) => tabs.has(x.tab));
    if (terminal) {
      run("terminal.keep", { terminal, place: "right" });
      await until(cx, () => panes().some((x) => x.terminal === terminal), 3000);
    } else run("pane.split", { direction: "right", mod, props });
    for (const x of shells) run("pane.close", { pane: x.pane });
    if (a.group != null) {
      const g = groupsOf();
      const [list, target] = ensureGroup(g.list, a.group, null, machine);
      setShared("space.groups", { list, of: { ...g.of, [made.id]: target.id } });
    }
  }
  if (shown && shown !== (made?.id ?? null)) {
    await cx.sleep(300);
    run("space.select", { id: shown });
  }
  return true;
}
