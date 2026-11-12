// Adapted from NA29 Islands sleek-usage (Apache-2.0, github.com/NA29/na29s-islands).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { edgeFrame } from "./frame.js";
import { agents, exec, appHome, layout, run, theme, props, window } from "herdr";

// ── Constants ─────────────────────────────────────────────────
const SANS = "Geist";
const MONO = "Liberation Mono";
const WEEK = 7 * 24 * 3600;
const HELPER = () => `${appHome()}/mods/glass-usage/usage.py`;

const PROVIDERS = [
  { id: "claude", name: "claude code", app: "claude-code", icon: "icons/claude.svg" },
  { id: "codex", name: "codex", app: "codex", icon: "icons/codex.svg" },
];

// ── Helpers ───────────────────────────────────────────────────
const nowSec = () => Math.floor(Date.now() / 1000);
const tint = (c, a) => /^#[0-9a-f]{6}$/i.test(c) ? c + Math.round(a * 255).toString(16).padStart(2, "0") : c;
const pctColor = (t, pct) => pct >= 85 ? t.blocked : pct >= 60 ? t.working : t.ansi4;

function untilText(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? `${h % 24}h` : ""}`;
}

// Window past its reset reads as zero.
function current(w, now) {
  if (!w) return null;
  if (w.resets && w.resets <= now) return { used: 0, resets: null };
  return w;
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function thinBar(t, pct, color) {
  const p = Math.max(0, Math.min(100, pct));
  return div().flex_1().min_w(0).h(4).rounded(2).bg(t.border)
    .child(div().h_full().rounded(2).bg(color).w(p > 0 ? `${Math.max(2, p)}%` : 0));
}

// ── Usage card ────────────────────────────────────────────────
export default class Usage extends View {
  init(_props, cx) {
    this.raw = {};
    this.folded = localStorage.getItem("folded") === "1";
    this.refresh(cx);
    cx.timer.every(30000, (cx) => this.refresh(cx));
    // Windows: keep the usage cache fresh from the live API while Herdr is open.
    this.populate(cx);
    cx.timer.every(300000, (cx) => this.populate(cx));
  }

  // Windows only: run the populator, which reads the local Claude token and
  // writes the Omarchy-format cache that refresh() reads. No-op elsewhere;
  // Linux/macOS get their cache from Omarchy.
  populate(cx) {
    if (window()?.platform !== "windows") return;
    cx.spawn(async (cx) => {
      try {
        await exec("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${appHome()}/mods/glass-usage/populate.ps1`]);
      } catch {}
      this.refresh(cx);
    });
  }

  refresh(cx) {
    const win = window()?.platform === "windows";
    cx.spawn(async (cx) => {
      try {
        // Windows reads an Omarchy-format cache via PowerShell; Linux/macOS use the python3 helper.
        const r = win
          ? await exec("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${appHome()}/mods/glass-usage/usage.ps1`])
          : await exec("python3", ["-I", HELPER()]);
        if (r.code === 0 && r.stdout.trim()) this.raw = JSON.parse(r.stdout);
      } catch {}
      this.fit();
      cx.notify();
    });
  }

  shown(now) {
    const live = new Set(agents().map((a) => a.app));
    return PROVIDERS
      .map((p) => ({ ...p, data: this.raw[p.id], live: live.has(p.app) }))
      .filter((p) => p.data && (p.live || now - (p.data.at ?? 0) < WEEK));
  }

  fit() {
    const n = this.shown(nowSec()).length;
    const px = !n ? 0 : this.folded ? 38 : 42 + n * 62;
    const node = find(layout(), "usage");
    if (!node) return;
    if (!px) { if (!node.hidden) run("layout.hide", { id: "usage" }); return; }
    if (node.hidden) run("layout.show", { id: "usage" });
    if (node.size?.px !== px) run("layout.resize", { id: "usage", px });
  }

  bar(t, label, w, dim) {
    const used = w?.used ?? 0;
    const fill = pctColor(t, used);
    return h_flex().h(18).gap(8).items_center()
      .child(div().w(18).flex_none().text_color(t.dim).child(label))
      .child(thinBar(t, used, dim ? tint(fill, 0.5) : fill))
      .child(div().w(34).flex_none().text_right().text_color(w ? (used >= 85 ? t.blocked : t.foreground) : t.dim)
        .child(w ? `${Math.round(used)}%` : "—"))
      .child(div().w(50).flex_none().whitespace_nowrap().text_right().text_color(t.dim)
        .child(w?.resets ? `↻ ${untilText(w.resets - nowSec())}` : ""));
  }

  provider(t, p, now) {
    const d = p.data;
    const age = d?.at ? now - d.at : null;
    return v_flex().px(8).py(3).gap(1).when(!p.live, (el) => el.opacity(0.62))
      .child(h_flex().h(20).gap(7).items_center()
        .child(image(p.icon).w(13).h(13).flex_none())
        .child(div().font_family(SANS).text_color(t.foreground).font_semibold().child(p.name))
        .when(p.live, (el) => el.child(div().size(6).rounded(3).bg(t.done)))
        .when(Boolean(d?.plan), (el) => el.child(div().font_family(SANS).text_color(t.dim).child(String(d.plan).toLowerCase())))
        .child(div().flex_1())
        .child(div().font_family(SANS).text_color(t.dim)
          .child(!d ? "no reading yet" : age > 1200 ? `as of ${untilText(age)} ago` : "")))
      .child(this.bar(t, "5h", current(d?.five, now), !p.live))
      .child(this.bar(t, "7d", current(d?.week, now), !p.live));
  }

  render() {
    const t = theme();
    const now = nowSec();
    const list = this.shown(now);
    if (!list.length) return edgeFrame(div().size_full(), props()?.frame);
    const open = !this.folded;
    const toggle = (_e, cx) => {
      this.folded = !this.folded;
      localStorage.setItem("folded", this.folded ? "1" : "0");
      this.fit();
      cx.notify();
    };
    const summary = list.map((p) => {
      const used = current(p.data?.five, now)?.used;
      return h_flex().gap(4).flex_none()
        .child(div().font_family(SANS).text_color(t.dim).child(p.name.split(" ")[0]))
        .child(div().text_color(used == null ? t.dim : pctColor(t, used)).child(used == null ? "—" : `${Math.round(used)}%`));
    });
    return edgeFrame(v_flex().id("root").size_full().min_h(0).p(4).font_family(MONO).text_size(11)
      .child(v_flex().w_full().flex_none()
        .child(h_flex().id("usage-head").h(28).px(8).gap(8).items_center().rounded(7).cursor_pointer()
          .text_color(t.muted).hover((h) => h.text_color(t.foreground)).on_click(toggle)
          .child(div().flex_none().font_family(SANS).text_size(12).font_semibold().child("Usage"))
          .child(div().flex_1())
          .when(!open, (el) => el.child(h_flex().flex_shrink_1().min_w(0).gap(8).items_center().children(summary)))
          .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none()))
        .when(open, (el) => el.child(v_flex().pt(2).children(list.map((p) => this.provider(t, p, now)))))), props()?.frame);
  }
}
