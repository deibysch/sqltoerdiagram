// What rides on a connection: the multiplicity at each end and the relation's
// name. Kept out of the canvas so the SVG export draws from the very same
// numbers, and so the geometry can be tested without a browser.
//
// Multiplicity is written in UML notation (1, 1..*, 0..1, 0..*). By default it
// is derived from the schema (cardinality.js); whatever the user types for an
// end wins over that, and keeps winning until they clear it.
//
// A name sits at a fraction `t` of the way along the drawn line plus a
// perpendicular offset `off`, so re-routing the line carries the name with it
// instead of leaving it stranded in the middle of the canvas.

import { buildOrthogonalPoints } from './routing.js';

const CARD_TEXT = {
  'one': '1',
  'many': '1..*',
  'zero-or-one': '0..1',
  'zero-or-many': '0..*',
};

/** Where a name sits when it has never been dragged. */
export const DEFAULT_NAME_POS = { t: 0.5, off: -12 };

const CURVE_STEPS = 16;   // samples per curve piece: smooth enough to place text on

export function multiplicityText(kind) {
  return CARD_TEXT[kind] || '';
}

/** What each end reads: the schema's answer unless the user wrote their own. */
export function cardTexts(card, custom) {
  const pick = (own, kind) => {
    const text = own == null ? '' : String(own).trim();
    return text || multiplicityText(kind);
  };
  return {
    from: pick(custom && custom.from, card && card.from),
    to: pick(custom && custom.to, card && card.to),
  };
}

/**
 * Where the multiplicity of one end sits: past the connector marker, and a
 * little to the side, so it never lands on the line itself. `at` is the anchor
 * on the table edge, `toward` the next point the line heads for.
 */
export function cardAnchor(at, toward, hasMarker = true) {
  let nx = at.nx, ny = at.ny;
  if (!Number.isFinite(nx) || (nx === 0 && ny === 0)) {
    const dx = (toward?.x ?? at.x + 1) - at.x;
    const dy = (toward?.y ?? at.y) - at.y;
    const d = Math.hypot(dx, dy) || 1;
    nx = dx / d; ny = dy / d;
  }
  const gap = hasMarker ? 26 : 14;
  return { x: at.x + nx * gap - ny * 10, y: at.y + ny * gap + nx * 10 };
}

function cubicPoint(p0, c1, c2, p1, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y,
  };
}

function quadPoint(p0, c, p1, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

/**
 * The drawn line as a polyline. The orthogonal styles already are one; curves
 * are sampled with the same control points drawRoutePath uses, so text lands
 * on the line the user actually sees.
 */
export function routePolyline(style, p1, p2, waypoints = [], obstacles = [], laneOffset = 0) {
  const plain = [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }];
  if (!Number.isFinite(p1.x) || !Number.isFinite(p2.x)) return plain;

  if (style === 'ortho-sharp' || style === 'ortho-rounded') {
    const ortho = buildOrthogonalPoints(p1, p2, waypoints, obstacles, laneOffset);
    return ortho.length >= 2 ? ortho.map(p => ({ x: p.x, y: p.y })) : plain;
  }

  const pts = [p1, ...(waypoints || []), p2];
  if (style === 'straight') return pts.map(p => ({ x: p.x, y: p.y }));

  // curved
  if (pts.length <= 2) {
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const bend = Math.max(36, Math.min(dist * 0.45, 200));
    const nx1 = p1.nx !== undefined ? p1.nx : (p1.x <= p2.x ? 1 : -1);
    const ny1 = p1.ny !== undefined ? p1.ny : 0;
    const nx2 = p2.nx !== undefined ? p2.nx : (p2.x <= p1.x ? 1 : -1);
    const ny2 = p2.ny !== undefined ? p2.ny : 0;
    const c1 = { x: p1.x + nx1 * bend, y: p1.y + ny1 * bend };
    const c2 = { x: p2.x + nx2 * bend, y: p2.y + ny2 * bend };
    const out = [];
    for (let i = 0; i <= CURVE_STEPS; i++) out.push(cubicPoint(p1, c1, c2, p2, i / CURVE_STEPS));
    return out;
  }

  // a curve through the waypoints: each piece ends halfway to the next point
  let cur = { x: pts[0].x, y: pts[0].y };
  const out = [cur];
  for (let i = 0; i < pts.length - 1; i++) {
    const ctrl = pts[i];
    const end = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
    for (let s = 1; s <= CURVE_STEPS; s++) out.push(quadPoint(cur, ctrl, end, s / CURVE_STEPS));
    cur = end;
  }
  out.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y });
  return out;
}

function cumulative(pts) {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) {
    acc.push(acc[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return acc;
}

/** The point a fraction `t` of the way along the polyline, plus its direction. */
export function pointAtFraction(pts, t) {
  if (!pts || pts.length < 2) {
    const p = (pts && pts[0]) || { x: 0, y: 0 };
    return { x: p.x, y: p.y, tx: 1, ty: 0 };
  }
  const acc = cumulative(pts);
  const total = acc[acc.length - 1];
  if (total <= 0) return { x: pts[0].x, y: pts[0].y, tx: 1, ty: 0 };

  const want = Math.max(0, Math.min(1, t)) * total;
  let i = 1;
  while (i < acc.length - 1 && acc[i] < want) i++;
  const a = pts[i - 1], b = pts[i];
  const segLen = acc[i] - acc[i - 1] || 1;
  const f = Math.max(0, Math.min(1, (want - acc[i - 1]) / segLen));
  const dx = (b.x - a.x) / segLen, dy = (b.y - a.y) / segLen;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, tx: dx, ty: dy };
}

/** Where a label sits: `t` along the line, then `off` px to one side of it. */
export function labelAnchor(pts, pos = DEFAULT_NAME_POS) {
  const t = Number.isFinite(pos?.t) ? pos.t : DEFAULT_NAME_POS.t;
  const off = Number.isFinite(pos?.off) ? pos.off : DEFAULT_NAME_POS.off;
  const at = pointAtFraction(pts, t);
  return { x: at.x - at.ty * off, y: at.y + at.tx * off, tx: at.tx, ty: at.ty };
}

/** The `{ t, off }` that puts a label under the pointer: used while dragging. */
export function nearestPosition(pts, x, y) {
  if (!pts || pts.length < 2) return { ...DEFAULT_NAME_POS };
  const acc = cumulative(pts);
  const total = acc[acc.length - 1] || 1;
  let best = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const f = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
    const px = a.x + dx * f, py = a.y + dy * f;
    const dist = Math.hypot(x - px, y - py);
    if (!best || dist < best.dist) {
      const len = Math.sqrt(len2) || 1;
      // sign of the cross product tells which side of the line the pointer is on
      const side = Math.sign((dx / len) * (y - py) - (dy / len) * (x - px)) || 1;
      best = { dist, t: (acc[i - 1] + len * f) / total, off: dist * side };
    }
  }
  return { t: best.t, off: Math.round(best.off) };
}

// --- how a multiplicity is painted -----------------------------------------

/** '#rgb' or '#rrggbb' as [r, g, b]; null for anything else. */
function rgbOf(color) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb) => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');

// relative luminance, as WCAG defines it
function luminance(rgb) {
  const [r, g, b] = rgb.map(v => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const ratioOf = (a, b) => {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

/** The WCAG contrast ratio between two hex colours, from 1 to 21; null if either is not one. */
export function contrastRatio(a, b) {
  const ca = rgbOf(a), cb = rgbOf(b);
  return ca && cb ? ratioOf(ca, cb) : null;
}

const readableCache = new Map();

/**
 * The same colour, lightened on a dark background or darkened on a light one,
 * just far enough to reach `ratio` contrast with it. A colour that already
 * reads comes back untouched, and so does anything that is not a hex colour.
 */
export function readableOn(color, background, ratio) {
  const id = `${color}|${background}|${ratio}`;
  if (readableCache.has(id)) return readableCache.get(id);
  const c = rgbOf(color), bg = rgbOf(background);
  let out = color;
  if (c && bg && ratioOf(c, bg) < ratio) {
    const toward = ratioOf(WHITE, bg) > ratioOf(BLACK, bg) ? WHITE : BLACK;
    const mix = (t) => c.map((v, i) => Math.round(v + (toward[i] - v) * t));
    let lo = 0, hi = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (ratioOf(mix(mid), bg) >= ratio) hi = mid; else lo = mid;
    }
    out = toHex(mix(hi));
  }
  readableCache.set(id, out);
  return out;
}

/** Whether the theme's canvas is dark: white text would stand out on it more than black. */
export function isDarkCanvas(theme) {
  const bg = rgbOf(theme && theme.bg);
  return !!bg && ratioOf(WHITE, bg) > ratioOf(BLACK, bg);
}

// Multiplicities are small, so they ask for more than the 4.5:1 of body text;
// over a group box, whose tint lightens the canvas, 6:1 still reads.
const DARK_CANVAS_CONTRAST = 6;

/**
 * How the multiplicity of a line in `color` is painted: its fill, the thin
 * border around the letters and their weight.
 *
 * On a light canvas the palette's pale colours (amber, mint, cyan) cannot be
 * read however they are drawn, so the text keeps the line's colour and a thin
 * border in the theme's dark text colour gives it its shape.
 *
 * On a dark canvas that trick backfires: a light border swamps letters this
 * small and they read as white. The colours are bright there to begin with, so
 * the colour itself carries the text: lightened only where it is too dim (the
 * single-colour grey, the deep purples), a touch bolder since nothing outlines
 * it, and bordered in the canvas colour, which only shows where it cuts a line
 * passing underneath.
 */
export function multiplicityPaint(color, theme) {
  if (isDarkCanvas(theme)) {
    return { fill: readableOn(color, theme.bg, DARK_CANVAS_CONTRAST), outline: theme.bg, width: 1.25, weight: 600 };
  }
  return { fill: color, outline: theme.headerText, width: 1.25, weight: 400 };
}
