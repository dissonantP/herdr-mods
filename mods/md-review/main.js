// A markdown file as a pane: Read mode renders it with a comment button on each block,
// Edit mode is the raw text. Comments are saved in the file itself, under the block they
// are about, as `<!-- <author>: ... -->`, so an agent reading the file sees them in place. The author is
// settings.json's "md_review_author" (Herdr's settings() leaves custom keys out, so the file is read), default "Comment".
// Open: herdr-app do pane.split --direction right --mod md-review --props '{"file":"/path/to/file.md"}'
import { View, div, list } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Textarea, TextareaState, Input, InputState, Scrollbar, VirtualListScrollHandle, ScrollHandle } from "gpui-base";
import { props, readTextFile, writeTextFile, watchFolder, theme, settings, panes, focused, openOverlay, nextCommand, shared, setShared, appHome, window, run, home, exec } from "herdr";

let AUTHOR = "Comment";
let COMMENT_START = new RegExp(`^(\\s*)<!--\\s*${AUTHOR}:`);
// Read before each load of the file, so a changed name applies the next time a file opens or reloads.
async function readAuthor() {
  let name;
  try { name = JSON.parse((await readTextFile(`${appHome()}/settings.json`)) ?? "{}").md_review_author; } catch {}
  AUTHOR = typeof name === "string" && name.trim() ? name.trim() : "Comment";
  COMMENT_START = new RegExp(`^(\\s*)<!--\\s*${AUTHOR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`);
}
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s/;
const FENCE = /^\s*(```|~~~)/;

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
// zoom that panel (see keyZoom in spaces-grouped) and the terminals everywhere else.
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

// When Herdr runs on Linux (e.g. in WSL), a Windows path (C:\...) becomes its /mnt/c/... path.
// On Windows and macOS the path is left as given.
function linuxPath(path) {
  const p = path.trim().replace(/^"|"$/g, "");
  if (window()?.platform !== "linux") return p;
  const win = p.match(/^([a-z]):[\\/](.*)$/i);
  return win ? `/mnt/${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}` : p;
}

// Splits the file into commentable blocks: a heading, a list item (with its indented
// continuation), a fenced code block, a table, or a paragraph. Comment lines after a
// block attach to it.
function parse(lines) {
  const blocks = [], loose = [];
  const blank = i => lines[i].trim() === "";
  const isComment = i => COMMENT_START.test(lines[i]);
  const startsBlock = i => blank(i) || isComment(i) || FENCE.test(lines[i]) || /^\s*#/.test(lines[i]) || LIST_ITEM.test(lines[i]) || /^\s*\|/.test(lines[i]);
  const fenceEnd = i => { const f = lines[i].trim().slice(0, 3); let j = i + 1; while (j < lines.length && !lines[j].trim().startsWith(f)) j++; return Math.min(j, lines.length - 1); };
  let i = 0;
  while (i < lines.length) {
    if (blank(i)) { i++; continue; }
    if (isComment(i)) {
      let end = i; while (end < lines.length - 1 && !lines[end].includes("-->")) end++;
      const body = lines.slice(i, end + 1).join("\n").replace(COMMENT_START, "").replace(/-->\s*$/, "").replace(/\n\s*/g, "\n").trim();
      (blocks.at(-1)?.comments ?? loose).push({ start: i, end, text: body.replace(/--&gt;/g, "-->") });
      i = end + 1; continue;
    }
    const start = i; let indent = 0, list = false;
    if (FENCE.test(lines[i])) i = fenceEnd(i) + 1;
    else if (/^\s*#/.test(lines[i])) i++;
    else if (/^\s*\|/.test(lines[i])) { while (i < lines.length && /^\s*\|/.test(lines[i])) i++; }
    else if (LIST_ITEM.test(lines[i])) {
      list = true; indent = lines[i].match(LIST_ITEM)[1].length; i++;
      for (;;) {
        let j = i; while (j < lines.length && blank(j)) j++;
        if (j >= lines.length || isComment(j) || LIST_ITEM.test(lines[j])) break;
        const deeper = lines[j].match(/^\s*/)[0].length > indent;
        if (!deeper && (j > i || startsBlock(j))) break;
        i = FENCE.test(lines[j]) ? fenceEnd(j) + 1 : j + 1;
      }
    } else { i++; while (i < lines.length && !startsBlock(i)) i++; }
    const end = i - 1;
    const md = lines.slice(start, end + 1).map(l => l.slice(Math.min(indent, l.match(/^\s*/)[0].length))).join("\n");
    blocks.push({ start, end, md, indent, list, comments: [] });
  }
  return { blocks, loose };
}

// This md-review pane's id, from Herdr's saved layout (docs.json): the md-review block showing `file`.
async function paneOfFile(file) {
  if (!file) return null;
  try {
    const d = JSON.parse((await readTextFile(`${home()}/.local/state/herdr-core/default/docs.json`)) ?? "{}")["herdr-app"]?.value;
    const walk = (n) => n?.content?.mod === "md-review" && n.content.props?.file === file ? n : (n?.children ?? []).map(walk).find(Boolean);
    for (const sp of d?.spaces ?? []) for (const t of sp.tabs ?? []) { const n = walk(t.root); if (n) return n.id; }
  } catch {}
  return null;
}

// Links: Obsidian wikilinks ([[name]], [[folder/name|label]], [[name#heading]]) become markdown
// links to "wiki:<name>" so TextView can show and report them; links() lists a block's targets.
const WIKI = /\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
const MDLINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
// Text to copy: comment lines left out, wikilinks as their label.
function copyText(md) {
  return md.split(/\r?\n/).filter((l) => !/^\s*<!--[\s\S]*-->\s*$/.test(l)).join("\n")
    .replace(WIKI, (_m, name, _h, label) => label ?? name.trim()).trim();
}
function withWikiLinks(md) {
  return md.replace(WIKI, (_m, name, _h, label) => `[${label ?? name}](wiki:${encodeURIComponent(name.trim())})`);
}
// Files up to this many blocks render as a plain scroll area, whose rows can hold handlers, so
// a click on a link opens it. Bigger files use the virtual list (fast, but its rows can't hold
// handlers: there, links open from the buttons a clicked block's composer shows).
const PLAIN_MAX = 400;
function links(md) {
  const out = [];
  for (const m of md.matchAll(WIKI)) out.push({ label: m[3] ?? m[1].trim(), url: `wiki:${encodeURIComponent(m[1].trim())}` });
  for (const m of md.matchAll(MDLINK)) if (/^https?:|\.md(#|$)/i.test(m[2])) out.push({ label: m[1] || m[2], url: m[2] });
  return out;
}
// The Obsidian vault holding `file`: the nearest folder above it with a .obsidian folder.
// One `find` lists the folders above at once (each exec costs time), and the answer is kept.
const vaults = new Map(); // folder -> vault (or null)
async function vaultOf(file) {
  const dir = file.replace(/\/[^/]*$/, "");
  if (vaults.has(dir)) return vaults.get(dir);
  const ups = [];
  for (let d = dir; d && d !== "/"; d = d.replace(/\/[^/]*$/, "")) ups.push(d);
  const r = await exec("sh", ["-c", 'for d in "$@"; do [ -d "$d/.obsidian" ] && { echo "$d"; break; }; done', "sh", ...ups]).catch(() => null);
  const v = (r?.stdout ?? "").trim() || null;
  vaults.set(dir, v);
  return v;
}
// Every .md file in a vault by name (without .md), from one `find` (skipping reference/ folders),
// kept for the session and refreshed when a name isn't in it.
const indexes = new Map(); // vault -> Promise<Map<name, paths[]>>
const indexedAt = new Map(); // vault -> when its index was built (ms)
// An index older than a minute is rebuilt: files added since (a new folder of notes with the
// same names as older ones) would otherwise be missed and the older files opened instead.
function indexOf(vault, fresh = false) {
  if (!fresh && indexes.has(vault) && Date.now() - indexedAt.get(vault) < 60000) return indexes.get(vault);
  indexedAt.set(vault, Date.now());
  const p = exec("find", [vault, "-type", "d", "-name", "reference", "-prune", "-o", "-type", "f", "-name", "*.md", "-print"], { timeout: 30000 })
    .then((r) => {
      const m = new Map();
      for (const path of (r?.stdout ?? "").split("\n")) {
        if (!path) continue;
        const name = path.split("/").pop().replace(/\.md$/i, "");
        (m.get(name) ?? m.set(name, []).get(name)).push(path);
      }
      return m;
    })
    .catch(() => new Map());
  indexes.set(vault, p);
  return p;
}
// Warms the vault and its index when a file opens, so the first link click is quick.
function warmLinks(file) {
  vaultOf(file).then((v) => v && indexOf(v)).catch(() => null);
}
// A link's file: a wikilink by name within the vault (the match nearest the current file wins,
// like Obsidian), a relative .md link from the current file's folder. Null for web links.
async function resolveLink(url, from) {
  const dir = from.replace(/\/[^/]*$/, "");
  if (url.startsWith("wiki:")) {
    const name = decodeURIComponent(url.slice(5)).replace(/\.md$/i, "");
    const vault = await vaultOf(from) ?? dir;
    const base = name.split("/").pop();
    // Like Obsidian: a note of that name beside the linking note wins.
    const beside = `${dir}/${base}.md`;
    if (!name.includes("/") && (await readTextFile(beside).catch(() => null)) !== null) return beside;
    const fits = (h) => !name.includes("/") || h.endsWith(`/${name}.md`);
    let hits = ((await indexOf(vault)).get(base) ?? []).filter(fits);
    if (!hits.length) hits = ((await indexOf(vault, true)).get(base) ?? []).filter(fits);
    // Nearest: the most leading path segments shared with the current file's folder.
    const shared = (h) => { let n = 0; const a = h.split("/"), b = dir.split("/"); while (n < a.length && a[n] === b[n]) n++; return n; };
    return [...hits].sort((a, b) => shared(b) - shared(a))[0] ?? null;
  }
  if (/^[a-z]+:/i.test(url)) return null;
  const rel = decodeURIComponent(url.replace(/#.*$/, ""));
  const parts = (rel.startsWith("/") ? rel : `${dir}/${rel}`).split("/");
  const out = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p !== "." && p !== "") out.push(p); }
  return "/" + out.join("/");
}

export default class MdReview extends View {
  init(_props, cx) {
    // spaces-grouped sends "zoom-in"/"zoom-out"/"zoom-reset" when Ctrl+plus/minus/0 is pressed over this pane.
    cx.spawn(async (cx) => { for (;;) { if (zoomCommand(await nextCommand())) cx.notify(); } });
    this.pathInput = InputState.new({ placeholder: "Path to a .md file" });
    this.pathInput.on("submit", (_e, cx) => this.open(this.pathInput.value(), cx));
    this.mode = "read";
    // Saving a comment rewrites the file and rebuilds the list, which drops its scroll
    // position; this handle lets saveComment scroll back to the commented block.
    this.scroll = VirtualListScrollHandle.new();
    this.plainScroll = ScrollHandle.new(); // the plain (non-virtual) view, see readView
    cx.timer.every(2000, cx => cx.spawn(async cx => this.reloadFromDisk(cx)));
    const file = props()?.file;
    if (file) this.open(file, cx);
  }

  open(file, cx, push = false) {
    if (push && this.path) (this.history ??= []).push(this.path);
    this.path = linuxPath(file);
    warmLinks(this.path);
    this.text = null; this.error = null; this.compose = null; this.setMode("read");
    this.load(cx);
    this.watch(cx);
  }

  load(cx) {
    const path = this.path;
    cx.spawn(async cx => {
      try {
        await readAuthor();
        const text = await readTextFile(path);
        if (path !== this.path) return;
        if (text === null) { this.error = `Can't find ${path}`; return; }
        this.setText(text);
        this.changedOnDisk = false;
      } catch (e) { this.error = String(e); }
      finally { cx.notify(); }
    });
  }

  watch(cx) {
    const path = this.path, dir = path.replace(/[\\/][^\\/]*$/, "");
    cx.spawn(async cx => {
      while (this.path === path) {
        let changed;
        try { changed = await watchFolder(dir); } catch { return; }
        if (this.path !== path) return;
        if (!changed.some(p => p === path || p === dir)) continue;
        await this.reloadFromDisk(cx);
      }
    });
  }

  // Shows the file's new text when it changed on disk. Called by the watcher and by the
  // 2-second poll in init: on 2026-11-04 the watcher alone missed writes, so the poll backs it up.
  async reloadFromDisk(cx) {
    const path = this.path;
    if (!path || this.text === null || this.reloading) return;
    this.reloading = true;
    try {
      const text = await readTextFile(path).catch(() => null);
      if (path !== this.path || text === null || text === this.text) return;
      if (this.mode === "edit" && this.dirty) { if (!this.changedOnDisk) { this.changedOnDisk = true; cx.notify(); } return; }
      this.setText(text);
      if (this.mode === "edit") this.editor.set_value(text);
      cx.notify();
    } finally { this.reloading = false; }
  }

  // Parses here, outside render: parsing and drawing the queue in one render ran past
  // Herdr's time limit on a fresh open ("interrupted").
  setText(text) {
    this.text = text;
    this.parsed();
  }

  lines() {
    return this.text.split(/\r?\n/);
  }

  eol() {
    return this.text.includes("\r\n") ? "\r\n" : "\n";
  }

  // Writes the new text only if the file still holds what this pane last read.
  write(next, cx, after) {
    const expected = this.text;
    cx.spawn(async cx => {
      try {
        await writeTextFile(this.path, next, expected);
        this.setText(next); this.error = null; this.changedOnDisk = false;
        after?.();
      } catch (e) {
        this.error = "The file changed on disk since it was loaded, so nothing was saved. Reload and try again.";
      } finally { cx.notify(); }
    });
  }

  saveComment(block, cx) {
    const { comment, replace } = this.compose;
    const body = this.composeInput.value().trim().replace(/-->/g, "--&gt;");
    const lines = this.lines();
    const pad = block.list ? " ".repeat(block.indent + 2) : "";
    const commentLines = body ? `${pad}<!-- ${AUTHOR}: ${body} -->`.split("\n").map((l, i) => i ? pad + l.trimStart() : l) : [];
    if (replace) lines.splice(comment.start, comment.end - comment.start + 1, ...commentLines);
    else {
      if (!body) { this.closeCompose(); cx.notify(); return; }
      const at = (block.comments.at(-1)?.end ?? block.end) + 1;
      lines.splice(at, 0, ...commentLines);
    }
    this.write(lines.join(this.eol()), cx, () => { this.closeCompose(); this.scrollToBlock(block); });
  }

  // A block above the edit keeps its start line, so it can be found again in the reparsed list.
  scrollToBlock(block) {
    const index = this.parsed().findIndex(i => !i.comment && i.block.start === block.start);
    if (this.parsed().length <= PLAIN_MAX) this.plainScroll.scroll_to_item(Math.max(index, 0));
    else this.scroll.scroll_to_item(Math.max(index, 0), "center");
  }

  deleteComment(comment, cx) {
    const lines = this.lines();
    lines.splice(comment.start, comment.end - comment.start + 1);
    this.write(lines.join(this.eol()), cx);
  }

  startCompose(item, comment, cx) {
    this.composeInput?.release();
    this.composeInput = TextareaState.new({ placeholder: "Comment…", value: comment?.text ?? "", rows: 3 });
    // The textarea keeps Ctrl+Enter for itself and reports it as a "submit" with `secondary`,
    // so the composer's on_key_down never sees it. Plain Enter also submits, without `secondary`.
    this.composeInput.on("submit", (e, cx) => { if (e.secondary && this.compose) this.saveComment(this.compose.item.block, cx); });
    this.composeInput.focus();
    this.compose = { item, comment, replace: Boolean(comment) };
    cx.notify();
  }

  closeCompose() {
    this.composeInput?.release(); this.composeInput = null; this.compose = null;
  }

  setMode(mode, cx) {
    if (mode === "edit" && this.text !== null && this.text !== undefined) {
      this.editor?.release();
      // Plain text: markdown syntax colors took about 1.1 s to load a 190 KB file, plain text 3 ms.
      this.editor = EditorState.new({ language: "txt", value: this.text, soft_wrap: true,
        font_family: settings().font_family, font_size: z(13) });
      this.dirty = false;
      this.editor.on("change", (_e, cx) => { if (!this.dirty) { this.dirty = true; cx.notify(); } });
    } else if (mode === "read") { this.editor?.release(); this.editor = null; this.dirty = false; }
    this.mode = mode;
    cx?.notify();
  }

  saveEdit(cx, then) {
    if (this.mode !== "edit" || !this.dirty) { then?.(); return; }
    const next = this.editor.value();
    this.write(next, cx, () => { this.dirty = false; then?.(); });
  }

  button(id, label, onClick, t, primary = false) {
    return div().id(id).px(z(10)).h(z(26)).flex_none().flex().items_center().rounded(z(6)).cursor_pointer().text_size(z(12))
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover(s => s.bg(primary ? t.accent : t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
  }

  // Opens a link's target in this pane (Back returns); a web link opens in the browser.
  followLink(url, cx) {
    this.linkAt = Date.now();
    if (/^https?:/i.test(url)) { exec("explorer.exe", [url]).catch(() => null); return; }
    cx.spawn(async (cx) => {
      const file = await resolveLink(url, this.path);
      if (file) this.open(file, cx, true);
      else this.error = `Couldn't find the linked file: ${decodeURIComponent(url.replace(/^wiki:/, ""))}`;
      cx.notify();
    });
  }

  back(cx) {
    const prev = this.history?.pop();
    if (prev) this.open(prev, cx);
    cx.notify();
  }

  // The composer sits below the list: a virtual list's rows can't hold handlers or text boxes.
  composer(t) {
    const { item, comment } = this.compose;
    const block = item.block;
    return v_flex().id("compose").flex_none().p(z(10)).gap(z(6)).border_t(1).border_color(t.border).bg(t.raised)
      .on_key_down((e, cx) => {
        if (e.key === "enter" && e.modifiers.control) { cx.stop_propagation(); this.saveComment(block, cx); }
        else if (e.key === "escape") { cx.stop_propagation(); this.closeCompose(); cx.notify(); }
      })
      .when(links(block.md).length > 0, (el) => el.child(h_flex().gap(z(6)).flex_wrap().items_center()
        .child(div().text_size(z(11)).text_color(t.dim).child("Open link:"))
        .children(links(block.md).map((l, i) => div().id(`link-${i}`).px(z(8)).h(z(22)).flex().items_center().rounded(z(5)).cursor_pointer()
          .text_size(z(11.5)).bg(t.background).text_color(t.accent).hover((st) => st.bg(t.hover))
          .on_click((_e, cx) => { this.closeCompose(); this.followLink(l.url, cx); })
          .child(l.label)))))
      .child(div().text_size(z(11)).text_color(t.dim).truncate().child((comment ? "Editing comment on: " : "Comment on: ") + block.md.split("\n")[0].trim()))
      .child(Textarea.new(this.composeInput).w_full().h(z(72)).text_size(z(12)).p(z(6)).rounded(z(4)).bg(t.background).border_1().border_color(t.input))
      .child(h_flex().gap(z(6)).items_center()
        .child(div().flex_1().text_size(z(11)).text_color(t.dim).child("Ctrl+Enter saves · Esc cancels"))
        .when(Boolean(comment), el => el.child(this.button("delete", "Delete", cx => { this.deleteComment(comment, cx); this.closeCompose(); }, t)))
        .child(this.button("cancel", "Cancel", cx => { this.closeCompose(); cx.notify(); }, t))
        .child(this.button("save", comment ? "Save" : "Comment", cx => this.saveComment(block, cx), t, true)));
  }

  // Parsed once per file version: Herdr's JavaScript is too slow to redo it on every redraw.
  parsed() {
    if (this.parsedText === this.text) return this.parsedItems;
    const { blocks, loose } = parse(this.lines());
    const items = [];
    const top = { list: false, indent: 0, end: -1, comments: loose, md: "(top of file)" };
    for (const c of loose) items.push({ key: `n:${c.start}`, block: top, comment: c });
    blocks.forEach(block => {
      items.push({ key: `b:${block.start}:${block.md.length}`, block });
      for (const c of block.comments) items.push({ key: `n:${c.start}`, block, comment: c });
    });
    this.items = new Map(items.map(i => [i.key, i]));
    this.parsedText = this.text; this.parsedItems = items;
    return items;
  }

  // "Select text": the whole document (comments left out) as one selectable text, so a selection
  // can run across paragraphs and Ctrl+C copies it. Links still open; no comment boxes here.
  selectView(t) {
    if (this.selectText !== this.text) { this.selectText = this.text; this.selectMd = withWikiLinks(this.text.split(/\r?\n/).filter((l) => !/^\s*<!--[\s\S]*-->\s*$/.test(l)).join("\n")); }
    return v_flex().id("md-select").flex_1().min_h(0).overflow_y_scrollbar().px(z(12)).py(z(10))
      .child(TextView.markdown("md-select-text", this.selectMd).selectable(true).on_link_click((url, cx) => this.followLink(url, cx)));
  }

  readView(t) {
    const items = this.parsed();
    const plain = items.length <= PLAIN_MAX;
    const active = this.compose?.item.key;
    const row = item => {
      const on = item.key === active;
      if (item.comment) return h_flex().ml(z(item.block.list ? 24 : 6)).mr(z(6)).my(z(2)).p(z(8)).gap(z(8)).items_start().rounded(z(6))
        .bg(on ? t.selected : t.raised).border_l(3).border_color(t.accent).cursor_pointer()
        .child(div().text_size(z(11)).font_semibold().text_color(t.accent).flex_none().child(AUTHOR))
        .child(div().flex_1().min_w(0).text_size(z(12)).child(item.comment.text));
      const block = div().px(z(6)).pt(z(/^\s*#/.test(item.block.md) ? 18 : 6)).pb(z(6)).rounded(z(6)).cursor_pointer().bg(on ? t.selected : t.background).hover(s => s.bg(t.hover));
      const text = TextView.markdown(`md-${item.key}`, withWikiLinks(item.block.md)).selectable(true);
      // A virtual list's rows can't hold handlers (a link handler there blanked the whole list).
      return plain ? block.child(text.on_link_click((url, cx) => this.followLink(url, cx))) : block.child(text);
    };
    const click = (key, cx) => { if (Date.now() - (this.linkAt ?? 0) < 400) return; const item = this.items.get(key); if (item) this.startCompose(item, item.comment, cx); };
    if (plain) return v_flex().relative().flex_1().min_h(0)
      .child(v_flex().id("md-read").size_full().py(z(6)).overflow_y_scroll().track_scroll(this.plainScroll)
        // A drag (selecting text to copy) isn't a click: the press and release must be within 4 px.
        .children(items.map((item) => row(item).id(`row-${item.key}`)
          .on_mouse_down("left", (e) => { this.pressAt = e.position; })
          .on_mouse_down("right", () => { this.rightBlock = item.comment ? item.comment.text : item.block.md; })
          .on_mouse_up("left", (e) => { const a = this.pressAt; this.dragged = Boolean(a) && Math.hypot(e.position.x - a.x, e.position.y - a.y) > 4; })
          .on_click((_e, cx) => { if (!this.dragged) click(item.key, cx); }))))
      .child(Scrollbar.vertical("md-read").absolute().inset_0());
    return v_flex().relative().flex_1().min_h(0).py(z(6))
      .child(list("md-read", items.length, i => items[i].key, i => row(items[i])).track_scroll(this.scroll)
        .on_item_click(click))
      .child(Scrollbar.vertical("md-read").absolute().inset_0());
  }

  // A pane closing under the mouse never reports leaving: drop the zoom target it set,
  // so Ctrl+plus/minus go back to the terminals.
  async close() {
    if (shared("zoom.hover") === "md-review") setShared("zoom.hover", null);
  }

  // This pane's id: from its props if Herdr puts it there, else the focused md-review pane.
  ownPane() {
    const mine = panes().filter((p) => p.mod === "md-review");
    return props()?.pane ?? mine.find((p) => p.focused)?.pane ?? mine.find((p) => p.tab === focused()?.tab)?.pane;
  }

  // Right-click: the pane menu (pane-menu mod) with the move items, as for a terminal pane.
  // Right-click: the pane menu (pane-menu mod) with the move items, as for a terminal pane, plus
  // "Copy this block" (the block right-clicked, recorded by its row) and "Copy whole document".
  menu() {
    const pane = this.paneId ?? this.ownPane();
    const copy = { block: this.rightBlock ? copyText(this.rightBlock) : null, doc: this.text ? copyText(this.text) : null };
    this.rightBlock = null;
    openOverlay({ mod: "pane-menu", kind: "popup", props: { tab: "pane", target: { pane, mod: "md-review", props: { file: this.path }, copy } } });
  }

  render(cx) {
    const t = theme();
    const name = this.path ? this.path.split(/[\\/]/).pop() : "Markdown review";
    const root = v_flex().id("md-review").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(z(13)).on_scroll_wheel(zoomWheel).on_hover((h) => { hoverMod("md-review", h); if (h) setShared("md-review.hover", this.path ?? props()?.file ?? null); })
      // Herdr doesn't focus a mod pane on click, so keys meant for it (Ctrl+Shift+Z) went to the
      // pane focused before. A left click focuses this pane, found by its file in Herdr's layout.
      .on_mouse_down("left", (_e, cx) => cx.spawn(async () => {
        const pane = this.paneId ?? (this.paneId = await paneOfFile(props()?.file));
        if (pane && !panes().find((p) => p.pane === pane)?.focused) run("pane.focus", { pane });
      }))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(); })
      .on_drop((e, cx) => { if (e.paths[0]) { this.open(e.paths[0], cx); cx.notify(); } })
      .on_key_down((e, cx) => { if (e.key === "s" && e.modifiers.control && this.mode === "edit") { cx.stop_propagation(); this.saveEdit(cx); } });

    if (!this.path) return root.child(v_flex().p(z(16)).gap(z(10))
      .child(div().font_semibold().child("Open a markdown file"))
      .child(div().text_color(t.dim).text_size(z(12)).child("Type or paste its path and press Enter, or drop the file here."))
      .child(Input.new(this.pathInput).w_full().h(z(30)).px(z(8)).rounded(z(6)).bg(t.input).border_1().border_color(t.border)));

    const header = h_flex().h(z(40)).flex_none().px(z(12)).gap(z(8)).items_center().border_b(1).border_color(t.border)
      .when(Boolean(this.history?.length), (el) => el.child(this.button("back", "← Back", (cx) => this.back(cx), t)))
      .child(div().flex_1().min_w(0).truncate().font_semibold().child(name + (this.dirty ? " •" : "")))
      .child(this.mode === "edit"
        ? h_flex().gap(z(6))
            .child(this.button("save", "Save", cx => this.saveEdit(cx), t, this.dirty))
            .child(this.button("to-read", "Read", cx => this.saveEdit(cx, () => this.setMode("read", cx)), t))
        : this.mode === "select"
        ? this.button("to-read", "Done", cx => this.setMode("read", cx), t, true)
        : h_flex().gap(z(6))
            .child(this.button("to-select", "Select text", cx => this.setMode("select", cx), t))
            .child(this.button("to-edit", "Edit", cx => this.setMode("edit", cx), t)));

    const banner = this.error || (this.changedOnDisk ? "The file changed on disk while you were editing. Save will be refused; copy your changes, then Reload." : null);
    return root.child(header)
      .when(Boolean(banner), el => el.child(h_flex().px(z(12)).py(z(6)).gap(z(8)).items_center().bg(t.raised).text_size(z(12)).text_color(t.blocked)
        .child(div().flex_1().child(banner))
        .child(this.button("reload", "Reload", cx => { this.error = null; this.setMode("read"); this.load(cx); }, t))))
      .child(this.text === null || this.text === undefined
        ? div().p(z(12)).text_color(t.dim).child(this.error ? "" : "Loading…")
        : this.mode === "edit" ? Editor.new(this.editor).flex_1().min_h(0)
        : this.mode === "select" ? this.selectView(t) : this.readView(t))
      .when(this.mode === "read" && Boolean(this.compose) && this.text != null, el => el.child(this.composer(t)));
  }
}
