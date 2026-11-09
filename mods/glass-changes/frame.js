// Cut-corner island frame for the Glass-Edge layout.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme } from "herdr";

const CUT = 10, ART = "mods/glass-chrome/edge", SHELL = "#f0ead6";
const alpha = (c, a) => c + Math.round(a * 255).toString(16).padStart(2, "0");

// One cut corner: the island's face, its edge and an accent along the cut.
function corner(c, t, bright) {
  const layer = (name, color) => svg(`${ART}/${name}-${c}.svg`).absolute().top(0).left(0).size_full().text_color(color);
  return div().relative().size(CUT).flex_none()
    .child(layer("fill", t.background))
    .child(layer("edge", t.border))
    .child(layer("accent", bright.includes(c) ? SHELL : alpha(SHELL, 0.4)));
}

function band(left, right, side, t, bright) {
  return h_flex().w_full().h(CUT).flex_none()
    .child(corner(left, t, bright))
    .child(div().flex_1().h_full().bg(t.background).border_color(t.border).when(side === "t", (x) => x.border_t(1)).when(side === "b", (x) => x.border_b(1)))
    .child(corner(right, t, bright));
}

// ── Trim variants ──

// Runs of [length, alpha] pieces, 4 px apart.
const RUN = {
  bar: [[26, 1], [4, 0.6], [4, 0.3]],
  rise: [[4, 0.3], [4, 0.6], [20, 1]],
  pair: [[14, 1], [14, 1]],
  trail: [[30, 0.45], [6, 1]],
  trailBright: [[30, 1], [6, 0.6]],
  split: [[8, 1], [22, 0.45]],
  beam: [[44, 1]],
  long: [[44, 0.45]],
  stub: [[18, 1], [3, 1]],
  stubLong: [[27, 1], [3, 1]],
  dash: [[33, 1], [4, 0.5]],
  pairLong: [[21, 1], [14, 0.45]],
  short: [[10, 0.4]],
};

// Each variant: bright corners, trims ([edge, from, offset, run]), side rails ([side, from, offset, length, alpha]) and whether its first top-left dash is 3 px thick.
const VARIANTS = [
  { thick: true, bright: ["tl", "br"], trims: [["t", "l", 6, "bar"], ["t", "r", 6, "short"], ["b", "r", 6, "bar"], ["b", "l", 6, "short"]], rails: [["l", "t", 8, 18, 0.4], ["r", "b", 8, 18, 1]] },
  { thick: true, bright: ["tr", "bl"], trims: [["t", "l", 6, "trailBright"], ["b", "l", 6, "stub"], ["b", "r", 6, "short"]], rails: [["r", "t", 8, 26, 1], ["l", "b", 20, 10, 0.4]] },
  { bright: ["tl", "tr"], trims: [["t", "l", 6, "pairLong"], ["b", "l", 6, "long"]], rails: [["l", "t", 8, 10, 1], ["r", "t", 8, 10, 1]] },
  { bright: ["br"], trims: [["t", "l", 6, "beam"], ["b", "r", 6, "stub"], ["b", "l", 6, "trail"]], rails: [["r", "b", 8, 24, 1], ["l", "t", 8, 8, 0.4]] },
  { bright: ["tl", "bl"], trims: [["t", "l", 6, "stubLong"], ["t", "r", 30, "long"], ["b", "l", 6, "rise"]], rails: [["l", "b", 8, 18, 1]] },
  { thick: true, bright: ["tr", "br"], trims: [["t", "l", 6, "dash"], ["t", "r", 6, "bar"], ["b", "l", 6, "pair"], ["b", "r", 6, "short"]], rails: [["r", "t", 8, 30, 1], ["r", "b", 8, 8, 0.4], ["l", "b", 8, 14, 0.4]] },
  { bright: ["bl", "tr"], trims: [["t", "l", 6, "split"], ["t", "r", 6, "pair"], ["b", "r", 6, "rise"]], rails: [["l", "t", 8, 22, 0.4]] },
];

function trim(thick, edge, from, offset, run) {
  let at = CUT + offset;
  return RUN[run].map(([w, a], i) => {
    const lead = thick && i === 0 && edge === "t" && from === "l";
    const d = div().absolute().w(w).h(lead ? 3 : 2).bg(a === 1 ? SHELL : alpha(SHELL, a));
    const placed = from === "l" ? (edge === "t" ? d.top(0) : d.bottom(0)).left(at) : (edge === "t" ? d.top(0) : d.bottom(0)).right(at);
    at += w + 4;
    return placed;
  });
}

function rail(side, from, offset, len, a) {
  const d = div().absolute().w(2).h(len).bg(a === 1 ? SHELL : alpha(SHELL, a));
  const x = side === "l" ? d.left(0) : d.right(0);
  return from === "t" ? x.top(CUT + offset) : x.bottom(CUT + offset);
}

// Draws el over a cut-corner island. `frame` is "all", "top" or "bottom" (an island split over two blocks), then optionally "small" (no side rails) and "v<n>" (a trim variant).
export function edgeFrame(el, frame) {
  if (!frame) return el;
  const words = frame.split(" "), part = words[0], small = words.includes("small");
  const v = VARIANTS[Number(words.find((w) => /^v\d+$/.test(w))?.slice(1) ?? 0) % VARIANTS.length];
  const t = theme(), top = part !== "bottom", bottom = part !== "top";
  const face = v_flex().absolute().top(0).left(0).size_full()
    .when(top, (x) => x.child(band("tl", "tr", "t", t, v.bright)))
    .child(div().flex_1().w_full().bg(t.background).border_color(t.border).border_l(1).border_r(1))
    .when(bottom, (x) => x.child(band("bl", "br", "b", t, v.bright)))
    .children(v.trims.filter(([edge]) => (edge === "t" ? top : bottom)).flatMap((x) => trim(v.thick, ...x)))
    .when(!small, (x) => x.children(v.rails.filter(([, from]) => (from === "t" ? top : bottom)).map((r) => rail(...r))));
  return div().relative().size_full().child(face).child(el.bg("#00000000").border_color("#00000000"));
}
