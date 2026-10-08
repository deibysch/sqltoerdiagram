// The layout behind "Optimize for" in the Tables menu: Shortest lines, Fewest
// crossings and Balanced, each in the shape picked under Shape. The goal and the
// shape are the objective it polishes for (layout-goals.js); Balanced with the
// Auto shape is this layout as it was first tuned, under the name "Short lines,
// compact", beside three other group layouts that have since been removed.
//
// Routing-aware layout for the groups that already exist on the canvas.
//
// "Organizar grupos actuales" fills each group left-to-right in whatever order
// its tables happen to be listed, so the connections are whatever falls out.
// This one places tables so the CONNECTIONS come out well: short, few bends,
// few crossings, on a canvas you can actually read. It moves tables and group
// boxes; it never invents or deletes a group.
//
//   1. Each group is laid out internally by dagre, trying both flow directions.
//      Dagre minimises crossings far better than any grid enumeration, but it
//      puts tables with no line between them side by side: a group of many such
//      tables came out a single column. So dagre's order is also wrapped into a
//      block (wrapTables), and of the three, the one kept scores best on its
//      lines and its size, charged for being further than 1.6:1 from square.
//   2. Dagre also runs over the quotient graph — each group a single node the
//      size of its box — but ONLY to decide which groups belong next to which.
//      It must not decide the overall shape: on a chain of eight groups it
//      returns a strip nearly three screens wide, and a canvas you can only
//      read by panning sideways is worse than a few extra crossings. So its
//      ordering is wrapped into a grid whose column count is searched over.
//   3. A polish pass mirrors individual groups, re-wraps the column count and
//      swaps groups, scored on every relation across the whole canvas — the
//      only level that sees a line running from deep inside one group to deep
//      inside another. Then the boxes are pulled together while the gutters hold,
//      and last, drift towards the middle wherever that costs no line.
//   4. Ungrouped tables are dropped loose beside the group they talk to most.
//
// With no groups at all, the whole diagram is one invisible group (no box drawn)
// and gets its own wrap, wrapWholeDiagram. Steps 2 and 3 would have a single
// node to work with, leaving plain dagre over every table: a strip. Measured on
// generated schemas without groups, line length centre to centre, plain dagre ->
// the wrap:
//    35 tables    862x4365 (5.06:1)  32433px  ->  1561x1470 (1.06:1)  16136px   87ms
//    60 tables   6799x1828 (3.72:1)  93419px  ->  2260x2104 (1.07:1)  32619px  308ms
//   100 tables   8173x2244 (3.64:1) 168589px  ->  3192x2594 (1.23:1)  63138px  795ms
//   150 tables  14716x2244 (6.56:1) 524330px  ->  3192x3162 (1.01:1) 126982px  3.4s
// A grid search that tried every pair of tables (the removed "Optimized grid")
// reached 14957 / 36916 / 69040 / 131472px, in up to 50s.
//
// Measured on a 35-table / 8-group / 59-relation schema, against filling the
// groups by list order: crossings 84 -> 69, total line length 76098 -> 44748px,
// longest single line 4247 -> 2843px, canvas 11.41M -> 8.24M px2, and the share
// of the canvas that is actually table 21.8% -> 30.2%.
//
// Letting dagre pick the shape instead scored better on crossings (44) but blew
// the canvas out to 5686x1997 — the version that reads best is this one.
//
// Groups wrapped into blocks, and drifting together at the end, measured on 271
// tables in 24 groups with 63 relations, most tables without any: the longest
// group 33.6:1 -> 3.4:1, the canvas 32211x28634 -> 12770x10365 (5% -> 32% of
// it table), real lines and crossings 55907 -> 47441 (Balanced's first layout,
// quick Optimal Route, length + 200 per crossing). On 15 smaller schemas the
// canvas came out 27% smaller and those lines 17% shorter, worse on one.
//
// The score is a cheap geometric estimate, never the real router. The search panel
// can measure the best layouts with Optimal Route when the user asks for it
// (compact-search-core.js).

import dagre from '@dagrejs/dagre';
import { measureTable } from './renderer.js';
import { AUTO_SHAPE, goalOf, linkCost, layoutScore, shapeCharge } from './layout-goals.js';

// What a line, a bend and a crossing cost, and what shape the canvas should take,
// come from the objective (layout-goals.js): "Optimize for" picks the goal and the
// shape. Balanced with the Auto shape is this algorithm as it was first tuned.
const GL_PAD_X = 32;         // group box padding
const GL_PAD_TOP = 56;       // ... leaving room for the group label
const GL_PAD_BOTTOM = 28;
// Gutter and rank separation, swept together on the 4-domain schema: at 90/70
// the layout keeps its 3 crossings while the total line length drops from
// 12353px to 9833px. Wider settings only inflate the canvas.
const GL_GUTTER = 90;
const GL_LOOSE_GAP = 72;     // space between a loose table and the group it hangs off
const GL_POLISH_ROUNDS = 6;  // whole-canvas polish sweeps
// A layout can be shorter on every line and still be miserable to read if it
// stretches into a long strip: "Fit" then shrinks everything to nothing and you
// pan sideways forever. So the shape is charged for too (layout-goals.js). The
// Auto shape pulls a canvas with groups towards 1.6:1 at 9000 px per unit off;
// without groups that flat charge was outweighed once a big diagram's estimate
// ran into six figures (the wrap came out 3.2:1 at 60 tables), so there any shape
// from square to 2:1 is free and past that the score is multiplied instead.
const GL_INNER = { nodesep: 40, ranksep: 70, edgesep: 20 };
// A group's own layout scores the same from square to this far off it either
// way, and past that its score is multiplied by 1 + cost ln(how far past).
const GL_SQUARE = { tolerance: 1.6, cost: 2 };
const GL_OUTER = { nodesep: GL_GUTTER, ranksep: GL_GUTTER, edgesep: 40 };

/** Do the two boxes share any vertical or horizontal overlap? */
function sharesAxis(a, b) {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 8
      || Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 8;
}

function centreOf(b) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Which side of the line p->q the point r falls on: -1, 0 or 1. */
function side(p, q, r) {
  return Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
}

/** Do two centre-to-centre segments properly cross? */
function segmentsCross(a1, a2, b1, b2) {
  const d1 = side(a1, a2, b1), d2 = side(a1, a2, b2);
  const d3 = side(b1, b2, a1), d4 = side(b1, b2, a2);
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

/**
 * Cheap quality estimate: Manhattan length centre to centre, a bend whenever two
 * boxes share no axis, and every pair of those straight connections that cross.
 * Length and bends count each connection as often as it is repeated.
 */
function measureLinks(boxes, links) {
  let length = 0, bends = 0, crossings = 0;
  const segs = [];
  for (const l of links) {
    const A = boxes[l.a], B = boxes[l.b];
    if (!A || !B) continue;
    const s = linkSegment(A, B);
    length += segmentLength(s) * l.w;
    if (!sharesAxis(A, B)) bends += l.w;
    segs.push(s);
  }
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) if (segsCross(segs[i], segs[j])) crossings++;
  }
  return { length, bends, crossings };
}

/** The straight line between the centres of two boxes, with its bounds: [from, to, left, right, top, bottom]. */
function linkSegment(A, B) {
  const ca = centreOf(A), cb = centreOf(B);
  return [ca, cb, Math.min(ca.x, cb.x), Math.max(ca.x, cb.x), Math.min(ca.y, cb.y), Math.max(ca.y, cb.y)];
}

function segmentLength(s) {
  return Math.abs(s[0].x - s[1].x) + Math.abs(s[0].y - s[1].y);
}

/** Do two link segments cross? Those whose bounds are apart cannot: the exact test is skipped. */
function segsCross(a, b) {
  if (a[3] < b[2] || b[3] < a[2] || a[5] < b[4] || b[5] < a[4]) return false;
  return segmentsCross(a[0], a[1], b[0], b[1]);
}

/** The line part of the score for these boxes, as the goal weighs bends and crossings. */
function estimateCost(boxes, links, goal) {
  return linkCost(measureLinks(boxes, links), goal);
}

/**
 * What a group's own layout is scored on: its lines as the goal weighs them plus
 * its width and height, so that of two with the same lines the smaller wins, all
 * of it multiplied by 1 + GL_SQUARE.cost ln(how far past GL_SQUARE.tolerance
 * from square it is either way). Boxes as near square as the lines allow pack
 * into the grid of groups with the least room wasted between them.
 */
function groupScore(boxes, links, goal) {
  const m = measureLayout(boxes, links);
  const stray = Math.max(m.width / m.height, m.height / m.width) / GL_SQUARE.tolerance;
  return (linkCost(m, goal) + m.width + m.height) * (1 + GL_SQUARE.cost * Math.log(Math.max(1, stray)));
}

/** measureLinks plus the size of the canvas taken by the boxes that are placed. */
function measureLayout(boxes, links) {
  const m = measureLinks(boxes, links);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    if (!b || !Number.isFinite(b.x)) continue;
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  m.width = x1 > x0 ? x1 - x0 : 0;
  m.height = y1 > y0 ? y1 - y0 : 0;
  return m;
}

/**
 * Lay out boxes with dagre and return them normalised to the origin. `nodes`
 * carry w/h; `links` are { a, b, w } over node indices.
 */
function dagreArrange(nodes, links, dir, preset) {
  if (!nodes.length) return { boxes: [], w: 0, h: 0 };
  if (nodes.length === 1) {
    return { boxes: [{ x: 0, y: 0, w: nodes[0].w, h: nodes[0].h }], w: nodes[0].w, h: nodes[0].h };
  }

  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({
    rankdir: dir,
    nodesep: preset.nodesep,
    ranksep: preset.ranksep,
    edgesep: preset.edgesep,
    ranker: 'network-simplex',
    acyclicer: 'greedy',
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));

  nodes.forEach((n, i) => g.setNode(String(i), { width: n.w, height: n.h }));
  let e = 0;
  for (const l of links) {
    if (l.a === l.b) continue;
    g.setEdge(String(l.a), String(l.b), { weight: l.w, minlen: 1 }, 'e' + e++);
  }
  dagre.layout(g);

  const boxes = nodes.map((n, i) => {
    const nd = g.node(String(i));
    return nd
      ? { x: nd.x - n.w / 2, y: nd.y - n.h / 2, w: n.w, h: n.h }
      : { x: 0, y: 0, w: n.w, h: n.h };
  });

  const minX = Math.min(...boxes.map(b => b.x));
  const minY = Math.min(...boxes.map(b => b.y));
  for (const b of boxes) { b.x -= minX; b.y -= minY; }
  return {
    boxes,
    w: Math.max(...boxes.map(b => b.x + b.w)),
    h: Math.max(...boxes.map(b => b.y + b.h)),
  };
}

/**
 * Wrap an ordering into a grid of `cols` columns. Column widths and row heights
 * follow the items that actually land in them, so a wide box never leaves a
 * hole beside a narrow one.
 */
function placeInGrid(items, order, cols, gap) {
  const rows = Math.ceil(order.length / cols);
  const colW = new Array(cols).fill(0);
  const rowH = new Array(rows).fill(0);
  order.forEach((idx, slot) => {
    const it = items[idx];
    if (!it) return;
    colW[slot % cols] = Math.max(colW[slot % cols], it.w);
    rowH[(slot / cols) | 0] = Math.max(rowH[(slot / cols) | 0], it.h);
  });

  const colX = [0];
  for (let c = 1; c < cols; c++) colX[c] = colX[c - 1] + colW[c - 1] + gap;
  const rowY = [0];
  for (let r = 1; r < rows; r++) rowY[r] = rowY[r - 1] + rowH[r - 1] + gap;

  const boxes = new Array(items.length).fill(null);
  order.forEach((idx, slot) => {
    const it = items[idx];
    if (!it) return;
    const c = slot % cols, r = (slot / cols) | 0;
    boxes[idx] = { x: colX[c] + (colW[c] - it.w) / 2, y: rowY[r] + (rowH[r] - it.h) / 2, w: it.w, h: it.h };
  });
  return {
    boxes,
    w: colX[cols - 1] + colW[cols - 1],
    h: rowY[rows - 1] + rowH[rows - 1],
  };
}

/**
 * Mirror a layout. Tables cannot be rotated, so only the two reflections are
 * available — but that is enough to turn a group around to face its partners.
 */
function mirror(boxes, w, h, flipX, flipY) {
  return boxes.map(b => ({
    x: flipX ? w - b.x - b.w : b.x,
    y: flipY ? h - b.y - b.h : b.y,
    w: b.w, h: b.h,
  }));
}

// --- Direction and Spacing, driven by the Arrange menu ---------------------
// Copied into each group-layout algorithm on purpose: the three are deliberately
// independent, so these helpers are duplicated rather than shared.

// "comfortable" is exactly the values this algorithm was tuned and measured
// with, so the setting the user already likes never moves. Gutters between group
// boxes are damped to half the factor: widening them costs far more routing
// quality than widening the gaps between tables (measured on the compact
// variant, gutter 90 -> 220 took total line length from 9833px to 12319px).
const GL_SPACING = { compact: 0.75, comfortable: 1, spacious: 1.45 };

function spacingScale(spacing) {
  const f = GL_SPACING[spacing] ?? 1;
  return { gap: f, pad: f, gutter: 1 + (f - 1) * 0.5 };
}

/**
 * The padding of a group box, the gap between two tables side by side and the
 * gutter between two group boxes, at `spacing`: what this layout leaves, for
 * whatever moves its tables afterwards (compact-refine.js).
 */
export function compactSpacing(spacing) {
  const S = spacingScale(spacing);
  return {
    padX: Math.round(GL_PAD_X * S.pad),
    padTop: Math.round(GL_PAD_TOP * S.pad),
    padBottom: Math.round(GL_PAD_BOTTOM * S.pad),
    gap: Math.round(GL_INNER.nodesep * S.gap),
    gutter: Math.round(GL_GUTTER * S.gutter),
  };
}

/** The box this layout draws around `tables`, with the padding of compactSpacing(). */
export function fitGroupBox(tables, pad) {
  const x0 = Math.min(...tables.map(t => t.x));
  const y0 = Math.min(...tables.map(t => t.y));
  const x1 = Math.max(...tables.map(t => t.x + t.w));
  const y1 = Math.max(...tables.map(t => t.y + t.h));
  return {
    x: Math.round(x0 - pad.padX),
    y: Math.round(y0 - pad.padTop),
    w: Math.round(x1 - x0 + pad.padX * 2),
    h: Math.round(y1 - y0 + pad.padTop + pad.padBottom),
  };
}

/** Groups defined on the canvas, with their member tables resolved. */
export function collectGroupsCompact(model, annotations = []) {
  const tables = model?.tables || [];
  const byKey = new Map(tables.map(t => [t.key.toLowerCase(), t]));
  const groupAnnos = (annotations || []).filter(a => a.type === 'group');
  const raw = [];

  if (groupAnnos.length) {
    for (const a of groupAnnos) {
      let keys = Array.isArray(a.tables)
        ? a.tables.map(k => String(k).toLowerCase()).filter(k => byKey.has(k))
        : [];
      // A box drawn around tables without listing them still counts.
      if (!keys.length && Number.isFinite(a.x) && Number.isFinite(a.w)) {
        for (const t of tables) {
          if (!Number.isFinite(t.x)) continue;
          if (t.x >= a.x - 20 && t.x + (t.w || 100) <= a.x + a.w + 20 &&
              t.y >= a.y - 20 && t.y + (t.h || 50) <= a.y + a.h + 20) {
            keys.push(t.key.toLowerCase());
          }
        }
      }
      if (keys.length) raw.push({ id: a.id, name: a.text || 'Group', color: a.color || 'blue', keys });
    }
  } else if (Array.isArray(model?.groups) && model.groups.length) {
    for (const g of model.groups) {
      const keys = (g.tables || []).map(k => String(k).toLowerCase()).filter(k => byKey.has(k));
      if (keys.length) raw.push({ name: g.name || 'Group', color: g.color || 'blue', keys });
    }
  }

  // A table belongs to one group only: the first that claims it.
  const claimed = new Set();
  const groups = [];
  for (const g of raw) {
    const keys = g.keys.filter(k => !claimed.has(k));
    for (const k of keys) claimed.add(k);
    if (keys.length) groups.push({ ...g, keys, tables: keys.map(k => byKey.get(k)) });
  }
  const loose = tables.filter(t => !claimed.has(t.key.toLowerCase()));
  return { groups, loose };
}

/**
 * Another starting point for the search (compact-search-core.js): the same
 * schema read in another order. Dagre breaks its ties in the order it is handed
 * the tables and relations, and every later step builds on what dagre returns,
 * so the whole run lands somewhere else. Seed 0 changes nothing: the arrangement
 * this option has always given.
 */
function orderShuffler(seed) {
  if (!seed) return (list) => list;
  let s = (Math.imul(seed, 2654435761) >>> 0) || 1;
  const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  return (list) => {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
}

/** Weighted table-to-table adjacency across relations and manual links. */
function buildLinks(diagram) {
  const weights = new Map();
  const bump = (a, b) => {
    if (!a || !b || a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    weights.set(key, (weights.get(key) || 0) + 1);
  };
  for (const r of (diagram.model?.relations || [])) {
    bump((r.fromTable || '').toLowerCase(), (r.toTable || '').toLowerCase());
  }
  for (const l of (diagram.manualLinks || [])) {
    bump((l.from?.table || '').toLowerCase(), (l.to?.table || '').toLowerCase());
  }
  return [...weights.entries()].map(([k, w]) => {
    const [a, b] = k.split('|');
    return { a, b, w };
  });
}

/**
 * No groups at all: the whole diagram is one invisible group, laid out by
 * wrapTables for the objective's shape. Moves the tables; returns the score of
 * the layout kept.
 */
function wrapWholeDiagram(tables, links, sp, objective) {
  const idx = new Map(tables.map((t, i) => [t.key.toLowerCase(), i]));
  const L = [];
  for (const l of links) {
    const a = idx.get(l.a), b = idx.get(l.b);
    if (a !== undefined && b !== undefined && a !== b) L.push({ a, b, w: l.w });
  }
  const score = (boxes) => layoutScore(measureLayout(boxes, L), objective, false);
  // the proportion the band count is first guessed for
  const targetRatio = typeof objective.shape?.ratio === 'number' ? objective.shape.ratio : AUTO_SHAPE.groupTarget;
  const best = wrapTables(tables, L, sp, score, targetRatio);
  best.boxes.forEach((b, i) => {
    tables[i].x = Math.round(80 + b.x);
    tables[i].y = Math.round(80 + b.y);
  });
  return best.cost;
}

/**
 * Plain dagre over many tables is a strip, so dagre only orders and a wrap
 * decides the shape. Each dagre rank becomes a column; a rank taller than the
 * band splits into side-by-side columns; and columns that run too wide wrap into
 * bands that snake back and forth, so the line joining two bands stays short.
 * Tables without a single relation go last, as one more rank: in their own
 * order, or with `lonelyBySize` the widest first, so that tables of about the
 * same width share a column. The band height and the band count are searched on
 * `score(boxes)`, the band count first guessed for `targetRatio`, with plain
 * dagre kept as a candidate for tables few enough to need no wrapping at all.
 * Last, tables swap places wherever that scores better, each trying the spots
 * nearest to itself and to its partners. `links` are { a, b, w } over table
 * indices. Returns { boxes, w, h, cost }, the boxes from the origin.
 */
function wrapTables(tables, L, sp, score, targetRatio, { lonelyBySize = false } = {}) {
  const plain = dagreArrange(tables, L, 'LR', sp.preset);
  let best = { boxes: plain.boxes, cost: score(plain.boxes), cols: null };

  // Dagre's ranks, left to right, each in dagre's top-to-bottom order. Tables
  // without a single relation go last: beside anything else they only push its
  // lines apart.
  const linked = new Set();
  for (const l of L) { linked.add(l.a); linked.add(l.b); }
  const byX = new Map();
  tables.forEach((t, i) => {
    if (!linked.has(i)) return;
    const b = plain.boxes[i];
    const cx = Math.round(b.x + b.w / 2);
    if (!byX.has(cx)) byX.set(cx, []);
    byX.get(cx).push(i);
  });
  const ranks = [...byX.keys()].sort((a, b) => a - b)
    .map(cx => byX.get(cx).sort((i, j) => plain.boxes[i].y - plain.boxes[j].y));
  const lonely = tables.map((_, i) => i).filter(i => !linked.has(i));
  if (lonelyBySize) lonely.sort((i, j) => tables[j].w - tables[i].w || tables[j].h - tables[i].h);
  if (lonely.length) ranks.push(lonely);

  const stackH = (list) => list.reduce((s, i) => s + tables[i].h, 0) + sp.rowGap * (list.length - 1);

  // Cut every rank into as few columns as keep it within the band height H, in
  // dagre's order, giving each column about the same height.
  const columnsFor = (H) => {
    const cols = [];
    for (const rank of ranks) {
      const whole = stackH(rank) + sp.rowGap;
      const k = Math.max(1, Math.min(rank.length, Math.ceil(whole / (H + sp.rowGap))));
      let col = [], acc = 0, made = 1;
      for (const i of rank) {
        const step = tables[i].h + sp.rowGap;
        if (col.length && made < k && acc + step / 2 > whole / k * made) {
          cols.push(col);
          col = [];
          made++;
        }
        col.push(i);
        acc += step;
      }
      cols.push(col);
    }
    return cols;
  };

  // Split the columns, in order, into `nb` bands of about the same width.
  const bandsFor = (colW, nb) => {
    const span = colW.reduce((s, w) => s + w + sp.colGap, 0);
    const bands = [];
    let run = [], acc = 0;
    colW.forEach((w, k) => {
      const step = w + sp.colGap;
      if (run.length && bands.length < nb - 1 && acc + step / 2 > span / nb * (bands.length + 1)) {
        bands.push(run);
        run = [];
      }
      run.push(k);
      acc += step;
    });
    bands.push(run);
    return bands;
  };

  // Odd bands run right to left, so each band starts right under where the
  // previous one ended.
  const place = (cols, colW, colH, bands) => {
    const bandW = bands.map(band => band.reduce((s, k) => s + colW[k] + sp.colGap, 0) - sp.colGap);
    const maxW = Math.max(...bandW);
    const boxes = new Array(tables.length);
    let top = 0;
    bands.forEach((band, bi) => {
      const bandH = Math.max(...band.map(k => colH[k]));
      let x = bi % 2 ? maxW - bandW[bi] : 0;
      for (const k of (bi % 2 ? band.slice().reverse() : band)) {
        let y = top + (bandH - colH[k]) / 2;
        for (const i of cols[k]) {
          const t = tables[i];
          boxes[i] = { x: x + (colW[k] - t.w) / 2, y, w: t.w, h: t.h };
          y += t.h + sp.rowGap;
        }
        x += colW[k] + sp.colGap;
      }
      top += bandH + sp.bandGap;
    });
    return boxes;
  };

  // Band heights from a single table up to the tallest rank. For each, the band
  // count that looks closest to screen-shaped is scored with its two neighbours.
  const hMin = Math.max(...tables.map(t => t.h));
  const hMax = Math.max(hMin, ...ranks.map(stackH));
  const STEPS = 16;
  for (let s = 0; s < STEPS; s++) {
    const cols = columnsFor(hMin * Math.pow(hMax / hMin, s / (STEPS - 1)));
    const colW = cols.map(c => Math.max(...c.map(i => tables[i].w)));
    const colH = cols.map(stackH);
    const span = colW.reduce((sum, w) => sum + w + sp.colGap, 0);
    const tallest = Math.max(...colH);
    let guess = 1, off = Infinity;
    for (let nb = 1; nb <= cols.length; nb++) {
      const o = Math.abs(Math.log(span / nb / (nb * (tallest + sp.bandGap)) / targetRatio));
      if (o < off) { off = o; guess = nb; }
    }
    for (const nb of [guess - 1, guess, guess + 1]) {
      if (nb < 1 || nb > cols.length) continue;
      const bands = bandsFor(colW, nb);
      const boxes = place(cols, colW, colH, bands);
      const cost = score(boxes);
      if (cost < best.cost - 0.5) best = { boxes, cost, cols, bands };
    }
  }

  // Polish: swap two tables wherever the score improves. Each table tries the
  // spots nearest to itself and to each table it is linked with, which is where
  // a swap can shorten its lines. Trying every pair instead is what made the
  // removed "Optimized grid" take seconds.
  if (best.cols) {
    const cols = best.cols.map(c => c.slice());
    const colW = cols.map(c => Math.max(...c.map(i => tables[i].w)));
    const colH = cols.map(stackH);
    const at = [];
    cols.forEach((c, k) => c.forEach((i, r) => { at[i] = [k, r]; }));
    const partners = tables.map(() => []);
    for (const l of L) { partners[l.a].push(l.b); partners[l.b].push(l.a); }

    let { boxes, cost } = best;
    const nearest = (i, count) => {
      const cx = boxes[i].x + boxes[i].w / 2, cy = boxes[i].y + boxes[i].h / 2;
      const far = (j) => Math.abs(boxes[j].x + boxes[j].w / 2 - cx) + Math.abs(boxes[j].y + boxes[j].h / 2 - cy);
      return tables.map((_, j) => j).filter(j => j !== i).sort((a, b) => far(a) - far(b)).slice(0, count);
    };
    // Swapping the same pair again undoes it, widths and heights included.
    const swap = (i, j) => {
      const [ki, ri] = at[i], [kj, rj] = at[j];
      cols[ki][ri] = j;
      cols[kj][rj] = i;
      at[i] = [kj, rj];
      at[j] = [ki, ri];
      for (const k of new Set([ki, kj])) {
        colW[k] = Math.max(...cols[k].map(t => tables[t].w));
        colH[k] = stackH(cols[k]);
      }
    };

    for (let round = 0; round < GL_POLISH_ROUNDS; round++) {
      let improved = false;
      for (let i = 0; i < tables.length; i++) {
        const tries = new Set(nearest(i, 8));
        for (const p of partners[i]) for (const j of nearest(p, 3)) tries.add(j);
        tries.delete(i);
        for (const j of tries) {
          swap(i, j);
          const trial = place(cols, colW, colH, best.bands);
          const c = score(trial);
          if (c < cost - 0.5) { cost = c; boxes = trial; improved = true; }
          else swap(i, j);
        }
      }
      if (!improved) break;
    }
    best = { boxes, cost };
  }

  return {
    boxes: best.boxes,
    w: Math.max(...best.boxes.map(b => b.x + b.w)),
    h: Math.max(...best.boxes.map(b => b.y + b.h)),
    cost: best.cost,
  };
}

/**
 * Re-arrange the existing groups and the tables inside them so the connections
 * route short, straight and untangled. Clears every stored waypoint and anchor
 * first, so the lines start from a clean slate. With no groups at all, the
 * whole diagram is laid out by wrapWholeDiagram instead.
 *
 * `opts.goal` and `opts.shape` are the objective (layout-goals.js): Balanced and
 * the Auto shape when left out. `opts.seed` starts from another order of the
 * schema (see orderShuffler), and `opts.keepSizes` trusts the sizes already on
 * the tables instead of measuring them: a worker has no canvas to measure text.
 * Returns { groups, implicit, tables, loose, annotations, cost }.
 */
export function arrangeGroupsCompact(diagram, opts = {}) {
  const objective = { goal: opts.goal, shape: opts.shape || null };
  const goal = goalOf(opts.goal).id;
  // Spacing from the Arrange menu, relative to this algorithm's tuned values.
  const S = spacingScale(opts.spacing);
  const PAD_X = Math.round(GL_PAD_X * S.pad);
  const PAD_TOP = Math.round(GL_PAD_TOP * S.pad);
  const PAD_BOTTOM = Math.round(GL_PAD_BOTTOM * S.pad);
  const GUTTER = Math.round(GL_GUTTER * S.gutter);
  const LOOSE_GAP = Math.round(GL_LOOSE_GAP * S.gap);
  const INNER = {
    nodesep: Math.round(GL_INNER.nodesep * S.gap),
    ranksep: Math.round(GL_INNER.ranksep * S.gap),
    edgesep: GL_INNER.edgesep,
  };
  const OUTER = { nodesep: GUTTER, ranksep: GUTTER, edgesep: GL_OUTER.edgesep };
  const GAP = INNER.nodesep;

  const model = diagram?.model;
  if (!model?.tables?.length) throw new Error('The diagram has no tables to arrange.');

  if (!opts.keepSizes) {
    const level = diagram.diagramLevel || 'physical';
    for (const t of model.tables) {
      const dims = measureTable(t, level);
      t.w = dims.w; t.h = dims.h; t.rowH = dims.rowH; t.headerH = dims.headerH;
    }
  }

  // Only the order the layout reads things in changes with the seed; the model
  // and the annotations keep their own order, and the group boxes come out in it.
  const vary = orderShuffler(opts.seed);
  const collected = collectGroupsCompact(model, diagram.annotations);
  // A box keeps listing its tables as it did (`listed`): an order that leaked into
  // the saved boxes would make the next run start from somewhere else.
  const groups = vary(collected.groups.map((g, rank) => ({ ...g, rank, listed: g.keys }))).map(g => {
    const order = vary(g.keys.map((_, i) => i));
    return { ...g, keys: order.map(i => g.keys[i]), tables: order.map(i => g.tables[i]) };
  });
  const loose = vary(collected.loose);

  diagram.onHistorySnapshot?.(diagram.getSnapshot());

  // Wipe every vertex and anchor: the lines must be re-derived from scratch.
  diagram.edgeWaypoints.clear();
  diagram.edgeAnchors.clear();

  const links = vary(buildLinks(diagram));

  // No groups at all: the whole diagram is one invisible group, which the group
  // machinery below has nothing to do with. It gets its own wrap instead.
  if (!groups.length) {
    const cost = wrapWholeDiagram(vary(model.tables), links, {
      rowGap: INNER.nodesep, colGap: INNER.ranksep, bandGap: GUTTER, preset: INNER,
    }, objective);
    diagram.setAnnotations((diagram.annotations || []).filter(a => a.type !== 'group'));
    diagram.markDirty();
    diagram.onLayoutChange?.();
    return { groups: 0, implicit: true, tables: model.tables.length, loose: 0, annotations: [], cost: Math.round(cost) };
  }

  const groupOf = new Map();
  groups.forEach((g, i) => g.keys.forEach(k => groupOf.set(k, i)));

  // --- 1. Inside each group: dagre in either direction, or dagre's order wrapped
  // into a block (wrapTables), whichever scores better as a group (groupScore).
  // Dagre puts tables without a relation between them side by side, so a group
  // of tables that hardly link is a single column or row, as long as they are many.
  const innerSp = { rowGap: INNER.nodesep, colGap: INNER.ranksep, bandGap: INNER.ranksep, preset: INNER };
  for (const g of groups) {
    const idxOf = new Map(g.keys.map((k, i) => [k, i]));
    const inner = [];
    for (const l of links) {
      const a = idxOf.get(l.a), b = idxOf.get(l.b);
      if (a !== undefined && b !== undefined && a !== b) inner.push({ a, b, w: l.w });
    }
    const score = (boxes) => groupScore(boxes, inner, goal);
    let best = null;
    for (const dir of ['LR', 'TB']) {
      const sol = dagreArrange(g.tables, inner, dir, INNER);
      const cost = score(sol.boxes);
      if (!best || cost < best.cost) best = { ...sol, cost };
    }
    if (g.tables.length > 2) {
      const wrap = wrapTables(g.tables, inner, innerSp, score, 1, { lonelyBySize: true });
      if (wrap.cost < best.cost - 0.5) best = wrap;
    }
    g.base = best;
    g.flipX = false;
    g.flipY = false;
    g.w = best.w + PAD_X * 2;
    g.h = best.h + PAD_TOP + PAD_BOTTOM;
  }

  // --- 2. The groups themselves: dagre over the quotient graph.
  const groupLinks = (() => {
    const m = new Map();
    for (const l of links) {
      const ga = groupOf.get(l.a), gb = groupOf.get(l.b);
      if (ga === undefined || gb === undefined || ga === gb) continue;
      const key = ga < gb ? `${ga}|${gb}` : `${gb}|${ga}`;
      m.set(key, (m.get(key) || 0) + l.w);
    }
    return [...m.entries()].map(([k, w]) => {
      const [a, b] = k.split('|').map(Number);
      return { a, b, w };
    });
  })();

  // Dagre decides which groups belong next to which, reading its output left to
  // right. It must NOT decide the overall shape: on a chain of eight groups it
  // produces a strip several screens wide, and a canvas you can only read by
  // panning sideways is worse than a few extra crossings. So the ordering is
  // dagre's, and the shape comes from wrapping that order into a grid.
  const seedOrder = (() => {
    let best = null;
    for (const dir of ['LR', 'TB']) {
      const sol = dagreArrange(groups.map(g => ({ w: g.w, h: g.h })), groupLinks, dir, OUTER);
      const cost = estimateCost(sol.boxes, groupLinks, goal);
      if (!best || cost < best.cost) {
        best = {
          cost,
          order: groups
            .map((_, i) => i)
            .sort((a, b) => {
              const A = sol.boxes[a], B = sol.boxes[b];
              return dir === 'LR' ? (A.x - B.x) || (A.y - B.y) : (A.y - B.y) || (A.x - B.x);
            }),
        };
      }
    }
    return best.order;
  })();

  let groupOrder = seedOrder.slice();
  let groupCols = Math.max(1, Math.round(Math.sqrt(groups.length)));

  const placeGroups = () => {
    const sol = placeInGrid(groups.map(g => ({ w: g.w, h: g.h })), groupOrder, groupCols, GUTTER);
    groups.forEach((g, i) => {
      g.x0 = 80 + sol.boxes[i].x;
      g.y0 = 80 + sol.boxes[i].y;
    });
  };

  const applyInner = () => {
    for (const g of groups) {
      const boxes = mirror(g.base.boxes, g.base.w, g.base.h, g.flipX, g.flipY);
      g.tables.forEach((t, i) => {
        t.x = Math.round(g.x0 + PAD_X + boxes[i].x);
        t.y = Math.round(g.y0 + PAD_TOP + boxes[i].y);
      });
    }
  };

  // --- 3. Polish on the only score that sees the long cross-group lines.
  const tableIdx = new Map(model.tables.map((t, i) => [t.key.toLowerCase(), i]));
  const globalLinks = links
    .map(l => ({ a: tableIdx.get(l.a), b: tableIdx.get(l.b), w: l.w }))
    .filter(l => l.a !== undefined && l.b !== undefined);
  // Always laid out horizontally. "Vertical" is this result turned a quarter
  // clockwise afterwards (rotate-diagram.js), exactly as the Direction menu turns
  // a finished diagram, so both directions show the same arrangement.
  const globalCost = () => layoutScore(measureLayout(model.tables, globalLinks), objective, true);

  // Two group boxes are clear of each other when they are apart by the gutter
  // on at least one axis; side by side needs no vertical gap and vice versa.
  const collides = (self, x, y) => {
    const a = { x, y, w: groups[self].w, h: groups[self].h };
    for (let j = 0; j < groups.length; j++) {
      if (j === self) continue;
      const b = groups[j];
      const ox = Math.min(a.x + a.w, b.x0 + b.w) - Math.max(a.x, b.x0);
      const oy = Math.min(a.y + a.h, b.y0 + b.h) - Math.max(a.y, b.y0);
      if (ox > -GUTTER && oy > -GUTTER) return true;
    }
    return false;
  };

  // The measures globalCost is made of, with group `i` moved to (x, y) and the rest where it stands. Moving
  // one group only changes its own lines, what they cross and the canvas, so the
  // rest is measured once here, not once for every spot the group tries: that
  // made pulling 271 tables in 24 groups together take a minute. The steps are
  // whole px, so the tables shift exactly as applyInner would put them.
  const groupAt = model.tables.map(t => groupOf.get(t.key.toLowerCase()));
  const measureMoving = (i) => {
    const g = groups[i];
    const own = [], rest = [];
    for (const l of globalLinks) (groupAt[l.a] === i || groupAt[l.b] === i ? own : rest).push(l);
    const fixed = measureLinks(model.tables, rest);
    const restSegs = rest.map(l => linkSegment(model.tables[l.a], model.tables[l.b]));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
    model.tables.forEach((t, k) => {
      if (groupAt[k] === i) {
        gx0 = Math.min(gx0, t.x); gy0 = Math.min(gy0, t.y);
        gx1 = Math.max(gx1, t.x + t.w); gy1 = Math.max(gy1, t.y + t.h);
      } else if (Number.isFinite(t.x)) {
        x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y);
        x1 = Math.max(x1, t.x + t.w); y1 = Math.max(y1, t.y + t.h);
      }
    });
    const sx = g.x0, sy = g.y0;
    return (x, y) => {
      const dx = x - sx, dy = y - sy;
      const at = (k) => {
        const t = model.tables[k];
        return groupAt[k] === i ? { x: t.x + dx, y: t.y + dy, w: t.w, h: t.h } : t;
      };
      let { length, bends, crossings } = fixed;
      const segs = [];
      for (const l of own) {
        const A = at(l.a), B = at(l.b);
        const seg = linkSegment(A, B);
        length += segmentLength(seg) * l.w;
        if (!sharesAxis(A, B)) bends += l.w;
        for (const r of restSegs) if (segsCross(seg, r)) crossings++;
        for (const o of segs) if (segsCross(seg, o)) crossings++;
        segs.push(seg);
      }
      const left = Math.min(x0, gx0 + dx), top = Math.min(y0, gy0 + dy);
      const right = Math.max(x1, gx1 + dx), bottom = Math.max(y1, gy1 + dy);
      const width = right > left ? right - left : 0, height = bottom > top ? bottom - top : 0;
      return { length, bends, crossings, width, height };
    };
  };

  // Dagre ranks for readability, not for compactness: it happily leaves a group
  // half a canvas from the one it talks to. Pull each box back towards its
  // neighbours while the gutters hold, which is what keeps the lines short.
  //
  // With `drift`, once the layout is settled, a box moves instead wherever that
  // takes it nearer the middle of the canvas without making the lines worse, the
  // canvas bigger or its shape further from the one asked for: a group with no
  // line out, or whose lines come out the same, closes the holes the grid leaves
  // around a small group beside big ones. The score cannot see that, since Auto
  // pulls the canvas to exactly 1.6:1 and frees no room for it. Drifting while
  // the layout is still being picked steers the pick: on 271 tables in 24 groups
  // that took a canvas 18% bigger.
  const compactGroups = ({ drift = false } = {}) => {
    const steps = drift ? [40, 80, 160, 320, 640, 1280] : [40, 80, 160, 320];
    for (let round = 0; round < 4; round++) {
      let moved = false;
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        applyInner();
        const measureAt = measureMoving(i);
        const costOf = (m) => layoutScore(m, objective, true);
        let best = measureAt(g.x0, g.y0);
        let bestCost = costOf(best);
        let bx = g.x0, by = g.y0;
        const mx = (Math.min(...groups.map(h => h.x0)) + Math.max(...groups.map(h => h.x0 + h.w))) / 2;
        const my = (Math.min(...groups.map(h => h.y0)) + Math.max(...groups.map(h => h.y0 + h.h))) / 2;
        const off = (x, y) => Math.abs(x + g.w / 2 - mx) + Math.abs(y + g.h / 2 - my);
        const shapeOf = (m) => shapeCharge(m.width / m.height, objective.shape, true).factor;
        for (const step of steps) {
          for (const [dx, dy] of [[-step, 0], [step, 0], [0, -step], [0, step]]) {
            const nx = bx + dx, ny = by + dy;
            if (collides(i, nx, ny)) continue;
            const m = measureAt(nx, ny);
            const cost = costOf(m);
            const drifts = drift && off(nx, ny) < off(bx, by)
              && linkCost(m, goal) <= linkCost(best, goal) + 1e-6
              && m.width * m.height <= best.width * best.height
              && shapeOf(m) <= shapeOf(best) + 1e-9;
            if (drift ? drifts : cost < bestCost - 0.5) {
              best = m;
              bestCost = cost;
              bx = nx;
              by = ny;
            }
          }
        }
        if (bx !== g.x0 || by !== g.y0) { g.x0 = bx; g.y0 = by; moved = true; }
        applyInner();
      }
      if (!moved) break;
    }
  };

  const evaluate = () => {
    placeGroups();
    applyInner();
    compactGroups();
    applyInner();
    return globalCost();
  };

  let best = Infinity;
  for (let cols = 1; cols <= groups.length; cols++) {
    const was = groupCols;
    groupCols = cols;
    const cost = evaluate();
    if (cost < best - 0.5) best = cost;
    else groupCols = was;
  }

  for (let round = 0; round < GL_POLISH_ROUNDS; round++) {
    let improved = false;

    // Turn a group around so its tables face the groups they connect to.
    for (const g of groups) {
      const wasX = g.flipX, wasY = g.flipY;
      let bestX = wasX, bestY = wasY;
      for (const fx of [false, true]) {
        for (const fy of [false, true]) {
          if (fx === wasX && fy === wasY) continue;
          g.flipX = fx; g.flipY = fy;
          const cost = evaluate();
          if (cost < best - 0.5) { best = cost; bestX = fx; bestY = fy; improved = true; }
        }
      }
      g.flipX = bestX; g.flipY = bestY;
    }

    // Re-wrap: a different column count can pay for itself once the groups
    // have been mirrored into their final orientations.
    for (let cols = 1; cols <= groups.length; cols++) {
      if (cols === groupCols) continue;
      const was = groupCols;
      groupCols = cols;
      const cost = evaluate();
      if (cost < best - 0.5) { best = cost; improved = true; }
      else groupCols = was;
    }

    // Swap two groups within the wrapped order.
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const saved = groupOrder.slice();
        [groupOrder[i], groupOrder[j]] = [groupOrder[j], groupOrder[i]];
        const cost = evaluate();
        if (cost < best - 0.5) { best = cost; improved = true; }
        else groupOrder = saved;
      }
    }

    if (!improved) break;
  }
  evaluate();
  compactGroups({ drift: true });
  applyInner();

  // --- 4. Ungrouped tables hang loose beside their strongest group.
  // A function, not a straight-line block: turning the diagram moves every group
  // box, so the loose tables have to be re-parked afterwards.
  const placeLoose = () => {
    const placed = groups.map(g => ({ x: g.x0, y: g.y0, w: g.w, h: g.h }));
    const looseBoxes = [];
    for (const t of loose) {
      const k = t.key.toLowerCase();
      const pull = new Map();
      for (const l of links) {
        const other = l.a === k ? l.b : (l.b === k ? l.a : null);
        if (!other) continue;
        const gi = groupOf.get(other);
        if (gi !== undefined) pull.set(gi, (pull.get(gi) || 0) + l.w);
      }
      let host = -1, bestW = 0;
      for (const [gi, w] of pull) if (w > bestW) { bestW = w; host = gi; }
      const anchor = host >= 0 ? groups[host] : groups[0];

      const slots = [];
      for (let ring = 0; ring < 8; ring++) {
        const dy = ring * (t.h + LOOSE_GAP);
        const dx = ring * (t.w + LOOSE_GAP);
        slots.push({ x: anchor.x0 + anchor.w + LOOSE_GAP, y: anchor.y0 + dy });
        slots.push({ x: anchor.x0 - t.w - LOOSE_GAP, y: anchor.y0 + dy });
        slots.push({ x: anchor.x0 + dx, y: anchor.y0 + anchor.h + LOOSE_GAP });
        slots.push({ x: anchor.x0 + dx, y: anchor.y0 - t.h - LOOSE_GAP });
      }
      const clashes = (box) => (o) =>
        Math.min(box.x + box.w, o.x + o.w) - Math.max(box.x, o.x) > -LOOSE_GAP / 2 &&
        Math.min(box.y + box.h, o.y + o.h) - Math.max(box.y, o.y) > -LOOSE_GAP / 2;
      const free = slots.find(s => {
        const box = { x: s.x, y: s.y, w: t.w, h: t.h };
        return !placed.some(clashes(box)) && !looseBoxes.some(clashes(box));
      }) || slots[0];

      t.x = Math.round(free.x);
      t.y = Math.round(free.y);
      looseBoxes.push({ x: t.x, y: t.y, w: t.w, h: t.h });
    }
  };
  placeLoose();
  // --- Group boxes, measured from the tables actually inside them.
  const notes = (diagram.annotations || []).filter(a => a.type !== 'group');
  const boxes = groups.slice().sort((a, b) => a.rank - b.rank).map((g) => ({
    id: g.id || `group_gl_${g.rank}_${Date.now().toString(36)}`,
    type: 'group',
    text: g.name,
    color: g.color || 'blue',
    tables: g.listed,
    ...fitGroupBox(g.tables, { padX: PAD_X, padTop: PAD_TOP, padBottom: PAD_BOTTOM }),
  }));
  diagram.setAnnotations([...notes, ...boxes]);

  diagram.markDirty();
  diagram.onLayoutChange?.();

  return {
    groups: groups.length,
    implicit: false,
    tables: model.tables.length,
    loose: loose.length,
    annotations: boxes,
    cost: Math.round(best),
  };
}

/** The placed tables and their links, as indices into that list. */
function placedLinks(diagram) {
  const tables = (diagram.model?.tables || []).filter(t => Number.isFinite(t.x) && Number.isFinite(t.y));
  const idx = new Map(tables.map((t, i) => [t.key.toLowerCase(), i]));
  const links = [];
  for (const l of buildLinks(diagram)) {
    const a = idx.get(l.a), b = idx.get(l.b);
    if (a !== undefined && b !== undefined) links.push({ a, b, w: l.w });
  }
  return { tables, links };
}

/**
 * How good an arrangement is for `objective` by the estimate this layout
 * optimises, lower being better, taken from where every table stands now, loose
 * ones included. That makes the result of one starting point comparable with
 * another's, and with a layout the user has touched since.
 */
export function scoreCompactLayout(diagram, objective = {}) {
  const { tables, links } = placedLinks(diagram);
  if (!tables.length) return 0;
  const grouped = collectGroupsCompact(diagram.model, diagram.annotations).groups.length > 0;
  return layoutScore(measureLayout(tables, links), objective, grouped);
}

/**
 * What a person can read off an arrangement, by the same estimate: the length of
 * every line centre to centre, the bends, how many lines cross, and the canvas size.
 */
export function compactLayoutMetrics(diagram) {
  const { tables, links } = placedLinks(diagram);
  const m = measureLayout(tables, links);
  return {
    length: Math.round(m.length),
    bends: m.bends,
    crossings: m.crossings,
    width: Math.round(m.width),
    height: Math.round(m.height),
  };
}
