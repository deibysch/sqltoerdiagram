// "Lineas cortas y compacto" — group layout, the current pick of four.
//
// One of four independent group-layout algorithms the user keeps side by side.
// Unlike its two frozen siblings (group-layout-axis.js, group-layout-crossings.js)
// this is the one that stays under development, so improvements land here.
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
//      Dagre minimises crossings far better than any grid enumeration.
//   2. Dagre also runs over the quotient graph — each group a single node the
//      size of its box — but ONLY to decide which groups belong next to which.
//      It must not decide the overall shape: on a chain of eight groups it
//      returns a strip nearly three screens wide, and a canvas you can only
//      read by panning sideways is worse than a few extra crossings. So its
//      ordering is wrapped into a grid whose column count is searched over.
//   3. A polish pass mirrors individual groups, re-wraps the column count and
//      swaps groups, scored on every relation across the whole canvas — the
//      only level that sees a line running from deep inside one group to deep
//      inside another. Then the boxes are pulled together while the gutters hold.
//   4. Ungrouped tables are dropped loose beside the group they talk to most.
//
// With no groups at all, the whole diagram is laid out as one invisible group
// (no box drawn). Steps 2 and 3 then have a single node to work with, so the
// result is plain dagre over every table: identical to "Minimos Cruces", and a
// strip rather than a compact canvas (measured on generated schemas without
// groups: 862x4365 at 35 tables, 14716x2244 at 150).
//
// Measured on a 35-table / 8-group / 59-relation schema, against filling the
// groups by list order: crossings 84 -> 69, total line length 76098 -> 44748px,
// longest single line 4247 -> 2843px, canvas 11.41M -> 8.24M px2, and the share
// of the canvas that is actually table 21.8% -> 30.2%.
//
// Letting dagre pick the shape instead scored better on crossings (44) but blew
// the canvas out to 5686x1997 — the version that reads best is this one.
//
// The score is a cheap geometric estimate, never the real router: the user
// inspects the arrangement and then applies "Ruta Optima" themselves.

import dagre from '@dagrejs/dagre';
import { measureTable } from './renderer.js';

const GL_CROSS_COST = 200;   // estimated px charged per crossing between two connections
const GL_BEND_COST = 40;     // ... per bend, i.e. per connection whose boxes share no axis
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
// pan sideways forever. Charge for straying from a screen-shaped canvas.
const GL_ASPECT_TARGET = 1.6;
const GL_ASPECT_COST = 9000;
const GL_INNER = { nodesep: 40, ranksep: 70, edgesep: 20 };
const GL_OUTER = { nodesep: GL_GUTTER, ranksep: GL_GUTTER, edgesep: 40 };

/** Do the two boxes share any vertical or horizontal overlap? */
function sharesAxis(a, b) {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 8
      || Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 8;
}

function centreOf(b) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/** Do two centre-to-centre segments properly cross? */
function segmentsCross(a1, a2, b1, b2) {
  const side = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const d1 = side(a1, a2, b1), d2 = side(a1, a2, b2);
  const d3 = side(b1, b2, a1), d4 = side(b1, b2, a2);
  return d1 !== d2 && d3 !== d4 && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0;
}

/**
 * Cheap quality estimate: Manhattan length centre to centre, a bend whenever
 * two boxes share no axis, and a charge per pair of connections that cross.
 */
function estimateCost(boxes, links) {
  let cost = 0;
  const segs = [];
  for (const l of links) {
    const A = boxes[l.a], B = boxes[l.b];
    if (!A || !B) continue;
    const ca = centreOf(A), cb = centreOf(B);
    cost += (Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y)) * l.w;
    if (!sharesAxis(A, B)) cost += GL_BEND_COST * l.w;
    segs.push([ca, cb]);
  }
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      if (segmentsCross(segs[i][0], segs[i][1], segs[j][0], segs[j][1])) cost += GL_CROSS_COST;
    }
  }
  return cost;
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
 * Re-arrange the existing groups and the tables inside them so the connections
 * route short, straight and untangled. Clears every stored waypoint and anchor
 * first, so the lines start from a clean slate.
 * Returns { groups, tables, loose, annotations, cost }.
 */
export function arrangeGroupsCompact(diagram, opts = {}) {
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
  if (!model?.tables?.length) throw new Error('No hay tablas en el diagrama para organizar.');

  const level = diagram.diagramLevel || 'physical';
  for (const t of model.tables) {
    const dims = measureTable(t, level);
    t.w = dims.w; t.h = dims.h; t.rowH = dims.rowH; t.headerH = dims.headerH;
  }

  let { groups, loose } = collectGroupsCompact(model, diagram.annotations);
  // No groups at all: the whole diagram becomes one invisible group, so the same
  // machinery still lays it out. It never gets a box, and nothing is left loose.
  const implicit = !groups.length;
  if (implicit) {
    groups = [{ keys: model.tables.map(t => t.key.toLowerCase()), tables: model.tables.slice(), implicit }];
    loose = [];
  }

  diagram.onHistorySnapshot?.(diagram.getSnapshot());

  // Wipe every vertex and anchor: the lines must be re-derived from scratch.
  diagram.edgeWaypoints.clear();
  diagram.edgeAnchors.clear();

  const links = buildLinks(diagram);
  const groupOf = new Map();
  groups.forEach((g, i) => g.keys.forEach(k => groupOf.set(k, i)));

  // --- 1. Inside each group: dagre, in whichever direction reads tighter.
  for (const g of groups) {
    const idxOf = new Map(g.keys.map((k, i) => [k, i]));
    const inner = [];
    for (const l of links) {
      const a = idxOf.get(l.a), b = idxOf.get(l.b);
      if (a !== undefined && b !== undefined) inner.push({ a, b, w: l.w });
    }
    let best = null;
    for (const dir of ['LR', 'TB']) {
      const sol = dagreArrange(g.tables, inner, dir, INNER);
      const cost = estimateCost(sol.boxes, inner)
        + Math.max(sol.w, sol.h) / Math.max(1, Math.min(sol.w, sol.h)) * 40;  // prefer squarish
      if (!best || cost < best.cost) best = { ...sol, dir, cost };
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
      const cost = estimateCost(sol.boxes, groupLinks);
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
  const aspectTarget = GL_ASPECT_TARGET;
  const globalCost = () => {
    let cost = estimateCost(model.tables, globalLinks);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of model.tables) {
      if (!Number.isFinite(t.x)) continue;
      x0 = Math.min(x0, t.x); y0 = Math.min(y0, t.y);
      x1 = Math.max(x1, t.x + t.w); y1 = Math.max(y1, t.y + t.h);
    }
    const w = x1 - x0, h = y1 - y0;
    if (w > 0 && h > 0) {
      const ratio = w / h;
      const off = ratio > aspectTarget ? ratio / aspectTarget : aspectTarget / ratio;
      cost += (off - 1) * GL_ASPECT_COST;
    }
    return cost;
  };

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

  // Dagre ranks for readability, not for compactness: it happily leaves a group
  // half a canvas from the one it talks to. Pull each box back towards its
  // neighbours while the gutters hold, which is what keeps the lines short.
  const compactGroups = () => {
    const steps = [40, 80, 160, 320];
    for (let round = 0; round < 4; round++) {
      let moved = false;
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        applyInner();
        let bestCost = globalCost();
        let bx = g.x0, by = g.y0;
        for (const step of steps) {
          for (const [dx, dy] of [[-step, 0], [step, 0], [0, -step], [0, step]]) {
            const nx = bx + dx, ny = by + dy;
            const sx = g.x0, sy = g.y0;
            g.x0 = nx; g.y0 = ny;
            if (collides(i, nx, ny)) { g.x0 = sx; g.y0 = sy; continue; }
            applyInner();
            const cost = globalCost();
            if (cost < bestCost - 0.5) { bestCost = cost; bx = nx; by = ny; }
            g.x0 = sx; g.y0 = sy;
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
  const boxes = groups.filter(g => !g.implicit).map((g, i) => {
    const x0 = Math.min(...g.tables.map(t => t.x));
    const y0 = Math.min(...g.tables.map(t => t.y));
    const x1 = Math.max(...g.tables.map(t => t.x + t.w));
    const y1 = Math.max(...g.tables.map(t => t.y + t.h));
    return {
      id: g.id || `group_gl_${i}_${Date.now().toString(36)}`,
      type: 'group',
      text: g.name,
      color: g.color || 'blue',
      tables: g.keys,
      x: Math.round(x0 - PAD_X),
      y: Math.round(y0 - PAD_TOP),
      w: Math.round(x1 - x0 + PAD_X * 2),
      h: Math.round(y1 - y0 + PAD_TOP + PAD_BOTTOM),
    };
  });
  diagram.setAnnotations([...notes, ...boxes]);

  diagram.markDirty();
  diagram.onLayoutChange?.();

  return {
    groups: implicit ? 0 : groups.length,
    implicit,
    tables: model.tables.length,
    loose: loose.length,
    annotations: boxes,
    cost: Math.round(best),
  };
}
