// Which computer's spaces this window's sidebar shows: settings.json "sidebar_machine" in this
// window's app home (Mod settings: "Only show spaces from"). "" or missing: every machine;
// "this computer": only this one's; a machine name ("pi"): only that machine's. Lets two Herdr
// windows (HERDR_APP_HOME) each show one context, e.g. a work window and a server window.
// spaces() and machines() here are Herdr's, filtered; the sidebar's files import them from here.
import { spaces as allSpaces, machines as allMachines, readTextFile, appHome, shared, setShared } from "herdr";

let fromFile; // undefined: not read yet; null: no setting
let reading = false;

function wanted() {
  const extra = shared("settings.extra");
  if (extra && "sidebar_machine" in extra) return norm(extra.sidebar_machine);
  if (fromFile === undefined && !reading) {
    reading = true;
    readTextFile(`${appHome()}/settings.json`).then((raw) => {
      try { fromFile = JSON.parse(raw ?? "{}").sidebar_machine ?? null; } catch { fromFile = null; }
      setShared("sidebar.machine.read", Date.now()); // redraw with the setting applied
    }).catch(() => { fromFile = null; });
  }
  return norm(fromFile);
}

// undefined: show all; null: this computer; a name: that machine.
function norm(v) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return undefined;
  return /^(this computer|this|local|here)$/i.test(s) ? null : s;
}

export function spaces() {
  const w = wanted();
  const sp = allSpaces();
  return w === undefined ? sp : sp.filter((s) => (s.machine ?? null) === w);
}

export function machines() {
  const w = wanted();
  const ms = allMachines();
  return w === undefined ? ms : ms.filter((m) => (m.name ?? null) === w);
}

// Whether this window shows machine `name` (null or "": this computer).
export function machineShown(name) {
  const w = wanted();
  return w === undefined || (name || null) === w;
}
