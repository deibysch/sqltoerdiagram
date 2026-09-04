// Build a standalone SVG string of the current diagram (vector, theme-aware).
import { THEMES, columnY, ROW_H, HEADER_H, EDGE_COLORS } from './renderer.js';
import { NOTE_COLORS, GROUP_COLORS, resolveGroupColor } from './annotations.js';
import { relationCardinality } from './cardinality.js';
import { getTableAnchor, buildSVGPath } from './routing.js';

// Crow's-foot cardinality marker at a line endpoint (world coords).
//   (nx, ny) = outward normal vector from the table edge (pointing along the line).
function svgMarker(x, y, nx, ny, kind, color) {
  if (typeof ny === 'string') {
    color = kind;
    kind = ny;
    ny = 0;
    nx = nx < 0 ? -1 : 1;
  }

  const len = Math.hypot(nx, ny);
  const unx = len > 0.001 ? nx / len : 1;
  const uny = len > 0.001 ? ny / len : 0;

  // Perpendicular unit vector (-uny, unx) along table edge
  const px = -uny;
  const py = unx;

  const foot = 11, spread = 5.5, r = 3.2;
  const attr = `fill="none" stroke="${color}" stroke-width="1.5"`;
  const many = kind === 'many' || kind === 'zero-or-many';
  const optional = kind === 'zero-or-one' || kind === 'zero-or-many';
  let out = '';

  const roundNum = (v) => Math.round(v * 100) / 100;

  if (many) {
    const ax = roundNum(x + unx * foot);
    const ay = roundNum(y + uny * foot);
    const p1x = roundNum(x + px * spread), p1y = roundNum(y + py * spread);
    const p2x = roundNum(x - px * spread), p2y = roundNum(y - py * spread);
    const bx = roundNum(x), by = roundNum(y);
    out += `<path d="M ${ax} ${ay} L ${p1x} ${p1y} M ${ax} ${ay} L ${p2x} ${p2y} M ${ax} ${ay} L ${bx} ${by}" ${attr}/>`;
  } else {
    const bx = x + unx * foot;
    const by = y + uny * foot;
    const p1x = roundNum(bx + px * spread), p1y = roundNum(by + py * spread);
    const p2x = roundNum(bx - px * spread), p2y = roundNum(by - py * spread);
    out += `<path d="M ${p1x} ${p1y} L ${p2x} ${p2y}" ${attr}/>`;
  }
  if (optional) {
    const cx = roundNum(x + unx * (foot + r + 2));
    const cy = roundNum(y + uny * (foot + r + 2));
    out += `<circle cx="${cx}" cy="${cy}" r="${r}" ${attr}/>`;
  }
  return out;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const hexA = (hex, a) => {
  if (!hex || typeof hex !== 'string') return `rgba(90,167,255,${a})`;
  if (hex.startsWith('rgba') || hex.startsWith('hsla')) return hex;
  if (hex.startsWith('rgb(')) return hex.replace('rgb(', 'rgba(').replace(')', `,${a})`);
  let s = hex.replace('#', '');
  if (s.length === 3) s = s.split('').map(c => c + c).join('');
  if (s.length === 6) {
    const n = parseInt(s, 16);
    if (!Number.isNaN(n)) return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  return `rgba(90,167,255,${a})`;
};

export function exportSVG(
  model,
  themeName,
  annotations = [],
  hidden = null,
  edgeColorMode = 'multi',
  edgeColors = null,
  edgeRouting = 'curved',
  edgeWaypoints = null,
  edgeAnchors = null,
  edgeRoutings = null
) {
  const theme = THEMES[themeName] || THEMES.dark;
  const isHidden = (k) => !!(hidden && hidden.has(k));
  const ts = model.tables.filter(t => Number.isFinite(t.x) && !isHidden(t.key));
  if (!ts.length && !annotations.length) return null;

  const pad = 40;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of ts) {
    x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y);
    x1 = Math.max(x1, t.x + t.w); y1 = Math.max(y1, t.y + t.h);
  }
  for (const a of annotations) {
    x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y);
    x1 = Math.max(x1, a.x + a.w); y1 = Math.max(y1, a.y + a.h);
  }
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const W = x1 - x0, H = y1 - y0;

  const byKey = new Map(model.tables.map(t => [t.key, t]));
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(W)}" height="${Math.ceil(H)}" viewBox="${x0} ${y0} ${W} ${H}" font-family="ui-sans-serif, system-ui, sans-serif">`);
  parts.push(`<rect x="${x0}" y="${y0}" width="${W}" height="${H}" fill="${theme.bg}"/>`);

  // group boxes (behind everything)
  for (const a of annotations) {
    if (a.type !== 'group') continue;
    const color = resolveGroupColor(a.color);
    parts.push(`<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="12" fill="${hexA(color, 0.08)}" stroke="${hexA(color, 0.7)}" stroke-width="1.5"/>`);
    if (a.text) parts.push(`<text x="${a.x + 10}" y="${a.y + 16}" dominant-baseline="middle" font-weight="600" font-size="13" fill="${color}">${esc(a.text)}</text>`);
  }

  // edges
  let edgeIndex = 0;
  for (const r of model.relations) {
    const from = byKey.get(r.fromTable.toLowerCase());
    const to = byKey.get(r.toTable.toLowerCase());
    if (!from || !to || !Number.isFinite(from.x) || !Number.isFinite(to.x)) continue;
    if (isHidden(from.key) || isHidden(to.key)) continue;

    const relKey = `${from.key}.${(r.fromCols[0] || '').toLowerCase()}->${to.key}.${(r.toCols[0] || '').toLowerCase()}`;
    const customColor = edgeColors?.get ? edgeColors.get(relKey) : (edgeColors && edgeColors[relKey]?.color);
    let color;
    if (customColor) {
      color = customColor;
    } else if (edgeColorMode === 'single') {
      color = theme.edge;
    } else {
      color = EDGE_COLORS[edgeIndex % EDGE_COLORS.length];
    }
    edgeIndex++;

    const waypoints = edgeWaypoints?.get ? (edgeWaypoints.get(relKey) || []) : (edgeWaypoints && edgeWaypoints[relKey]) || [];
    const anchorCfg = edgeAnchors?.get ? edgeAnchors.get(relKey) : (edgeAnchors && edgeAnchors[relKey]);
    const rStyle = (edgeRoutings?.get ? edgeRoutings.get(relKey) : (edgeRoutings && edgeRoutings[relKey])) || edgeRouting || 'curved';

    const targetForFrom = waypoints.length ? waypoints[0] : (to ? { x: to.x + to.w / 2, y: to.y + to.h / 2 } : null);
    const targetForTo = waypoints.length ? waypoints[waypoints.length - 1] : (from ? { x: from.x + from.w / 2, y: from.y + from.h / 2 } : null);

    const p1 = getTableAnchor(from, r.fromCols[0], targetForFrom, anchorCfg?.fromAnchor);
    const p2 = getTableAnchor(to, r.toCols[0], targetForTo, anchorCfg?.toAnchor);

    const pathD = buildSVGPath(rStyle, p1, p2, waypoints, 8);
    parts.push(`<path d="${pathD}" fill="none" stroke="${color}" stroke-width="1.5"/>`);
    const card = relationCardinality(r, byKey);
    let nx1 = p1.nx, ny1 = p1.ny;
    if ((nx1 === undefined || nx1 === null || (nx1 === 0 && ny1 === 0)) && (waypoints?.length || p2)) {
      const nextPt = waypoints?.length ? waypoints[0] : p2;
      const dx = nextPt.x - p1.x, dy = nextPt.y - p1.y;
      const d = Math.hypot(dx, dy) || 1;
      nx1 = dx / d; ny1 = dy / d;
    }
    let nx2 = p2.nx, ny2 = p2.ny;
    if ((nx2 === undefined || nx2 === null || (nx2 === 0 && ny2 === 0)) && (waypoints?.length || p1)) {
      const prevPt = waypoints?.length ? waypoints[waypoints.length - 1] : p1;
      const dx = prevPt.x - p2.x, dy = prevPt.y - p2.y;
      const d = Math.hypot(dx, dy) || 1;
      nx2 = dx / d; ny2 = dy / d;
    }
    parts.push(svgMarker(p1.x, p1.y, nx1 ?? 1, ny1 ?? 0, card.from, color));
    parts.push(svgMarker(p2.x, p2.y, nx2 ?? -1, ny2 ?? 0, card.to, color));
  }

  // tables
  for (const t of ts) {
    const g = [];
    g.push(`<g transform="translate(${t.x} ${t.y})">`);
    g.push(`<rect x="0" y="0" width="${t.w}" height="${t.h}" rx="10" fill="${theme.tableBg}" stroke="${theme.tableBorder}"/>`);
    // header
    g.push(`<path d="M0 ${HEADER_H} V10 a10 10 0 0 1 10 -10 H${t.w - 10} a10 10 0 0 1 10 10 V${HEADER_H} Z" fill="${theme.header}"/>`);
    g.push(`<line x1="0" y1="${HEADER_H}" x2="${t.w}" y2="${HEADER_H}" stroke="${theme.divider}"/>`);
    g.push(`<text x="12" y="${HEADER_H / 2}" dominant-baseline="middle" font-weight="600" font-size="14" fill="${theme.headerText}">${esc(t.name)}</text>`);

    for (let i = 0; i < t.columns.length; i++) {
      const c = t.columns[i];
      const y = HEADER_H + i * ROW_H;
      if (i % 2 === 1) g.push(`<rect x="1" y="${y}" width="${t.w - 2}" height="${ROW_H}" fill="${theme.rowAlt}"/>`);
      const cy = y + ROW_H / 2;
      if (c.pk) g.push(`<text x="10" y="${cy}" dominant-baseline="middle" font-size="9" font-weight="700" fill="${theme.pk}">PK</text>`);
      else if (c.fk) g.push(`<text x="10" y="${cy}" dominant-baseline="middle" font-size="9" font-weight="700" fill="${theme.fk}">FK</text>`);
      g.push(`<text x="38" y="${cy}" dominant-baseline="middle" font-size="13" font-family="ui-monospace, Menlo, monospace" fill="${theme.rowText}">${esc(c.name)}</text>`);
      if (c.type) g.push(`<text x="${t.w - 12}" y="${cy}" dominant-baseline="middle" text-anchor="end" font-size="12" font-family="ui-monospace, Menlo, monospace" fill="${theme.typeText}">${esc(c.type)}</text>`);
    }
    g.push('</g>');
    parts.push(g.join(''));
  }

  // sticky notes (front)
  for (const a of annotations) {
    if (a.type !== 'note') continue;
    const c = NOTE_COLORS[a.color] || NOTE_COLORS.yellow;
    parts.push(`<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="8" fill="${c.fill}"/>`);
    if (a.text) {
      const pad = 10, lh = 17, maxChars = Math.max(4, Math.floor((a.w - pad * 2) / 7));
      const lines = wrap(a.text, maxChars);
      const tspans = lines.map((ln, i) =>
        `<tspan x="${a.x + pad}" y="${a.y + pad + 12 + i * lh}">${esc(ln)}</tspan>`).join('');
      parts.push(`<text font-size="13" fill="${c.text}">${tspans}</text>`);
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}

// rough word-wrap by character budget (SVG has no auto-wrap)
function wrap(text, maxChars) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > maxChars && line) { out.push(line); line = word; }
      else line = (line ? line + ' ' : '') + word;
    }
    out.push(line);
  }
  return out;
}
