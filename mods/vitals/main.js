// Copied from herdr-vitals 0.3.1 (MIT, see LICENSE); reader source in vitals-src.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, exec, home, appHome, theme, props, layout, run, nextCommand, settings, window as appWindow } from "herdr";
import { edgeFrame } from "./frame.js";
import { tones, tint, levelColor, loadColor, bytes, bytesOf, icon, MONO } from "./look.js";
// ── Reader binary ─────────────────────────────────────────────

// The reader comes from this repo's GitHub releases; a local build.sh build wins while it exists.
const REPO = "koyPhish/glass-edge";
const VERSION = "0.1.4";
const BIN = ".local/share/vitals/vitals";
const DIST = () => `${home()}/.local/share/vitals/dist`;
const OS = { Linux: "linux", Darwin: "darwin" };
const ARCH = { x86_64: "amd64", amd64: "amd64", aarch64: "arm64", arm64: "arm64" };

// Downloads a release build on the machine itself and checks it against SHA256SUMS.
const FETCH = `set -e
d=$(dirname "$1"); mkdir -p "$d"; cd "$d"
get() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }
get "$2/$3" vitals.new; get "$2/SHA256SUMS" SHA256SUMS.new
want=$(grep " $3$" SHA256SUMS.new | cut -d' ' -f1); rm -f SHA256SUMS.new
got=$( (sha256sum vitals.new 2>/dev/null || shasum -a 256 vitals.new) | cut -d' ' -f1)
[ -n "$want" ] && [ "$want" = "$got" ] || { rm -f vitals.new; echo "the download didn't match its checksum" >&2; exit 1; }
chmod 755 vitals.new; mv vitals.new vitals`;

async function must(cmd, args, opts) {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `${cmd}: exit ${r.code}`);
  return r.stdout;
}

async function sshTarget(machine) {
  const list = JSON.parse(await must("hc", ["machine", "ls"])).machines ?? [];
  const m = list.find((x) => x.name === machine);
  if (!m?.target) throw new Error(`no ssh target for ${machine}`);
  return m.target;
}

// A local build.sh build for this OS and arch, with its checksum; null when there is none.
async function localBuild(name) {
  if (appWindow()?.platform === "windows") return null;
  const file = `${DIST()}/${name}`;
  const r = await exec("sh", ["-c", '(sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | cut -d" " -f1', "sum", file]).catch(() => null);
  const sum = r?.code === 0 ? r.stdout.trim() : "";
  return sum ? { file, sum } : null;
}

// Puts the matching reader on a machine when it's missing or out of date; returns its path.
async function install(machine) {
  // Local Windows: no Unix reader binary; use the bundled PowerShell reader (see reader.ps1).
  if (!machine && appWindow()?.platform === "windows") return `win:${appHome()}/mods/vitals/reader.ps1`;
  const probe = `uname -sm; printf '%s\\n' "$HOME"; v=$("$HOME/${BIN}" version 2>/dev/null) || v=none; printf '%s\\n' "$v" | head -n 1; (sha256sum "$HOME/${BIN}" 2>/dev/null || shasum -a 256 "$HOME/${BIN}" 2>/dev/null) | cut -d' ' -f1`;
  const [sm = "", remoteHome = "", have = "", haveSum = ""] = (await must("sh", ["-c", probe], { on: machine })).split("\n").map((l) => l.trim());
  const [os, cpu] = sm.split(" ");
  if (!OS[os] || !ARCH[cpu]) throw new Error(`Vitals has no build for ${sm || "this machine"}`);
  const name = `vitals-${OS[os]}-${ARCH[cpu]}`, dest = `${remoteHome}/${BIN}`;
  const dev = await localBuild(name);
  if (dev) {
    if (haveSum === dev.sum) return dest;
    if (!machine) {
      await must("sh", ["-c", 'mkdir -p "$(dirname "$1")" && cp "$0" "$1.new" && chmod 755 "$1.new" && mv "$1.new" "$1"', dev.file, dest]);
      return dest;
    }
    await must("sh", ["-c", 'mkdir -p "$(dirname "$0")"', dest], { on: machine });
    await must("scp", ["-q", "-o", "BatchMode=yes", dev.file, `${await sshTarget(machine)}:${dest}.new`], { timeout: 180000 });
    await must("sh", ["-c", 'chmod 755 "$0.new" && mv "$0.new" "$0"', dest], { on: machine });
    return dest;
  }
  if (have === VERSION) return dest;
  await must("sh", ["-c", FETCH, "fetch", dest, `https://github.com/${REPO}/releases/download/v${VERSION}`, name], { on: machine, timeout: 180000 });
  return dest;
}

// One request to the reader at `bin` on a machine (null is this one).
async function ask(req, machine, bin) {
  const path = await bin;
  // The local Windows reader is a PowerShell script, not a Unix `sh` binary.
  const r = path.startsWith("win:")
    ? await exec("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.slice(4), req.op ?? "now"])
    : await exec("sh", ["-c", 'exec "$0" app "$1"', path, JSON.stringify(req)], { on: machine });
  let res;
  try {
    res = JSON.parse(r.stdout);
  } catch {
    throw new Error(r.stderr.trim().split("\n").pop() || `vitals: exit ${r.code}`);
  }
  if (res?.error) throw new Error(res.error);
  return res;
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

// ── Constants ─────────────────────────────────────────────────

const EVERY_MS = 2000;
const MAX_BANDS = 24;
const HISTORY_BANDS = 20;
const SEGMENTS = 16;
const PEAK_HOLD = 2;
const METER_SEGMENTS = 22;
const IDLE_RESET_MS = 10000;
const BIN_GB = 1024;
const READOUT_W = 112;
const GPU_HISTORY = 110;

const diskName = (mount) => (mount === "/" ? "/" : mount.split("/").filter(Boolean).pop() ?? mount);
const findNode = (node, id) => node?.id === id ? node : (node?.children ?? []).reduce((f, c) => f ?? findNode(c, id), null);
const shortLabel = (l) => (l.length > 3 ? (l[0] + l.slice(1).replace(/[AEIOU]/g, "")).slice(0, 3) : l);
const clamp = (v) => Math.max(0, Math.min(100, v ?? 0));
const litOf = (v) => (v == null ? 0 : Math.round((clamp(v) / 100) * SEGMENTS));

// Next peak per band: holds, then falls a segment per reading.
function nextPeaks(levels, peaks) {
  return levels.map((lit, i) => {
    const pk = peaks[i] ?? { at: 0, hold: 0 };
    if (lit >= pk.at) return { at: lit, hold: PEAK_HOLD };
    if (pk.hold > 0) return { at: pk.at, hold: pk.hold - 1 };
    return { at: Math.max(lit, pk.at - 1), hold: 0 };
  });
}

// ── Vitals panel ──────────────────────────────────────────────

export default class Vitals extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.demo = Boolean(p.demo);
    this.reading = null;
    this.err = "";
    this.peaks = [];
    this.cpuHist = [];
    this.cpuStrip = [];
    this.demoMachines = [];
    this.gpus = [];
    this.gpuPeaks = {};
    this.gpuHist = {};
    this.installs = new Map();
    const space = spaces().find((s) => s.active);
    this.spaceId = space?.id;
    this.machine = space?.machine ?? null;
    this.lastRead = 0;

    cx.spawn(async (cx) => {
      if (this.demo) await this.startDemo(cx);
      this.read(cx);
    });
    cx.timer.every(EVERY_MS, (cx) => this.read(cx));
    cx.timer.every(300, (cx) => this.follow(cx));

    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "close") this.close();
        else if (c === "demo") {
          this.demo = !this.demo;
          this.reset();
          if (this.demo) await this.startDemo(cx);
          else this.machine = null;
          this.read(cx);
        }
        cx.notify();
      }
    });
  }

  async startDemo(cx) {
    this.demoMachines = (await ask({ op: "machines" }, null, this.binary(null)).catch(() => ({ machines: [] }))).machines;
    this.machine = this.demoMachines[0] ?? null;
    cx.notify();
  }

  reset() {
    this.reading = null;
    this.peaks = [];
    this.cpuHist = [];
    this.cpuStrip = [];
    this.err = "";
    this.gpus = [];
    this.gpuPeaks = {};
    this.gpuHist = {};
  }

  // The machine's install, checked once per window opening.
  binary(machine) {
    const k = machine ?? "";
    if (!this.installs.has(k)) {
      const p = install(machine);
      p.catch(() => this.installs.delete(k));
      this.installs.set(k, p);
    }
    return this.installs.get(k);
  }

  close() {
    run("layout.hide", { id: "panel" });
  }

  // Whether the panel shows this tab.
  shown() {
    const root = layout(), panel = findNode(root, "panel"), body = findNode(root, "panel-body");
    return Boolean(panel && !panel.hidden && body?.active === "vitals");
  }

  // The active space's machine, and a fresh read on coming back into view.
  follow(cx) {
    const space = spaces().find((s) => s.active);
    if (!this.demo && space && space.id !== this.spaceId) {
      this.spaceId = space.id;
      this.pick(space.machine ?? null, cx);
    }
    const shown = this.shown();
    if (shown && !this.wasShown) this.read(cx);
    this.wasShown = shown;
  }

  pick(key, cx) {
    if (key === this.machine) return;
    this.machine = key;
    this.reset();
    this.read(cx);
    cx.notify();
  }

  read(cx) {
    if (this.reading_ || !this.shown()) return;
    if (this.lastRead && Date.now() - this.lastRead > IDLE_RESET_MS) {
      this.reset();
    }
    this.lastRead = Date.now();
    this.reading_ = true;
    const machine = this.machine;
    const req = this.demo ? { op: "now", demo: true, machine } : { op: "now" };
    cx.spawn(async (cx) => {
      const on = this.demo ? null : machine;
      try {
        const r = await ask(req, on, this.binary(on));
        if (machine !== this.machine) return;
        this.take(r);
        this.err = "";
      } catch (e) {
        if (machine === this.machine) this.err = String(e?.message ?? e);
      } finally {
        this.reading_ = false;
      }
      cx.notify();
    });
  }

  take(r) {
    if (!this.cpuHist.length && r.history?.length) this.cpuHist = r.history.map((p) => p.c).slice(-HISTORY_BANDS);
    if (!r.warming) this.cpuHist.push(r.cpu);
    if (this.cpuHist.length > HISTORY_BANDS) this.cpuHist = this.cpuHist.slice(-HISTORY_BANDS);
    // The strip under the CPU equalizer: the reader's history when it keeps one, else our own readings.
    if (!this.cpuStrip.length && r.history?.length) this.cpuStrip = r.history.map((p) => p.c).slice(-GPU_HISTORY);
    if (!r.warming && r.cpu != null) this.cpuStrip.push(r.cpu);
    if (this.cpuStrip.length > GPU_HISTORY) this.cpuStrip.splice(0, this.cpuStrip.length - GPU_HISTORY);
    this.reading = r;
    this.peaks = nextPeaks(this.bands().map(litOf), this.peaks);
    this.gpus = r.gpuView ?? [];
    for (const g of this.gpus) {
      this.gpuPeaks[g.id] = nextPeaks(g.bands.map((b) => litOf(b.pct)), this.gpuPeaks[g.id] ?? []);
      if (!this.gpuHist[g.id]) this.gpuHist[g.id] = (r.history ?? []).map((p) => p.g?.[g.id]).filter((v) => v != null).slice(-GPU_HISTORY);
      if (g.util == null || r.warming) continue;
      const h = this.gpuHist[g.id];
      h.push(g.util);
      if (h.length > GPU_HISTORY) h.splice(0, h.length - GPU_HISTORY);
    }
  }

  // Each core, grouped past MAX_BANDS; on a Mac, recent whole-CPU readings.
  bands() {
    const r = this.reading;
    if (!r) return [];
    const cores = r.perCore ?? [];
    if (cores.length) {
      const per = Math.ceil(cores.length / MAX_BANDS);
      const out = [];
      for (let i = 0; i < cores.length; i += per) {
        const g = cores.slice(i, i + per);
        out.push(g.reduce((a, b) => a + b, 0) / g.length);
      }
      return out;
    }
    return this.cpuHist.slice();
  }

  // ── Drawing ─────────────────────────────────────────────────

  equalizer(o, w, values = this.bands(), peaks = this.peaks, labels = null, segH = 5) {
    const n = Math.max(1, values.length || HISTORY_BANDS);
    const gap = n > 24 ? 2 : n <= 10 ? 6 : 3;
    const bw = Math.min(labels ? 36 : Infinity, Math.max(4, Math.floor((w - gap * (n - 1)) / n)));
    const segGap = 2;
    const colorAt = (s) => loadColor(o, (100 * s) / SEGMENTS);
    const bars = h_flex().flex_none().items_end().gap(gap).h(SEGMENTS * (segH + segGap)).children(
      Array.from({ length: n }, (_, b) => {
        const lit = litOf(values[b]);
        const peak = peaks[b]?.at ?? 0;
        return v_flex().flex_none().w(bw).gap(segGap).children(
          Array.from({ length: SEGMENTS }, (_, k) => {
            const s = SEGMENTS - 1 - k;
            const on = s < lit;
            const cap = !on && peak > 0 && s === peak - 1;
            return div().w_full().h(segH).rounded(1.5).bg(on ? colorAt(s) : cap ? tint(colorAt(s), 0.4) : tint(o.line, 0.45));
          }),
        );
      }),
    );
    if (!labels) return bars;
    return v_flex().flex_none().gap(4)
      .child(bars)
      .child(h_flex().flex_none().gap(gap).children(labels.map((l) =>
        div().flex_none().w(bw).text_center().truncate().text_size(9.5).font_family(MONO).text_color(o.dim).child(bw < 26 ? shortLabel(l) : l))));
  }

  meter(o, pct, { color = null } = {}) {
    const lit = Math.round((clamp(pct) / 100) * METER_SEGMENTS);
    const at = (i) => color ?? loadColor(o, (100 * i) / METER_SEGMENTS);
    return h_flex().flex_1().min_w(0).max_w(196).gap(2).h(10).children(
      Array.from({ length: METER_SEGMENTS }, (_, i) => div().flex_1().h_full().rounded(1.5).bg(i < lit ? at(i) : tint(o.line, 0.45))),
    );
  }

  row(o, label, meter, value, sub) {
    return h_flex().flex_none().w_full().min_w(0).gap(8).items_center().h(22)
      .child(div().flex_none().w(58).truncate().text_size(11.5).text_color(o.dim).child(label))
      .child(meter)
      .child(div().flex_none().w(66).truncate().text_size(11.5).font_family(MONO).text_color(o.fg).child(value))
      .child(div().flex_none().w(84).truncate().text_size(11).text_color(o.dim).child(sub ?? ""));
  }

  section(o, title, ic) {
    return h_flex().flex_none().gap(6).items_center().pt(6)
      .child(icon(ic, o.dim, 12))
      .child(div().min_w(0).truncate().text_size(10.5).font_semibold().text_color(o.dim).child(title.toUpperCase()))
      .child(div().flex_1().h(1).bg(o.line));
  }

  // Thin columns of recent readings, colored by level.
  strip(o, w, values) {
    const hs = values.slice(-Math.floor(w / 4));
    return h_flex().flex_none().h(28).items_end().gap(1).children(hs.map((v) => {
      const c = clamp(v);
      return div().flex_none().w(3).h(Math.max(1, Math.round(0.28 * c))).rounded(1)
        .bg(loadColor(o, c));
    }));
  }

  // Big percent with a caption, beside an equalizer.
  readout(o, value, caption, lines) {
    return v_flex().flex_none().w(READOUT_W).items_end()
      .child(div().text_size(30).line_height("32px").font_semibold().font_family(MONO)
        .text_color(value == null ? o.dim : loadColor(o, value))
        .child(value == null ? "–" : `${Math.round(value)}`))
      .child(div().text_size(11).text_color(o.dim).child(caption))
      .child(v_flex().flex_none().pt(6).gap(1).items_end().children(lines.filter(Boolean).map((l) =>
        div().max_w(READOUT_W).truncate().text_size(10.5).text_color(o.dim).child(l))));
  }

  gpuLines(g) {
    return [
      g.vramTotal ? `VRAM ${bytesOf(g.vramUsed ?? 0, g.vramTotal, BIN_GB)}` : null,
      g.power != null ? (g.powerLimit ? `${Math.round(g.power)} of ${Math.round(g.powerLimit)} W` : `${Math.round(g.power)} W`) : null,
      g.temp != null ? `${Math.round(g.temp)}°C` : null,
      g.clock != null ? `${Math.round(g.clock)} MHz` : null,
    ];
  }

  cpuLines(r) {
    const c = r?.cpuInfo ?? {};
    const ghz = (mhz) => (mhz / 1000).toFixed(1);
    return [
      r && r.os === "linux" ? `user ${Math.round(r.user)} · sys ${Math.round(r.system)}${r.iowait >= 1 ? ` · io ${Math.round(r.iowait)}` : ""}` : null,
      c.temp != null ? `${Math.round(c.temp)}°C` : null,
      c.power != null ? `${Math.round(c.power)} W` : null,
      c.clock != null ? (c.clockMax ? `${ghz(c.clock)} of ${ghz(c.clockMax)} GHz` : `${ghz(c.clock)} GHz`) : null,
    ];
  }

  gpuItems(o, w) {
    const many = this.gpus.length > 1;
    return this.gpus.flatMap((g, i) => {
      const title = `GPU${many ? ` ${i}` : ""} · ${g.name}`;
      const values = g.bands.map((b) => b.pct);
      const labels = g.bands.map((b) => b.label);
      const hist = this.gpuHist[g.id] ?? [];
      return v_flex().id(`gpu-block-${i}`).flex_none().gap(8)
        .when(i === 0, (el) => el.on_size_change((size, cx) => { this.gpuH = size.height; this.fitCpu(cx); }))
        .children([
        this.section(o, title, "gpu"),
        h_flex().flex_none().min_w(0).gap(14).items_start()
          .child(this.equalizer(o, w - READOUT_W - 14, values, this.gpuPeaks[g.id] ?? [], labels))
          .child(this.readout(o, g.util, g.clockOnly ? "% clock" : "% busy", this.gpuLines(g))),
        ...(hist.length > 1 ? [this.strip(o, w, hist)] : []),
      ]);
    });
  }

  // CPU bars stretched so the CPU block is as tall as the first GPU's.
  fitCpu(cx) {
    if (!this.cpuH || !this.gpuH) return;
    const cur = this.cpuSegH ?? 5;
    const base = this.cpuH - SEGMENTS * (cur - 5);
    const want = Math.max(5, Math.min(14, 5 + (this.gpuH - base) / SEGMENTS));
    if (Math.abs(want - cur) > 0.1) {
      this.cpuSegH = want;
      cx.notify();
    }
  }

  // A command to run, with a copy button.
  // What needs the setcap grant, with the command and a copy button.
  hintBox(o, r) {
    const what = [];
    if (r?.cpuInfo?.powerDenied) what.push("CPU power");
    const g = this.gpus.find((x) => x.hint);
    if (g) what.push("GPU engine load");
    const cmd = r?.cpuInfo?.hint ?? g?.hint;
    if (!what.length || !cmd) return null;
    const copied = this.copied;
    return v_flex().flex_none().mb(10).gap(4).p(8).rounded(6).border_1().border_color(tint(o.work, 0.4)).bg(tint(o.work, 0.08))
      .child(div().text_size(11).text_color(o.work).child(`${what.join(" and ")} need${what.length > 1 ? "" : "s"} permission. Run once on ${this.machine ?? "this computer"}:`))
      .child(h_flex().gap(8).items_start()
        .child(div().flex_1().min_w(0).text_size(10.5).font_family(MONO).text_color(o.fg).child(cmd))
        .child(h_flex().id("copy-hint").flex_none().h(22).px(7).gap(5).items_center().rounded(5).cursor_pointer()
          .border_1().border_color(o.line).bg(o.surface).hover((s) => s.bg(o.raised))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            cx.write_to_clipboard(cmd);
            this.copied = true;
            cx.notify();
            cx.timer.after(2000, (cx) => {
              this.copied = false;
              cx.notify();
            });
          })
          .child(icon(copied ? "check" : "copy", copied ? o.review : o.muted, 12))
          .child(div().text_size(11).text_color(copied ? o.review : o.muted).child(copied ? "Copied" : "Copy"))));
  }

  topBar(t, o, head) {
    return h_flex().flex_none().h(42).px(14).gap(8).items_center().border_b_1().border_color(o.line)
      .child(icon("pulse", o.accent, 14))
      .child(div().flex_none().text_size(13).font_semibold().text_color(o.fg).child("Vitals"))
      .when(Boolean(head), (el) => el.child(head))
      .child(div().flex_1())
      .when(this.demo, (el) => el.child(div().flex_none().text_size(11).text_color(o.dim).child("demo")))
      .child(h_flex().flex_none().gap(2).children(panelButtons(t)));
  }

  // ── Sections ────────────────────────────────────────────────

  hostLine(o, r, inline) {
    const levelCol = levelColor(o, r?.level);
    return h_flex().flex_none().min_w(0).gap(8).items_center()
      .child(div().flex_none().text_size(inline ? 12.5 : 15).font_semibold().text_color(o.fg).child(r?.host ?? (this.err ? "Not answering" : "Reading…")))
      .when(Boolean(r), (el) => el.child(div().min_w(0).truncate().text_size(11.5).text_color(o.dim)
        .child(`${r.release || r.os} · ${r.cores} cores · up ${r.uptime}`)))
      .when(!inline, (el) => el.child(div().flex_1()))
      .when(Boolean(r), (el) => el.child(h_flex().flex_none().h(20).px(7).gap(5).items_center().rounded(5).bg(tint(levelCol, 0.15))
        .child(div().w(6).h(6).rounded_full().bg(levelCol))
        .child(div().text_size(10.5).font_semibold().text_color(levelCol).child(r.level === "ok" ? "OK" : `${r.level.toUpperCase()} ${r.why}`))));
  }

  cpuItems(o, r, w, matched) {
    const segH = matched ? this.cpuSegH ?? 5 : 5;
    return v_flex().id("cpu-block").flex_none().gap(8)
      .when(matched, (el) => el.on_size_change((size, cx) => { this.cpuH = size.height; this.fitCpu(cx); }))
      .child(this.section(o, r?.perCore?.length ? `CPU · ${r.perCore.length} cores` : `CPU · the last ${(HISTORY_BANDS * EVERY_MS) / 1000} seconds`, "pulse"))
      .child(h_flex().flex_none().min_w(0).gap(14).items_start()
        .child(this.equalizer(o, w - READOUT_W - 14, this.bands(), this.peaks, null, segH))
        .child(this.readout(o, r && !r.warming ? r.cpu : null, "% busy", this.cpuLines(r))))
      .when(this.cpuStrip.length > 1, (el) => el.child(this.strip(o, w, this.cpuStrip)));
  }

  memItems(o, r) {
    const mem = r ? bytesOf(r.memUsed, r.memTotal, BIN_GB) : "";
    return [
      this.section(o, "Memory and load", "spark"),
      this.row(o, "Memory", this.meter(o, r?.mem), r ? `${Math.round(r.mem)}%` : "", mem),
      ...(r?.swapTotal ? [this.row(o, "Swap", this.meter(o, r.swap), `${Math.round(r.swap)}%`, bytesOf((r.swap / 100) * r.swapTotal, r.swapTotal, BIN_GB))] : []),
      this.row(o, "Load", this.meter(o, Math.min(100, (r?.loadPerCore ?? 0) * 100)), r ? `${r.load[0].toFixed(2)}` : "", r ? `${r.loadPerCore.toFixed(2)} a core` : ""),
    ];
  }

  netItems(o, r) {
    const netMax = 125e6;
    const netPct = (b) => (b > 0 ? Math.min(100, (Math.log10(b + 1) / Math.log10(netMax)) * 100) : 0);
    return [
      this.section(o, "Network", "net"),
      this.row(o, "In", this.meter(o, netPct(r?.netRx), { color: o.accent }), r ? bytes(r.netRx, true) : "", ""),
      this.row(o, "Out", this.meter(o, netPct(r?.netTx), { color: o.merged }), r ? bytes(r.netTx, true) : "", ""),
    ];
  }

  diskItems(o, r) {
    if (!r?.disks?.length) return [];
    return [this.section(o, "Disks", "disk"),
      ...r.disks.slice(0, 6).map((d) => this.row(o, diskName(d.mount), this.meter(o, d.pct), `${Math.round(d.pct)}%`, bytesOf(d.used, d.size)))];
  }

  // ── Layout ──────────────────────────────────────────────────

  render() {
    const t = theme();
    const o = tones(t);
    const r = this.reading;
    // on_size_change reports window px, but .w()/.text_size() are scaled by zoom: lay out in zoomed px.
    const zoom = Number(settings()?.zoom) || 1;
    const W = (this.size?.width ?? 368 * zoom) / zoom;
    const hasGpu = this.gpus.length > 0;
    const cols = W >= 680 ? 2 : 1;
    const gap = 20;
    const w = Math.floor((W - 32 - gap * (cols - 1)) / cols);
    const err = this.err ? [div().flex_none().text_size(12).text_color(o.fix).child(this.err)] : [];
    const cpu = [this.cpuItems(o, r, w, cols > 1 && hasGpu)];
    const gpu = this.gpuItems(o, w);
    const mem = [...this.memItems(o, r), ...this.diskItems(o, r)], net = this.netItems(o, r);
    const hint = this.hintBox(o, r);
    const groups = cols === 1 ? [[...err, ...cpu, ...gpu, ...mem, ...net]]
      : [[...err, ...cpu, ...mem], [...gpu, ...net]];
    const column = (items, i) => v_flex().id(`col-${i}`).flex_none().min_w(0).w(w).gap(8).children(items);
    return edgeFrame(v_flex()
      .id("vitals")
      .size_full()
      .min_w(0)
      .border_1()
      .text_size(12.5)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - (this.size?.width ?? 0)) > 8 || Math.abs(size.height - (this.size?.height ?? 0)) > 8) {
          this.size = size;
          cx.notify();
        }
      })
      .child(this.topBar(t, o, cols > 1 ? this.hostLine(o, r, true) : null))
      .child(v_flex().id("vitals-body").flex_1().min_h(0).min_w(0).overflow_y_scrollbar().px(16).pt(10).pb(10)
        .when(cols === 1, (el) => el.child(div().flex_none().mb(8).child(this.hostLine(o, r, false))))
        .when(Boolean(hint), (el) => el.child(hint))
        .child(h_flex().flex_none().min_w(0).w_full().gap(gap).items_start().children(groups.map(column)))), props()?.frame);
  }
}
