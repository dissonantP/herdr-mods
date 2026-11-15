// CPU, memory and GPU load in the status bar: a small live graph and a percent for each.
// macOS: reads `iostat`, `vm_stat`, `sysctl` and `ioreg`, none of which need root.
// WSL: shows all of Windows, not the WSL machine. windows-load.ps1 runs in Windows PowerShell,
// samples Windows' performance counters every 2 s into a JSON file, and stops by itself
// 30 s after this mod last read it (Herdr closed).
// Based on Lakris2407's herdr-quota system mod (MIT).
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, theme, settings, window, readTextFile, home, appHome, props, openOverlay } from "herdr";

const EVERY = 3000, HISTORY = 12;
// One shell call per read. `iostat` samples the CPU over 1 s; the first report line is the average since boot.
const SCRIPT = [
  "iostat -n 0 -c 2 -w 1 | tail -1",
  "echo ---", "vm_stat",
  "echo ---", "sysctl -n hw.memsize",
  "echo ---", "ioreg -r -d 1 -c IOAccelerator | grep -o '\"Device Utilization %\"=[0-9]*'",
].join("; ");

// Same scale as the quota bars: green, amber from 60%, orange from 80%, red from 92%.
function level(pct) {
  const dark = settings().dark !== false;
  const scale = dark ? ["#5ed49a", "#f2c14e", "#f59152", "#f2665c"] : ["#1f9d63", "#c98a0b", "#dd6b20", "#d64545"];
  return scale[pct >= 92 ? 3 : pct >= 80 ? 2 : pct >= 60 ? 1 : 0];
}

const gb = bytes => `${(bytes / 2 ** 30).toFixed(1)} GB`;

const DIR = `${home()}/.cache/herdr-system`, OUT = `${DIR}/load.json`, BEAT = `${DIR}/heartbeat`;
let started = 0;

// Windows, from WSL: the sampler's last JSON. Starts the sampler when the file is missing or
// stale (none running), at most once every 20 s.
async function readWindows() {
  await exec("sh", ["-c", 'mkdir -p "$1" && touch "$2"', "sh", DIR, BEAT]);
  let d = null;
  try { d = JSON.parse((await readTextFile(OUT)) ?? "null"); } catch {}
  if ((!d || Date.now() - d.at > 10000) && Date.now() - started > 20000) {
    started = Date.now();
    const ps1 = `${appHome()}/mods/system/windows-load.ps1`;
    await exec("sh", ["-c", 'nohup powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$1")" "$(wslpath -w "$2")" "$(wslpath -w "$3")" >/dev/null 2>&1 &', "sh", ps1, OUT, BEAT]);
  }
  if (!d || Date.now() - d.at > 10000) throw new Error("Starting the Windows load sampler…");
  const mb = n => n * 2 ** 20;
  return {
    cpu: { pct: d.cpu, tip: `Windows CPU ${Math.round(d.cpu)}% · user ${Math.round(d.user)}%, system ${Math.round(d.system)}%` },
    ram: { pct: d.usedMB / d.totalMB * 100, tip: `Windows memory ${gb(mb(d.usedMB))} of ${gb(mb(d.totalMB))} used` },
    gpu: d.gpu == null ? null : { pct: d.gpu, tip: `GPU ${Math.round(d.gpu)}% busy (busiest engine)` },
  };
}

const onWsl = async () => (onWsl.v ??= (await exec("sh", ["-c", "test -e /proc/sys/fs/binfmt_misc/WSLInterop"]).catch(() => ({ code: 1 }))).code === 0);

async function read() {
  if (window()?.platform === "linux" && await onWsl()) return readWindows();
  const r = await exec("sh", ["-c", SCRIPT]);
  if (r.code !== 0 && !r.stdout) throw new Error((r.stderr || `exit ${r.code}`).trim());
  const [cpuOut, vmOut, memOut, gpuOut] = r.stdout.split("---\n");
  const [user, sys, idle] = cpuOut.trim().split(/\s+/).map(Number);
  // Activity Monitor's "Memory Used": app memory (anonymous minus purgeable) + wired + compressed.
  const page = Number(/page size of (\d+)/.exec(vmOut)?.[1] ?? 16384);
  const pages = name => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(vmOut)?.[1] ?? 0);
  const total = Number(memOut.trim());
  const used = (pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor")) * page;
  // Apple Silicon has one GPU; a Mac with two reports both, so take the busier one.
  const gpus = [...gpuOut.matchAll(/=(\d+)/g)].map(m => Number(m[1]));
  return {
    cpu: { pct: 100 - idle, tip: `CPU ${Math.round(100 - idle)}% · user ${Math.round(user)}%, system ${Math.round(sys)}%` },
    ram: { pct: total ? used / total * 100 : 0, tip: `Memory ${gb(used)} of ${gb(total)} used` },
    gpu: gpus.length ? { pct: Math.max(...gpus), tip: `GPU ${Math.max(...gpus)}% busy` } : null,
  };
}

// The programs using the most memory, summed over each program's processes:
// [{ name, mb, count }], biggest first. Read once each time the RAM popup opens.
const TOP = 15;
const PS_TOP = "Get-Process | Group-Object ProcessName | ForEach-Object { [pscustomobject]@{ name = $_.Name; " +
  "mb = [math]::Round(($_.Group | Measure-Object WorkingSet64 -Sum).Sum / 1MB); count = $_.Count } } | " +
  `Sort-Object mb -Descending | Select-Object -First ${TOP} | ConvertTo-Json -Compress`;
async function topMemory() {
  if (window()?.platform === "linux" && await onWsl()) {
    const r = await exec("powershell.exe", ["-NoProfile", "-Command", PS_TOP]);
    if (r.code !== 0) throw new Error((r.stderr || `exit ${r.code}`).trim());
    return JSON.parse(r.stdout);
  }
  // macOS and Linux: resident memory per command, in KB.
  const r = await exec("ps", ["-axo", "rss=,comm="]);
  const by = new Map();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const name = m[2].split("/").pop(), e = by.get(name) ?? { name, mb: 0, count: 0 };
    e.mb += Number(m[1]) / 1024; e.count++; by.set(name, e);
  }
  return [...by.values()].sort((a, b) => b.mb - a.mb).slice(0, TOP).map(e => ({ ...e, mb: Math.round(e.mb) }));
}

// The machine's whole memory in MB, for the popup's percentages: on WSL, Windows' (the sampler's
// file); on a Mac, sysctl; on Linux, /proc/meminfo.
async function totalMemoryMB() {
  if (window()?.platform === "linux" && await onWsl()) return JSON.parse((await readTextFile(OUT)) ?? "null")?.totalMB ?? null;
  const r = await exec("sh", ["-c", "sysctl -n hw.memsize 2>/dev/null || awk '/MemTotal/ {print $2 * 1024}' /proc/meminfo"]);
  return Number(r.stdout.trim()) / 2 ** 20 || null;
}

// The last HISTORY reads as thin columns, newest on the right, tallest at 100%.
function graph(history, t) {
  const cols = Array.from({ length: HISTORY }, (_, i) => history[history.length - HISTORY + i]);
  return h_flex().h(12).gap(1).items_end().flex_none()
    .children(cols.map(pct => div().w(2).rounded(1)
      .h(pct === undefined ? 1 : Math.max(1, Math.round(pct / 100 * 12)))
      .bg(pct === undefined ? t.border : level(pct)).opacity(pct === undefined ? 1 : 0.85)));
}

export default class System extends View {
  init(_props, cx) {
    // The RAM popup (props().ram): the top programs by memory, read once.
    if (props()?.ram) {
      cx.spawn(async cx => {
        try { [this.top, this.totalMB] = await Promise.all([topMemory(), totalMemoryMB()]); } catch (e) { this.error = String(e.message ?? e); }
        cx.notify();
      });
      return;
    }
    this.history = { cpu: [], ram: [], gpu: [] };
    this.last = null;
    this.refresh(cx);
    cx.timer.every(EVERY, cx => this.refresh(cx));
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        this.last = await read();
        this.error = null;
        for (const key of ["cpu", "ram", "gpu"]) {
          if (!this.last[key]) continue;
          this.history[key].push(this.last[key].pct);
          if (this.history[key].length > HISTORY) this.history[key].shift();
        }
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // The RAM popup: one row per program, with a bar filled to its share of all memory.
  ramPopup(t) {
    const rows = this.top ?? [], max = Math.max(1, ...rows.map(r => r.mb));
    const size = mb => mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
    return div().id("system-ram").size_full().p(10).bg(t.panel ?? t.chrome).text_size(12).text_color(t.text ?? t.muted)
      .child(div().text_size(11).text_color(t.dim).pb(6).child("Memory by program"))
      .when(!this.top && !this.error, el => el.child(div().text_color(t.dim).child("Reading…")))
      .when(Boolean(this.error), el => el.child(div().text_color(t.dim).child(this.error)))
      .children(rows.map(r => h_flex().gap(8).items_center().py(2)
        .child(div().flex_1().overflow_hidden().child(r.count > 1 ? `${r.name} (${r.count})` : r.name))
        .child(div().w(70).h(4).rounded(2).bg(t.border).child(div().h(4).rounded(2).w(Math.max(2, Math.round(r.mb / (this.totalMB || max) * 70))).bg(level(this.totalMB ? r.mb / this.totalMB * 100 : 0))))
        .when(Boolean(this.totalMB), el => el.child(div().w(40).flex_none().text_color(level(r.mb / this.totalMB * 100)).child(`${(r.mb / this.totalMB * 100).toFixed(r.mb / this.totalMB >= 0.1 ? 0 : 1)}%`)))
        .child(div().w(56).flex_none().text_color(t.dim).child(size(r.mb)))));
  }

  render(cx) {
    const t = theme(), now = this.last;
    if (props()?.ram) return this.ramPopup(t);
    // Narrow status bar: drop the graphs first, then the GPU, so CPU and RAM always show.
    const w = this.width ?? Infinity, graphs = w >= 300, gpu = w >= 170;
    const metric = (key, label) => {
      const m = now?.[key];
      if (now && !m) return null;
      return h_flex().id(`sys-${key}`).gap(5).items_center().flex_none().tooltip(m?.tip ?? label)
        // RAM opens the memory-by-program popup instead of Task Manager / Activity Monitor.
        .when(key === "ram", el => el.on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "system", kind: "popup", width: 360, height: 380, props: { ram: true } }); }))
        .child(div().text_size(10).text_color(t.dim).child(label))
        .when(graphs, el => el.child(graph(this.history[key], t)))
        .child(div().min_w(26).text_size(11).text_color(m && m.pct >= 60 ? level(m.pct) : t.muted).child(m ? `${Math.round(m.pct)}%` : "–"));
    };
    return h_flex().id("system").size_full().px(graphs ? 12 : 8).gap(graphs ? 12 : 8).items_center().justify_end().overflow_hidden()
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted).cursor_pointer()
      .on_size_change((size, cx) => { const w = size.width / (settings().zoom || 1); if (w !== this.width) { this.width = w; cx.notify(); } })
      .on_click(() => (window()?.platform === "macos"
        ? exec("open", ["-a", "Activity Monitor"]) : exec("sh", ["-c", "nohup cmd.exe /c start taskmgr >/dev/null 2>&1 &"])).catch(() => {}))
      .when(Boolean(this.error) && !now, el => el.child(div().text_color(t.dim).tooltip(this.error).child("System load unavailable")))
      .when(!this.error || Boolean(now), el => el.children([metric("cpu", "CPU"), metric("ram", "RAM"), gpu && metric("gpu", "GPU")].filter(Boolean)))
      .child(div().w(1).h(12).ml(2).flex_none().bg(t.border));
  }
}
