// Files for the focused pane's folder: lazy tree, previews, search, editing and transfers between machines.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, layout, machines, home, appHome, props, run } from "herdr";
import * as fs from "fs/promises";
import { edgeFrame } from "./frame.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000, EDIT_LIMIT = 200000, FOUND_LIMIT = 200;
const SKIP = ["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target"];
const SCP = ["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-r", "-p"];

const findNode = (node, id) => node?.id === id ? node : (node?.children ?? []).reduce((f, c) => f ?? findNode(c, id), null);
// Whether the panel shows this tab.
const shown = () => { const root = layout(), panel = findNode(root, "panel"), body = findNode(root, "panel-body"); return !panel || (!panel.hidden && body?.active === "files"); };
const machineName = (m) => m ?? "this computer";
const baseName = (p) => String(p).replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(p);
const errText = (r, what) => String(r.stderr || r.stdout).trim().split("\n").pop() || `${what} failed`;

async function directory(path, on) {
  const windowsDirectory = async () => {
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

// Dock and close buttons for the side panel's header.
function panelButtons(t) {
  const bottom = findNode(layout(), "work-body")?.type === "column";
  const button = (id, icon, size, tip, action) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
    .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => { cx.stop_propagation(); action(); })
    .child(svg(icon).size(size));
  return [
    button("panel-dock", `mods/glass-tabs/${bottom ? "panel-bottom" : "panel-right"}.svg`, 14, bottom ? "Move panel to the right" : "Move panel to the bottom", () => run("glass-tabs.dock")),
    button("panel-close", "mods/glass-pane/close.svg", 12, "Close panel", () => run("layout.hide", { id: "panel" })),
  ];
}

// ── This computer ─────────────────────────────────────────────

// Whether `machine` is this computer and it runs Windows; other machines are reached as Unix.
const winLocal = (machine) => !machine && window()?.platform === "windows";
const psQuote = (s) => "'" + String(s).replace(/['‘’‚‛]/g, "$&$&") + "'";
// A PowerShell script on this computer, with UTF-8 output.
const ps = (script, opts) => exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " + script], opts);

// Opens a folder on this computer in the file manager.
function openFolder(path) {
  const p = window()?.platform;
  const [cmd, args] = p === "windows" ? ["explorer.exe", [String(path).replace(/\//g, "\\")]] : p === "macos" ? ["open", [path]] : ["xdg-open", [path]];
  exec(cmd, args).catch(() => {});
}

// ── Transfers ─────────────────────────────────────────────────

// A place is { machine, path }: machine null is this computer.
async function sshTarget(machine) {
  const r = await exec("hc", ["machine", "ls"]);
  const m = (JSON.parse(r.stdout || "{}").machines ?? []).find(x => x.name === machine);
  if (!m?.target) throw new Error(`${machine} isn't reached over ssh`);
  return m.target;
}

async function makeDir(place) {
  const r = winLocal(place.machine)
    ? await ps(`New-Item -ItemType Directory -Force -Path ${psQuote(place.path)} | Out-Null`)
    : await exec("sh", ["-c", 'mkdir -p "$1"', "mkdir", place.path], { on: place.machine });
  if (r.code !== 0) throw new Error(errText(r, `mkdir on ${machineName(place.machine)}`));
}

// Copies `from` (a file or folder) into the folder `into`.
async function copy(from, into) {
  await makeDir(into);
  if (from.machine === into.machine) {
    const r = winLocal(from.machine)
      ? await ps(`Copy-Item -LiteralPath ${psQuote(from.path)} -Destination ${psQuote(into.path)} -Recurse -Force -ErrorAction Stop`)
      : await exec("cp", ["-R", "-p", from.path, into.path], { on: from.machine });
    if (r.code !== 0) throw new Error(errText(r, "copy"));
    return;
  }
  const spec = async (p) => p.machine ? `${await sshTarget(p.machine)}:${p.path}` : p.path;
  const r = await exec("scp", [...SCP, ...(from.machine && into.machine ? ["-3"] : []), await spec(from), (await spec(into)) + "/"], { timeout: 600000 });
  if (r.code !== 0) throw new Error(errText(r, "scp"));
}

// Where a machine keeps what's sent to it: Downloads here, ~/inbox elsewhere.
async function inboxOf(machine) {
  if (!machine) return `${home()}${winLocal(null) ? "\\" : "/"}Downloads`;
  const r = await exec("sh", ["-c", 'printf %s "$HOME/inbox"'], { on: machine });
  if (r.code !== 0 || !r.stdout) throw new Error(`can't reach ${machine}`);
  return r.stdout;
}

// ── Search and saving ─────────────────────────────────────────

// Paths under root, relative to it with "/", from lines of full paths.
function relative(root, out) {
  const norm = (p) => String(p).replace(/\\/g, "/");
  const prefix = norm(root).replace(/\/$/, "") + "/";
  return out.split(/\r?\n/).map((l) => norm(l.trim())).filter(Boolean).slice(0, FOUND_LIMIT)
    .map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p)).filter((p) => p && p !== norm(root));
}

// Search on a Windows computer: ripgrep when it's installed, else PowerShell.
async function searchWindows(root, query, mode) {
  const rgArgs = mode === "text"
    ? ["-l", "-i", "-F", "--max-filesize", "2M", ...SKIP.flatMap((d) => ["-g", `!${d}`]), "--", query, root]
    : ["--files", "--hidden", ...SKIP.flatMap((d) => ["-g", `!${d}`]), "--iglob", `*${query}*`, root];
  const rg = await exec("rg", rgArgs, { timeout: 60000 }).catch(() => null);
  if (rg && (rg.code === 0 || rg.code === 1)) return relative(root, rg.stdout);
  const skip = SKIP.map(psQuote).join(",");
  const files = `Get-ChildItem -LiteralPath ${psQuote(root)} -Recurse -Force -Depth 8 -ErrorAction SilentlyContinue | Where-Object { $parts = $_.FullName -split '[\\\\/]'; -not ($parts | Where-Object { @(${skip}) -contains $_ }) }`;
  const script = mode === "text"
    ? `${files} | Where-Object { -not $_.PSIsContainer -and $_.Length -lt 2MB } | Select-String -Pattern ${psQuote(query)} -SimpleMatch -List -ErrorAction SilentlyContinue | Select-Object -First ${FOUND_LIMIT} | ForEach-Object { $_.Path }`
    : `$pattern = '*' + [WildcardPattern]::Escape(${psQuote(query)}) + '*'; ${files} | Where-Object { $_.Name -like $pattern } | Select-Object -First ${FOUND_LIMIT} | ForEach-Object { $_.FullName }`;
  return relative(root, (await ps(script, { timeout: 60000 })).stdout);
}

// Paths under root whose name ("name") or text ("text") holds the query.
async function search(root, machine, query, mode) {
  if (winLocal(machine)) return searchWindows(root, query, mode);
  const skipGrep = SKIP.map(d => `--exclude-dir='${d}'`).join(" "), skipRg = SKIP.map(d => `-g '!${d}'`).join(" ");
  const prune = SKIP.map(d => `-name '${d}'`).join(" -o ");
  const cmd = mode === "text"
    ? `if command -v rg >/dev/null 2>&1; then rg -l -i -F --max-filesize 2M ${skipRg} -- "$2" "$1"; else grep -rIl -i -F ${skipGrep} -- "$2" "$1"; fi 2>/dev/null | head -${FOUND_LIMIT}`
    : `find "$1" -maxdepth 8 \\( ${prune} \\) -prune -o -iname "*$2*" -print 2>/dev/null | head -${FOUND_LIMIT}`;
  const r = await exec("sh", ["-c", cmd, "search", root, query], { on: machine, timeout: 60000 });
  return relative(root, r.stdout);
}

// Writes text only if the file still holds `original`; remote files keep their owner and mode.
async function saveText(path, machine, text, original) {
  if (!machine) {
    try { await writeTextFile(path, text, original); }
    catch (e) { throw new Error(/stale|expected|match/i.test(String(e)) ? "the file changed on disk since you opened it" : String(e)); }
    return;
  }
  if (await readTextFile(path, { on: machine }) !== original) throw new Error("the file changed on disk since you opened it");
  const tmp = `${appHome()}/.glass-save-${Date.now().toString(36)}`;
  await writeTextFile(tmp, text, null);
  try {
    const up = await exec("scp", ["-q", "-o", "BatchMode=yes", tmp, `${await sshTarget(machine)}:${path}.glass-save`]);
    if (up.code !== 0) throw new Error(errText(up, "upload"));
    const r = await exec("sh", ["-c", 'cat "$1.glass-save" > "$1" && rm -f "$1.glass-save"', "save", path], { on: machine });
    if (r.code !== 0) throw new Error(errText(r, "save"));
  } finally { await fs.unlink(tmp).catch(() => {}); }
}

// ── Files panel ───────────────────────────────────────────────

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.jobs = []; this.jobSeq = 0; this.mode = "name"; this.handle = cx.focus_handle();
    this.query = InputState.new({ placeholder: "Search this folder" });
    this.query.on("submit", (_e, cx) => this.runSearch(cx));
    this.query.on("change", (_e, cx) => { if (!this.query.value().trim() && this.results) { this.results = null; cx.notify(); } });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.results = null; this.menuFor = null; this.sendFor = null;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!shown()) { this.stale = true; return; }
    this.stale = false;
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    this.text = null; this.editing = false; this.note = null; this.menuFor = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        this.text = text;
        this.code = this.editor(path, text, true);
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  editor(path, text, readonly) {
    const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
    return EditorState.new({ language: LANG[ext] ?? ext, readonly,
      value: readonly && text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
      font_family: settings().font_family, font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
  }

  // ── Editing ──

  edit(cx) {
    if (this.text === null || this.text.length > EDIT_LIMIT) return;
    this.code?.release();
    this.code = this.editor(this.file, this.text, false);
    this.editing = true; this.note = null;
    cx.notify();
  }

  cancelEdit(cx) {
    this.code?.release();
    this.code = this.editor(this.file, this.text, true);
    this.editing = false; this.note = null;
    cx.notify();
  }

  save(cx) {
    if (!this.editing || this.saving || !this.code) return;
    const text = this.code.value(), path = this.file, full = `${this.root}/${path}`, on = this.on, original = this.text;
    if (text === original) { this.cancelEdit(cx); return; }
    this.saving = true; this.note = null;
    cx.spawn(async cx => {
      try {
        await saveText(full, on, text, original);
        if (this.file === path) { this.text = text; this.note = { ok: true, text: "Saved" }; this.editing = false; this.code?.release(); this.code = this.editor(path, text, true); }
      } catch (e) { if (this.file === path) this.note = { ok: false, text: `Not saved: ${e?.message ?? e}` }; }
      finally { this.saving = false; cx.notify(); }
    });
    cx.notify();
  }

  // ── Search ──

  setMode(mode, cx) {
    this.mode = mode;
    if (this.query.value().trim()) this.runSearch(cx);
    cx.notify();
  }

  runSearch(cx) {
    const q = this.query.value().trim(), root = this.root, on = this.on, mode = this.mode, context = this.context;
    if (!q || !root) { this.results = null; cx.notify(); return; }
    this.results = { query: q, mode, paths: [], busy: true };
    cx.spawn(async cx => {
      try {
        const paths = await search(root, on, q, mode);
        if (this.current(context) && this.results?.query === q && this.results.mode === mode) this.results = { query: q, mode, paths };
      } catch (e) { if (this.current(context)) this.results = { query: q, mode, paths: [], error: String(e?.message ?? e) }; }
      cx.notify();
    });
    cx.notify();
  }

  // ── Transfers ──

  transfer(from, into, cx) {
    const job = { id: ++this.jobSeq, name: baseName(from.path), from: from.machine, into, state: "running" };
    this.jobs.unshift(job); this.jobs = this.jobs.slice(0, 20); this.showJobs = true;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        const dest = into.path ?? await inboxOf(into.machine);
        job.into = { machine: into.machine, path: dest };
        await copy(from, job.into);
        job.state = "done";
        if (this.current(context) && into.machine === this.on) this.refresh(cx);
      } catch (e) { job.state = "failed"; job.error = String(e?.message ?? e); }
      cx.notify();
    });
    cx.notify();
  }

  // Files dropped from the desktop land in `folder` (relative to the root).
  dropped(paths, folder, cx) {
    const sig = paths.join("\n");
    if (this.lastDrop && this.lastDrop.sig === sig && Date.now() - this.lastDrop.at < 1000) return;
    this.lastDrop = { sig, at: Date.now() };
    if (!this.root) return;
    const into = { machine: this.on, path: folder ? `${this.root}/${folder}` : this.root };
    for (const p of paths) this.transfer({ machine: null, path: p }, into, cx);
  }

  destinations() {
    return [null, ...machines().filter(m => m.name && !m.temporary && m.layout !== "unavailable").map(m => m.name)].filter(m => m !== this.on);
  }

  // ── Drawing ──

  pill(id, label, action, t, { on = false, accent = false } = {}) {
    return h_flex().id(id).h(22).px(8).flex_none().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .border_1().border_color(on || accent ? t.accent : t.border).bg(on ? t.selected : t.background)
      .text_color(on || accent ? t.foreground : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);
  }

  // Actions for a right-clicked row.
  rowMenu(path, entry, depth, t) {
    const full = { machine: this.on, path: `${this.root}/${path}` };
    const close = (cx) => { this.menuFor = null; cx.notify(); };
    if (this.sendFor === path) return h_flex().id(`send-${path}`).flex_none().flex_wrap().gap(5).pl(8 + depth * 18 + 19).pr(6).py(5).items_center()
      .child(div().text_size(11).text_color(t.dim).child("Send to"))
      .children(this.destinations().map(m => this.pill(`send-${path}-${m ?? "here"}`, m ?? "Downloads", cx => { this.sendFor = null; close(cx); this.transfer(full, { machine: m }, cx); }, t)))
      .child(this.pill(`send-cancel-${path}`, "Cancel", cx => { this.sendFor = null; cx.notify(); }, t));
    return h_flex().id(`menu-${path}`).flex_none().flex_wrap().gap(5).pl(8 + depth * 18 + 19).pr(6).py(5).items_center()
      .when(!entry.dir, el => el.child(this.pill(`m-open-${path}`, "Open", cx => { close(cx); this.show(path, cx); }, t)))
      .when(Boolean(this.on), el => el.child(this.pill(`m-dl-${path}`, "Download", cx => { close(cx); this.transfer(full, { machine: null }, cx); }, t)))
      .child(this.pill(`m-send-${path}`, "Send to…", cx => { this.sendFor = path; cx.notify(); }, t))
      .child(this.pill(`m-copy-${path}`, "Copy path", cx => { cx.write_to_clipboard(full.path); close(cx); }, t))
      .when(!this.on, el => el.child(this.pill(`m-reveal-${path}`, "Show in folder", cx => { close(cx); openFolder(entry.dir ? full.path : full.path.replace(/[\\/][^\\/]*$/, "")); }, t)));
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(this.menuFor === path, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menuFor = this.menuFor === path ? null : path; this.sendFor = null; cx.notify(); })
        .when(entry.dir, el => el.on_drop((e, cx) => { cx.stop_propagation(); this.dropped(e.paths, path, cx); }))
        .child(entry.dir ? svg(`mods/glass-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/glass-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (this.menuFor === path) out.push(this.rowMenu(path, entry, depth, t));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  found(t) {
    const r = this.results;
    const out = [div().px(8).pb(4).text_size(11).text_color(t.dim).child(r.busy ? "Searching…" : r.error ? r.error
      : `${r.paths.length}${r.paths.length >= FOUND_LIMIT ? "+" : ""} ${r.mode === "text" ? "files containing" : "names matching"} “${r.query}”`)];
    for (const p of r.paths) {
      const name = baseName(p), dir = p.slice(0, -name.length);
      out.push(h_flex().id(`found-${p}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(this.menuFor === p, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => this.show(p, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menuFor = this.menuFor === p ? null : p; this.sendFor = null; cx.notify(); })
        .child(svg("mods/glass-files/file.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_none().max_w(200).truncate().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir)));
      if (this.menuFor === p) out.push(this.rowMenu(p, { dir: false }, 0, t));
    }
    return out;
  }

  searchBar(t) {
    return h_flex().flex_none().px(10).py(8).gap(6).items_center().border_b(1).border_color(t.border)
      .child(div().id("files-query").flex_1().min_w(0).h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.query).h_full().text_size(12).text_color(t.foreground)))
      .child(this.pill("mode-name", "Name", cx => this.setMode("name", cx), t, { on: this.mode === "name" }))
      .child(this.pill("mode-text", "Text", cx => this.setMode("text", cx), t, { on: this.mode === "text" }));
  }

  fileBar(t) {
    const editable = this.text !== null && this.text.length <= EDIT_LIMIT;
    return h_flex().flex_none().px(10).py(6).gap(6).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(this.note ? (this.note.ok ? t.ansi2 : t.ansi1) : t.dim)
        .child(this.note?.text ?? (this.editing ? `Editing on ${machineName(this.on)} · Ctrl+S saves` : this.on ? `On ${this.on}` : "")))
      .when(this.editing, el => el
        .child(this.pill("file-cancel", "Cancel", cx => this.cancelEdit(cx), t))
        .child(this.pill("file-save", this.saving ? "Saving…" : "Save", cx => this.save(cx), t, { accent: true })))
      .when(!this.editing && editable, el => el.child(this.pill("file-edit", "Edit", cx => this.edit(cx), t)));
  }

  jobsDrawer(t) {
    const running = this.jobs.filter(j => j.state === "running").length;
    return v_flex().id("files-jobs").flex_none().max_h(200).border_t(1).border_color(t.border)
      .child(h_flex().h(30).flex_none().px(12).gap(8).items_center()
        .child(div().flex_1().text_size(11.5).font_semibold().text_color(t.muted).child(running ? `Transfers · ${running} running` : "Transfers"))
        .when(this.jobs.some(j => j.state !== "running"), el => el.child(this.pill("jobs-clear", "Clear", cx => { this.jobs = this.jobs.filter(j => j.state === "running"); if (!this.jobs.length) this.showJobs = false; cx.notify(); }, t)))
        .child(this.pill("jobs-hide", "Hide", cx => { this.showJobs = false; cx.notify(); }, t)))
      .child(v_flex().id("jobs-list").flex_1().min_h(0).overflow_y_scrollbar().px(8).pb(8).gap(4).children(this.jobs.map(j => {
        const color = j.state === "done" ? t.ansi2 : j.state === "failed" ? t.ansi1 : t.accent;
        return v_flex().id(`job-${j.id}`).flex_none().px(8).py(5).gap(2).rounded(6).border_l(2).border_color(color).bg(t.raised)
          .child(h_flex().gap(6).items_center()
            .child(j.state === "running" ? div().text_size(11).text_color(color).frames(["◐", "◓", "◑", "◒"], 160) : div().text_size(11).text_color(color).child(j.state === "done" ? "✓" : "✕"))
            .child(div().flex_1().min_w(0).truncate().text_size(12).child(j.name))
            .when(j.state === "done" && !j.into.machine, el => el.child(this.pill(`job-open-${j.id}`, "Open", () => openFolder(j.into.path), t))))
          .child(div().w_full().truncate().text_size(11).text_color(t.dim).child(`${machineName(j.from)} → ${machineName(j.into.machine)}${j.into.path ? ` · ${j.into.path}` : ""}`))
          .when(Boolean(j.error), el => el.child(div().w_full().text_size(11).text_color(t.ansi1).child(j.error)));
      })));
  }

  render(cx) {
    if (key() !== this.context?.key || (this.stale && shown())) this.refresh(cx);
    const t = theme();
    const button = (id, ic, label, action, on) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
      .when(on, el => el.bg(t.selected)).hover(s => s.bg(t.hover)).tooltip(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => action(cx))
      .child(svg(`mods/glass-files/${ic}.svg`).size(14).text_color(on ? t.foreground : t.muted));
    const body = this.file
      ? v_flex().flex_1().min_h(0).child(this.fileBar(t)).child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"))
      : v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .on_drop((e, cx) => this.dropped(e.paths, "", cx))
        .children(this.results ? this.found(t) : this.rows("", 0, [], t))
        .when(!this.results && (Boolean(this.error) || !this.entries.get("")?.length), el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(!this.results && this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")));
    return edgeFrame(v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (this.editing && (e.keystroke === "ctrl-s" || e.keystroke === "cmd-s")) { cx.stop_propagation(); this.save(cx); }
        else if (e.key === "escape" && this.menuFor) { this.menuFor = null; this.sendFor = null; cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(!this.file, el => el.child(button("files-search", "search", "Search", cx => { this.searching = !this.searching; if (!this.searching) { this.results = null; this.query.set_value(""); } cx.notify(); }, this.searching)))
        .when(this.jobs.length > 0, el => el.child(button("files-jobs-toggle", "transfers", "Transfers", cx => { this.showJobs = !this.showJobs; cx.notify(); }, this.showJobs)))
        .child(h_flex().flex_none().gap(2).children(panelButtons(t))))
      .when(this.searching && !this.file, el => el.child(this.searchBar(t)))
      .child(body)
      .when(this.showJobs && this.jobs.length > 0, el => el.child(this.jobsDrawer(t))), props()?.frame);
  }
}
