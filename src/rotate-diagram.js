// Direction as a quarter turn of the whole canvas.
//
// "Vertical" is not a separate layout: it is the horizontal one turned 90
// degrees clockwise, the way the user turns a diagram by hand — the whole canvas
// turns, then every table turns back on its own axis so its text stays upright,
// and the group boxes simply re-fit around their tables.
//
// Three things make that harder than a pure rotation, and each has its own step:
//
// 1. Tables are wider than tall. Dagre stacks tables in columns spaced by their
//    height; turned, a column becomes a row spaced by that same height, and the
//    wide tables collide (measured: up to 78px of overlap on a 35-table schema).
//    So after the turn, anything too close is spaced out — only where needed,
//    only along the direction the two tables are arranged in, keeping the order,
//    first inside each group and then between whole groups, which move as one.
// 2. Lines are drawn against real table faces. A line's ends are re-seated on the
//    face the turn points them at, and a line that no longer clears the tables,
//    or now runs on top of another line, is re-routed — alone, with every other
//    line held fixed, in the router's quick mode.
// 3. The spacing-out is not reversible geometry. So the state before each turn
//    is remembered: turning back with nothing touched in between restores it
//    exactly, lines included, instead of computing an approximate inverse.

import { getTableAnchor, buildOrthogonalPoints, segmentIntersectsBox } from './routing.js';
import { computeGroupBounds } from './annotations.js';
import { organizeLinesShortestPath } from './line-organizer.js';

const TABLE_GAP = 16;       // two tables closer than this after a turn get spaced out
const GROUP_GAP = 40;       // ... two group boxes, or a group box and a loose table
const GROUP_PAD = { x: 28, top: 38, bottom: 24 };   // computeGroupBounds' default padding
const CLEARANCE = 15.5;     // the 16px clearance the line router guarantees
const MIN_STUB = 8;         // a line must leave its table by at least this much
const LINE_SEPARATION = 12; // the router's minimum gap between parallel lines
const LINE_MIN_SPAN = 8;    // ... unless they only brush past each other

// Which face a line docks on after the turn. Clockwise sends right to down.
const SIDE_CW = { right: 'bottom', bottom: 'left', left: 'top', top: 'right' };
const SIDE_CCW = { bottom: 'right', left: 'bottom', top: 'left', right: 'top' };

const centreOf = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
// Turned lines land on whole pixels, like everything the router produces, so
// when they are held fixed their reservations sit on exactly their own track.
const snap = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });

/**
 * The single transform every element goes through: rotate about the centroid of
 * the table centres, then translate so the tables' bounding box keeps its
 * top-left corner. The centroid does not move under the turn, so as long as
 * nothing had to be spaced out, clockwise and counter-clockwise are inverses.
 */
function quarterTurn(tables, clockwise) {
  if (!tables.length) return null;
  let cx = 0, cy = 0;
  for (const t of tables) { cx += t.x + t.w / 2; cy += t.y + t.h / 2; }
  cx /= tables.length;
  cy /= tables.length;

  // Screen coordinates: y grows downwards.
  const turn = (p) => {
    const dx = p.x - cx, dy = p.y - cy;
    return clockwise ? { x: cx - dy, y: cy + dx } : { x: cx + dy, y: cy - dx };
  };

  const x0 = Math.min(...tables.map(t => t.x));
  const y0 = Math.min(...tables.map(t => t.y));
  let nx = Infinity, ny = Infinity;
  for (const t of tables) {
    const c = turn(centreOf(t));
    nx = Math.min(nx, c.x - t.w / 2);
    ny = Math.min(ny, c.y - t.h / 2);
  }
  const sx = x0 - nx, sy = y0 - ny;
  return (p) => { const q = turn(p); return { x: q.x + sx, y: q.y + sy }; };
}

/**
 * Space out boxes left closer than `gap`, keeping their order. Two boxes side by
 * side are pushed apart horizontally, two stacked ones vertically — never the
 * other way — and only the later box moves (rightwards or downwards), so a row
 * stays a row and a column stays a column. Returns how many pushes it took.
 */
function respace(boxes, gap) {
  let moved = 0;
  for (let round = 0; round < 12; round++) {
    let changed = false;
    for (const horizontal of [true, false]) {
      const key = (b) => (horizontal ? b.x + b.w / 2 : b.y + b.h / 2);
      const order = boxes.slice().sort((a, b) => key(a) - key(b));
      for (let i = 1; i < order.length; i++) {
        const b = order[i];
        let need = -Infinity;
        for (let j = 0; j < i; j++) {
          const a = order[j];
          // Only boxes sharing a band across the push can collide at all.
          const across = horizontal
            ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
            : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
          if (across <= -gap) continue;
          const dx = Math.abs((b.x + b.w / 2) - (a.x + a.w / 2));
          const dy = Math.abs((b.y + b.h / 2) - (a.y + a.h / 2));
          if (horizontal ? dx < dy : dy <= dx) continue;   // arranged the other way
          need = Math.max(need, horizontal ? a.x + a.w + gap : a.y + a.h + gap);
        }
        if ((horizontal ? b.x : b.y) < need - 0.01) {
          if (horizontal) b.x = need; else b.y = need;
          changed = true;
          moved++;
        }
      }
    }
    if (!changed) break;
  }
  return moved;
}

/**
 * Space out a turned diagram without breaking its groups apart: first the tables
 * inside each group, then the groups themselves (and any loose table), each
 * group moving as a single block so it stays in one piece.
 */
function spaceOut(annotations, tables, isHidden) {
  const byKey = new Map(tables.map(t => [t.key.toLowerCase(), t]));
  const owner = new Set();
  const groups = [];
  for (const a of annotations || []) {
    if (a.type !== 'group' || !Array.isArray(a.tables) || !a.tables.length) continue;
    const members = [];
    for (const k of a.tables) {
      const key = String(k).toLowerCase();
      const t = byKey.get(key);
      if (!t || owner.has(key) || isHidden(t)) continue;
      owner.add(key);
      members.push(t);
    }
    if (members.length) groups.push(members);
  }

  let moved = 0;
  for (const members of groups) moved += respace(members, TABLE_GAP);

  const blocks = groups.map(members => {
    const x0 = Math.min(...members.map(t => t.x)) - GROUP_PAD.x;
    const y0 = Math.min(...members.map(t => t.y)) - GROUP_PAD.top;
    const x1 = Math.max(...members.map(t => t.x + t.w)) + GROUP_PAD.x;
    const y1 = Math.max(...members.map(t => t.y + t.h)) + GROUP_PAD.bottom;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, members };
  });
  for (const t of tables) {
    if (!isHidden(t) && !owner.has(t.key.toLowerCase())) blocks.push({ x: t.x, y: t.y, w: t.w, h: t.h, members: [t] });
  }
  const start = blocks.map(b => ({ x: b.x, y: b.y }));
  moved += respace(blocks, GROUP_GAP);
  blocks.forEach((b, i) => {
    const dx = b.x - start[i].x, dy = b.y - start[i].y;
    if (!dx && !dy) return;
    for (const t of b.members) { t.x += dx; t.y += dy; }
  });
  return moved;
}

/**
 * Turn a set of tables a quarter, keeping each one upright, and space out any
 * that collide. Used by the layout algorithms, which always lay out
 * horizontally and turn for "Vertical".
 */
export function rotateTables(tables, clockwise = true) {
  const live = tables.filter(t => Number.isFinite(t.x) && Number.isFinite(t.y));
  const turn = quarterTurn(live, clockwise);
  if (!turn) return 0;
  for (const t of live) {
    const c = turn(centreOf(t));
    t.x = c.x - t.w / 2;
    t.y = c.y - t.h / 2;
  }
  const moved = respace(live, TABLE_GAP);
  for (const t of live) { t.x = Math.round(t.x); t.y = Math.round(t.y); }
  return moved;
}

/** Every relation and manual link, keyed the way edgeAnchors / edgeWaypoints are. */
function indexEdges(diagram, byKey) {
  const out = new Map();
  const add = (fk, fc, tk, tc) => {
    const from = byKey.get(fk), to = byKey.get(tk);
    if (!from || !to) return;
    const key = `${fk}.${(fc || '').toLowerCase()}->${tk}.${(tc || '').toLowerCase()}`;
    out.set(key, { from, to, fc, tc });
  };
  for (const r of (diagram.model?.relations || [])) {
    add((r.fromTable || '').toLowerCase(), r.fromCols?.[0], (r.toTable || '').toLowerCase(), r.toCols?.[0]);
  }
  for (const l of (diagram.manualLinks || [])) {
    add((l.from?.table || '').toLowerCase(), l.from?.col, (l.to?.table || '').toLowerCase(), l.to?.col);
  }
  return out;
}

function isOrthogonal(diagram, key) {
  const style = diagram.edgeRoutings?.get(key) || diagram.edgeRouting;
  return style === 'ortho-sharp' || style === 'ortho-rounded';
}

/**
 * The drawn shape of a turned line, or null if it no longer draws the way it
 * did: an extra jog forced by the turn, an end that does not leave its table
 * properly, or less than 16px from a table it does not connect.
 */
function cleanShape(line, anchors, waypoints, obstacles, level) {
  const { from, to, fc, tc } = line.e;
  const p1 = getTableAnchor(from, fc, null, anchors.fromAnchor, 0, level);
  const p2 = getTableAnchor(to, tc, null, anchors.toAnchor, 0, level);
  const pts = buildOrthogonalPoints(p1, p2, waypoints.map(p => ({ ...p })), [], 0);
  if (line.points && pts.length > line.points) return null;

  const last = pts.length - 2;
  for (let i = 0; i <= last; i++) {
    const a = pts[i], b = pts[i + 1];
    if (last > 0 && (i === 0 || i === last) && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) < MIN_STUB) return null;
    for (const t of obstacles) {
      const own = t === from || t === to;
      if (segmentIntersectsBox(a, b, t, own ? -1 : CLEARANCE).hit) return null;
    }
  }
  return pts;
}

/** Do two drawn lines run on top of, or too close beside, each other? */
function crowds(a, b) {
  for (let i = 0; i < a.length - 1; i++) {
    const a1 = a[i], a2 = a[i + 1];
    const aH = Math.abs(a1.y - a2.y) < 0.6;
    for (let j = 0; j < b.length - 1; j++) {
      const b1 = b[j], b2 = b[j + 1];
      const bH = Math.abs(b1.y - b2.y) < 0.6;
      if (aH !== bH) continue;
      const gap = aH ? Math.abs(a1.y - b1.y) : Math.abs(a1.x - b1.x);
      if (gap >= LINE_SEPARATION - 0.5) continue;
      const lo = aH ? Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x)) : Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y));
      const hi = aH ? Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x)) : Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y));
      // 1-3px apart reads as the same line, so even a short shared run counts.
      if (hi - lo > (gap <= 3 ? 1 : LINE_MIN_SPAN)) return true;
    }
  }
  return false;
}

// --- Memory of the state before a turn, for an exact way back ---------------

function fingerprint(diagram) {
  const r = (v) => Math.round(v * 100) / 100;
  const byKey = (m) => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.stringify([
    diagram.model.tables.map(t => [t.key, r(t.x), r(t.y)]),
    byKey(diagram.edgeAnchors),
    byKey(diagram.edgeWaypoints).map(([k, pts]) => [k, pts.map(p => [r(p.x), r(p.y)])]),
    (diagram.annotations || []).map(a => [a.id, r(a.x), r(a.y), r(a.w), r(a.h)]),
  ]);
}

function capture(diagram) {
  return {
    tables: new Map(diagram.model.tables.map(t => [t.key, { x: t.x, y: t.y }])),
    annotations: new Map((diagram.annotations || []).filter(a => a.id).map(a => [a.id, { x: a.x, y: a.y, w: a.w, h: a.h }])),
    anchors: [...diagram.edgeAnchors.entries()].map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]),
    waypoints: [...diagram.edgeWaypoints.entries()].map(([k, pts]) => [k, pts.map(p => ({ x: p.x, y: p.y }))]),
  };
}

function restore(diagram, saved) {
  for (const t of diagram.model.tables) {
    const p = saved.tables.get(t.key);
    if (p) { t.x = p.x; t.y = p.y; }
  }
  for (const a of diagram.annotations || []) {
    const b = a.id && saved.annotations.get(a.id);
    if (b) Object.assign(a, b);
  }
  diagram.edgeAnchors = new Map(saved.anchors.map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  diagram.edgeWaypoints = new Map(saved.waypoints.map(([k, pts]) => [k, pts.map(p => ({ x: p.x, y: p.y }))]));
}

/**
 * Turn the whole diagram a quarter: tables (kept upright), notes, group boxes
 * and routed lines. Clockwise goes from "Horizontal" to "Vertical".
 * Returns { tables, lines, repaired, nudged, restored }.
 */
export function rotateDiagram(diagram, clockwise = true, { recordHistory = true } = {}) {
  const model = diagram?.model;
  const tables = (model?.tables || []).filter(t => Number.isFinite(t.x) && Number.isFinite(t.y));
  if (!tables.length) return { tables: 0, lines: 0, repaired: 0, nudged: 0, restored: false };
  if (recordHistory) diagram.onHistorySnapshot?.(diagram.getSnapshot());

  // Turning straight back, with nothing touched since the last turn: the exact
  // inverse is simply the state that turn started from.
  const memory = diagram._turnMemory;
  if (memory && memory.clockwise !== clockwise && memory.after === fingerprint(diagram)) {
    restore(diagram, memory.before);
    diagram._turnMemory = null;
    diagram.orientation = clockwise ? 'TB' : 'LR';
    diagram.fitAllGroups?.();
    diagram.markDirty?.();
    diagram.onLayoutChange?.();
    return { tables: tables.length, lines: 0, repaired: 0, repairedKeys: [], nudged: 0, restored: true };
  }
  const before = capture(diagram);

  const level = diagram.diagramLevel || 'physical';
  const byKey = new Map(tables.map(t => [t.key.toLowerCase(), t]));
  const isHidden = (t) => !!diagram.hidden?.has(t.key.toLowerCase());

  // 1. Capture every routed line's ends while the tables are still in place.
  const lines = [];
  for (const [key, e] of indexEdges(diagram, byKey)) {
    const anchors = diagram.edgeAnchors.get(key);
    const waypoints = diagram.edgeWaypoints.get(key) || [];
    if (!anchors && !waypoints.length) continue;
    const line = { key, e, anchors, waypoints, ends: {} };
    for (const [which, table, col] of [['fromAnchor', e.from, e.fc], ['toAnchor', e.to, e.tc]]) {
      if (anchors?.[which]) line.ends[which] = getTableAnchor(table, col, null, anchors[which], 0, level);
    }
    if (line.ends.fromAnchor && line.ends.toAnchor) {
      line.points = buildOrthogonalPoints(line.ends.fromAnchor, line.ends.toAnchor,
        waypoints.map(p => ({ ...p })), [], 0).length;
    }
    lines.push(line);
  }

  // 2. Turn the tables. Only their centres move — each keeps its own width and
  //    height, which is the "turn every table back on its own axis" step — then
  //    space out whatever the turn left colliding.
  const turn = quarterTurn(tables, clockwise);
  for (const t of tables) {
    const c = turn(centreOf(t));
    t.x = c.x - t.w / 2;
    t.y = c.y - t.h / 2;
  }
  const annotations = diagram.annotations || [];
  const nudged = spaceOut(annotations, tables, isHidden);
  for (const t of tables) { t.x = Math.round(t.x); t.y = Math.round(t.y); }
  const visible = tables.filter(t => !isHidden(t));

  // 3. Notes keep their shape like tables; a group frame drawn without members
  //    is just a rectangle, so it turns with its sides swapped. Groups that list
  //    their tables are re-fitted around them at the end.
  for (const a of annotations) {
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
    if (a.type === 'group' && Array.isArray(a.tables) && a.tables.length) continue;
    const c = turn(centreOf(a));
    if (a.type === 'group') { const w = a.w; a.w = a.h; a.h = w; }
    a.x = c.x - a.w / 2;
    a.y = c.y - a.h / 2;
  }

  // 4. Lines: turn every stored vertex and re-seat both ends on the face the
  //    turn points them at, at the same position along that face.
  const sides = clockwise ? SIDE_CW : SIDE_CCW;
  const broken = [];
  const accepted = [];
  for (const line of lines) {
    const waypoints = line.waypoints.map(p => snap(turn(p)));
    if (waypoints.length) diagram.edgeWaypoints.set(line.key, waypoints);
    if (!line.anchors) continue;

    const next = {};
    for (const [which, table] of [['fromAnchor', line.e.from], ['toAnchor', line.e.to]]) {
      const cfg = line.anchors[which];
      const end = line.ends[which];
      if (!cfg || !end) continue;
      const side = sides[cfg.side] || cfg.side;
      const q = snap(turn(end));
      const along = (side === 'top' || side === 'bottom') ? (q.x - table.x) / table.w : (q.y - table.y) / table.h;
      next[which] = { side, offset: Math.max(0, Math.min(1, along)) };
    }
    diagram.edgeAnchors.set(line.key, next);

    const bothVisible = !isHidden(line.e.from) && !isHidden(line.e.to);
    if (!next.fromAnchor || !next.toAnchor || !bothVisible || !isOrthogonal(diagram, line.key)) continue;
    const pts = cleanShape(line, next, waypoints, visible, level);
    if (pts && !accepted.some(other => crowds(pts, other))) accepted.push(pts);
    else broken.push(line.key);
  }

  // 5. Re-route only what the turn broke, holding every other line in place.
  if (broken.length) {
    organizeLinesShortestPath(diagram, broken, { keepOthers: true, recordHistory: false, forceStyle: false, quick: true });
  }

  // 6. Group boxes re-fit around their turned tables.
  for (const a of annotations) {
    if (a.type !== 'group' || !Array.isArray(a.tables) || !a.tables.length) continue;
    const b = computeGroupBounds(a, model.tables);
    if (b) Object.assign(a, b);
  }
  diagram.fitAllGroups?.();

  diagram.orientation = clockwise ? 'TB' : 'LR';
  diagram._turnMemory = { clockwise, before, after: fingerprint(diagram) };
  diagram.markDirty?.();
  diagram.onLayoutChange?.();
  return { tables: tables.length, lines: lines.length, repaired: broken.length, repairedKeys: broken, nudged, restored: false };
}
