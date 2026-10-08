// Improve, the one button of the panel of "Optimize for": it looks for a better
// layout for as long as it keeps finding one (the panel stops it after a while
// without), judging every layout by the real lines. Its core is refining:
// neighbouring tables trade places wherever the real lines come out better.
//
// The layout and the search judge an arrangement by a cheap estimate, every line
// straight from centre to centre. Between two whole arrangements it ranks them
// about as Optimal Route does; between two that differ by a pair of neighbours
// trading places it is little better than a guess. Measured on 49 such swaps (35
// tables, with and without groups), it passed over 4 of the 8 that made the real
// lines better. So here a swap is judged by the real lines: Optimal Route again,
// but only for the lines of the tables that moved and for any other line that now
// runs through one of them, with every other line held where it is. That took 30
// to 100 ms against 0.2 to 3 s for the whole diagram, and it told better from
// worse exactly as routing the whole diagram did, on all 49.
//
// Refine only has to tell layouts apart, not draw their best lines, so it routes
// the cheap way: a layout is measured as the panel measures every layout, with
// quick Optimal Route (measureRealLines), and a swap routes its lines once, with
// no rip-up. On a real schema of 39 tables, 79 relations and 6 groups, judging
// swaps without rip-up halved their time for one crossing more at the end (82
// against 81), and synthetic schemas came out the same either way.
//
// A round tries every table with its nearest neighbour in each of the four
// directions, within its own group. It takes the swap that improves the most,
// tries the other improving ones again from there, and rounds go on until one
// finds nothing. Routing the whole diagram again between rounds, to undo the
// drift of lines re-routed a few at a time, bought one crossing on the real
// schema for 68 s, and nothing elsewhere, so it is not done. Measured from
// Balanced's first arrangement, on one core: 35 tables without groups, lines
// -6.6% and 4 crossings down to 3 (10 s); 35 tables in 6 groups, lines -22.7%
// (6 s); 60 tables in 10 groups, lines -12.5% and 13 crossings down to 6 (23 s);
// the real schema, lines -7.3% and 107 crossings down to 78 (135 s).
//
// Tables of different sizes trade places too. Along the row or column the two
// share, the pair keeps the span it had; whatever the bigger one now presses
// against is pushed out of its way, inside its own group, as long as no group
// box runs into another.
//
// With groups, whole groups move too, each with its tables as they stand inside
// it: two neighbouring group boxes trade places by the same rule, pushing whole
// any group they now press against (a few at most), unless a box would then run
// into a table outside it; and a group turns over, left for right or top for
// bottom, within its own bounds. Tables swapping places can only shorten the
// lines inside a group and to its edge; lines from group to group, most of them
// on a real schema, need the groups themselves to move. Balanced has placed the
// groups by the estimate already, so trading two of them nearly always makes the
// lines worse, by a lot, and costs a whole group's lines to judge; the estimate
// agrees with the real lines about which ones, so only those it does not find
// much worse are judged. It is no guide to turning a group over, which is cheap.
//
// It refines the layout on the canvas first, then explores: other starting points
// judged by the estimate, the most promising measured and refined in turn, since
// a better start often refines into a better end. That goes on until it is
// stopped. The moves of a round are independent of each other, so in a worker
// with cores to spare helpers judge them (refine-parallel.js), with the same
// result as here.

import { getDiagramEdges, organizeLinesShortestPath } from './line-organizer.js';
import { getTableAnchor, buildOrthogonalPoints, segmentIntersectsBox } from './routing.js';
import { rankScore } from './layout-goals.js';
import { collectGroupsCompact, compactLayoutMetrics, compactSpacing, fitGroupBox } from './group-layout-compact.js';
import { diagramFrom, measureRealLines, realLinesOf, compactAttempt } from './compact-search-core.js';

const MAX_ROUNDS = 8;
const MAX_PUSHED = 8;        // tables a swap may push out of its way
const MAX_PUSHED_GROUPS = 3; // groups two groups trading places may push out of theirs
const CLEAR_SHARE = 0.6;     // closer than this share of the gap between tables (gutter between groups), one is in the way
const GROUP_CLEAR = 24;      // px a group box keeps from another group box
const TABLE_CLEAR = 16;      // ... and from a table outside it
const HIT_MARGIN = 8;        // a line this close to a table that moved is routed again
// A refine has gained up to 23% from one start (35 tables in 6 groups), so a
// layout that measures further than this behind the best so far is only measured.
const REACH = 1.3;
// Two groups trading places are judged by the real lines only when the estimate
// finds the layout at most this much worse: on the schemas measured, one the
// estimate found 2.5% worse shortened the real lines, and none found worse by
// more than 5% did.
const GROUP_SWAP_SLACK = 1.05;
// Other starting points tried by the estimate for each one measured: across
// starting points the estimate ranks layouts about as the real lines do (rank
// correlation 0.83 to 0.98), so the best of a few is the one worth measuring.
const EXPLORE_BATCH = 4;

const DIRECTIONS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/** How far apart two boxes are: the wider of their gaps, negative when they overlap. */
function apart(a, b) {
  return Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
}

const signatureOf = (positions) => positions.map(p => `${p[1]},${p[2]}`).join(';');
const copyBox = (a) => ({ ...a, tables: [...(a.tables || [])] });

/**
 * What every step needs to know about the schema: the objective, the spacing,
 * the groups and which one each table belongs to ('all' without groups, 'loose'
 * outside every group), and the hidden tables, which neither move nor block.
 * `input` is compactInput().
 */
export function refineContext(input) {
  const sp = compactSpacing(input.spacing);
  const index = new Map(input.tables.map((t, i) => [t.key.toLowerCase(), i]));
  const hidden = new Set((input.hidden || []).map(k => String(k).toLowerCase()));
  const { groups } = collectGroupsCompact({ tables: input.tables, groups: input.groups }, input.annotations);
  const container = input.tables.map(() => (groups.length ? 'loose' : 'all'));
  const members = groups.map((g, gi) => g.keys.map((k) => {
    const i = index.get(k);
    container[i] = gi;
    return i;
  }));
  return {
    input,
    objective: { goal: input.goal, shape: input.shape },
    sp,
    clear: Math.round(sp.gap * CLEAR_SHARE),
    groups: groups.map((g, gi) => ({ id: g.id, name: g.name, color: g.color, keys: g.keys, members: members[gi] })),
    container,
    skip: input.tables.map(t => hidden.has(t.key.toLowerCase())),
    implicit: !groups.length,
  };
}

function boxesOf(ctx, positions) {
  return positions.map(([, x, y], i) => ({ x, y, w: ctx.input.tables[i].w, h: ctx.input.tables[i].h }));
}

/** A diagram with the tables where `state` has them and its lines. */
function stateDiagram(ctx, state) {
  const d = diagramFrom(ctx.input, state.positions);
  for (const [key, a] of state.anchors) d.edgeAnchors.set(key, { fromAnchor: { ...a.fromAnchor }, toAnchor: { ...a.toAnchor } });
  for (const [key, pts] of state.waypoints) d.edgeWaypoints.set(key, pts.map(p => ({ x: p.x, y: p.y })));
  return d;
}

/**
 * A layout to refine, as the search keeps one: { signature, positions,
 * groupBoxes, orientation }, and its `measurement` (measureRealLines) when it has
 * one. Its positions come out in the order of the tables, and its group boxes
 * one per group, in the order of the groups.
 */
function startFrom(ctx, start) {
  const at = new Map(start.positions.map(([key, x, y]) => [key, [x, y]]));
  const positions = ctx.input.tables.map((t) => {
    const p = at.get(t.key) || [t.x, t.y];
    return [t.key, p[0], p[1]];
  });
  const boxes = boxesOf(ctx, positions);
  const byId = new Map((start.groupBoxes || []).filter(b => b.id).map(b => [b.id, b]));
  const groupBoxes = ctx.groups.map((g, gi) => {
    const had = g.id && byId.get(g.id);
    if (had) return copyBox(had);
    return {
      id: g.id || `group_rf_${gi}`, type: 'group', text: g.name, color: g.color || 'blue', tables: [...g.keys],
      ...fitGroupBox(g.members.map(i => boxes[i]), ctx.sp),
    };
  });
  return { signature: signatureOf(positions), positions, groupBoxes, orientation: start.orientation || 'LR' };
}

/** The state of a layout whose lines were all routed from scratch (measureRealLines). */
function stateFrom(ctx, layout, measurement) {
  return {
    positions: layout.positions,
    groupBoxes: layout.groupBoxes,
    anchors: measurement.lines.anchors,
    waypoints: measurement.lines.waypoints,
    metrics: measurement.metrics,
    score: rankScore(measurement.metrics, ctx.objective),
  };
}

/**
 * Each box with its nearest other box in each of the four directions, among those
 * `pairable(a, b)` allows: each pair once, with the axis they share ('x' for a
 * row, 'y' for a column).
 */
function nearestPairs(boxes, pairable) {
  const c = boxes.map(b => [b.x + b.w / 2, b.y + b.h / 2]);
  const seen = new Set();
  const pairs = [];
  for (let a = 0; a < boxes.length; a++) {
    for (const [dx, dy] of DIRECTIONS) {
      let best = -1, bestD = Infinity;
      for (let b = 0; b < boxes.length; b++) {
        if (b === a || !pairable(a, b)) continue;
        const along = (c[b][0] - c[a][0]) * dx + (c[b][1] - c[a][1]) * dy;
        const across = Math.abs((c[b][0] - c[a][0]) * dy - (c[b][1] - c[a][1]) * dx);
        if (along <= 0 || across > along) continue;
        if (along + across < bestD) { bestD = along + across; best = b; }
      }
      if (best < 0) continue;
      const lo = Math.min(a, best), hi = Math.max(a, best);
      if (seen.has(`${lo}|${hi}`)) continue;
      seen.add(`${lo}|${hi}`);
      pairs.push({ a: lo, b: hi, axis: dx ? 'x' : 'y' });
    }
  }
  return pairs.sort((p, q) => p.a - q.a || p.b - q.b);
}

/**
 * Each table with its nearest neighbour in each of the four directions, in the
 * same group: the pairs of tables a round tries to swap.
 */
export function neighbourPairs(ctx, positions) {
  const pairable = (a, b) => !ctx.skip[a] && !ctx.skip[b] && ctx.container[a] === ctx.container[b];
  return nearestPairs(boxesOf(ctx, positions), pairable);
}

/**
 * Everything a round tries: every table with its neighbours (neighbourPairs),
 * and with groups, every group box with its neighbours ({ kind: 'groups' }) and
 * every group of two tables or more turned over either way ({ kind: 'flip' }).
 */
export function candidateMoves(ctx, state) {
  const moves = neighbourPairs(ctx, state.positions);
  if (ctx.implicit) return moves;
  for (const pair of nearestPairs(state.groupBoxes, () => true)) moves.push({ kind: 'groups', ...pair });
  ctx.groups.forEach((g, gi) => {
    if (g.members.length > 1) for (const axis of ['x', 'y']) moves.push({ kind: 'flip', g: gi, axis });
  });
  return moves;
}

// the estimate of each state, for promising()
const estimates = new WeakMap();

/**
 * Whether a move is worth judging by the real lines: always, but for two groups
 * trading places, which the estimate must not find much worse (GROUP_SWAP_SLACK).
 */
function promising(ctx, state, move) {
  if (move.pair.kind !== 'groups') return true;
  const estimate = (positions) => rankScore(compactLayoutMetrics(diagramFrom(ctx.input, positions)), ctx.objective);
  if (!estimates.has(state)) estimates.set(state, estimate(state.positions));
  const positions = state.positions.map(p => p.slice());
  for (const [i, x, y] of move.tables) positions[i] = [positions[i][0], x, y];
  return estimate(positions) <= estimates.get(state) * GROUP_SWAP_SLACK + 0.5;
}

/** The move a candidate (candidateMoves) makes from `state`, or null when there is no room for it. */
export function placeMove(ctx, state, candidate) {
  if (candidate.kind === 'groups') return placeGroupSwap(ctx, state, candidate);
  if (candidate.kind === 'flip') return placeFlip(ctx, state, candidate);
  return placeSwap(ctx, state, candidate);
}

/**
 * Make room for the tables in `moved`: every table of the same group that one of
 * them now comes closer to than it stood before, and closer than `ctx.clear`, is
 * pushed away along whichever axis takes the shorter push, back to the gap it
 * had (the layout's gap at most). What it pushes makes room in turn. `slot[i]`
 * is the table that stood where table i stands now. Returns the tables that
 * moved, or null when too many had to.
 */
function makeRoom(ctx, boxes, base, slot, moved) {
  const queue = [...moved];
  const touched = new Set(moved);
  let pushes = 0;
  while (queue.length) {
    const p = queue.shift();
    const P = boxes[p];
    for (let q = 0; q < boxes.length; q++) {
      if (q === p || ctx.skip[q] || ctx.container[q] !== ctx.container[p]) continue;
      const Q = boxes[q];
      const before = apart(base[slot[p]], base[slot[q]]);
      if (apart(P, Q) >= Math.min(ctx.clear, before) - 0.5) continue;
      const want = Math.min(ctx.sp.gap, Math.max(before, 0));
      const right = Q.x + Q.w / 2 >= P.x + P.w / 2, down = Q.y + Q.h / 2 >= P.y + P.h / 2;
      const shiftX = right ? P.x + P.w + want - Q.x : P.x - want - (Q.x + Q.w);
      const shiftY = down ? P.y + P.h + want - Q.y : P.y - want - (Q.y + Q.h);
      if (Math.abs(shiftX) <= Math.abs(shiftY)) Q.x = Math.round(Q.x + shiftX);
      else Q.y = Math.round(Q.y + shiftY);
      touched.add(q);
      queue.push(q);
      if (touched.size > moved.length + MAX_PUSHED || ++pushes > 200) return null;
    }
  }
  return touched;
}

/**
 * Do the group boxes still stand clear once `touched` moved? A group box that
 * changes keeps GROUP_CLEAR from the other boxes and TABLE_CLEAR from every table
 * outside it, and a loose table that moved keeps TABLE_CLEAR from every box,
 * unless they already stood closer. Returns the boxes of the groups that
 * changed, by group, or null.
 */
function groupsClear(ctx, state, boxes, base, slot, touched) {
  const fitted = new Map();
  if (ctx.implicit) return fitted;
  for (const i of touched) {
    const gi = ctx.container[i];
    if (gi !== 'loose' && !fitted.has(gi)) fitted.set(gi, fitGroupBox(ctx.groups[gi].members.map(k => boxes[k]), ctx.sp));
  }
  const now = (gi) => fitted.get(gi) || state.groupBoxes[gi];
  const was = (gi) => state.groupBoxes[gi];
  for (const [gi, box] of fitted) {
    for (let h = 0; h < ctx.groups.length; h++) {
      if (h !== gi && apart(box, now(h)) < Math.min(GROUP_CLEAR, apart(was(gi), was(h))) - 0.5) return null;
    }
    for (let t = 0; t < boxes.length; t++) {
      if (ctx.skip[t] || ctx.container[t] === gi) continue;
      if (apart(box, boxes[t]) < Math.min(TABLE_CLEAR, apart(was(gi), base[slot[t]])) - 0.5) return null;
    }
  }
  for (const i of touched) {
    if (ctx.container[i] !== 'loose') continue;
    for (let gi = 0; gi < ctx.groups.length; gi++) {
      if (apart(boxes[i], now(gi)) < Math.min(TABLE_CLEAR, apart(base[slot[i]], was(gi))) - 0.5) return null;
    }
  }
  return fitted;
}

/**
 * Tables a and b trade places. Along the axis they share, the pair keeps the
 * span it had: the one that came second now starts where the first did, and the
 * first ends where the second did. Across it, each is centred where the other
 * was. Returns the move, { pair, tables: [[index, x, y]] } for every table that
 * moved, pushed ones included, or null when there is no room for it.
 */
export function placeSwap(ctx, state, pair) {
  const base = boxesOf(ctx, state.positions);
  const boxes = base.map(b => ({ ...b }));
  const { a, b, axis } = pair;
  const [pos, size, cross, crossSize] = axis === 'x' ? ['x', 'w', 'y', 'h'] : ['y', 'h', 'x', 'w'];
  const [first, second] = base[a][pos] <= base[b][pos] ? [a, b] : [b, a];
  const F = base[first], S = base[second];
  boxes[second][pos] = F[pos];
  boxes[first][pos] = S[pos] + S[size] - F[size];
  boxes[second][cross] = Math.round(F[cross] + F[crossSize] / 2 - S[crossSize] / 2);
  boxes[first][cross] = Math.round(S[cross] + S[crossSize] / 2 - F[crossSize] / 2);

  const slot = boxes.map((_, i) => i);
  slot[a] = b;
  slot[b] = a;
  const touched = makeRoom(ctx, boxes, base, slot, [a, b]);
  if (!touched || !groupsClear(ctx, state, boxes, base, slot, touched)) return null;
  const tables = [...touched].sort((x, y) => x - y).map(i => [i, boxes[i].x, boxes[i].y]);
  return { pair, tables };
}

/**
 * Groups a and b trade places, each with its tables as they stand inside it.
 * Along the axis the two boxes share, the pair keeps its span, and across it
 * each is centred where the other was, as two tables do (placeSwap), and any
 * group they now press against is pushed out of their way (makeRoomForGroups).
 * Returns the move, or null when there is no room for it.
 */
function placeGroupSwap(ctx, state, pair) {
  const base = boxesOf(ctx, state.positions);
  const boxes = base.map(b => ({ ...b }));
  const { a, b, axis } = pair;
  const [pos, size, cross, crossSize] = axis === 'x' ? ['x', 'w', 'y', 'h'] : ['y', 'h', 'x', 'w'];
  const [first, second] = state.groupBoxes[a][pos] <= state.groupBoxes[b][pos] ? [a, b] : [b, a];
  const F = state.groupBoxes[first], S = state.groupBoxes[second];
  const shifts = [
    [second, F[pos] - S[pos], Math.round(F[cross] + F[crossSize] / 2 - S[crossSize] / 2) - S[cross]],
    [first, S[pos] + S[size] - F[size] - F[pos], Math.round(S[cross] + S[crossSize] / 2 - F[crossSize] / 2) - F[cross]],
  ];
  for (const [gi, along, over] of shifts) {
    for (const i of ctx.groups[gi].members) {
      boxes[i][pos] += along;
      boxes[i][cross] += over;
    }
  }
  const slotOf = ctx.groups.map((_, gi) => gi);
  slotOf[a] = b;
  slotOf[b] = a;
  const groupsMoved = makeRoomForGroups(ctx, state, boxes, slotOf, [a, b]);
  if (!groupsMoved) return null;
  const touched = [...groupsMoved].flatMap(gi => ctx.groups[gi].members);
  const slot = boxes.map((_, i) => i);
  if (!groupsClear(ctx, state, boxes, base, slot, touched)) return null;
  return { pair, tables: touched.sort((x, y) => x - y).map(i => [i, boxes[i].x, boxes[i].y]) };
}

/**
 * Make room for the groups in `moved`, whose tables already stand where they go
 * in `boxes`: every other group whose box one of them now comes closer to than
 * part of the gutter, and closer than both the two groups stood and the two
 * places they stand in stood, is pushed away whole along whichever axis takes
 * the shorter push, back to that gap (the gutter at most). What it pushes makes
 * room in turn. `slotOf[g]` is the group that stood where group g stands now.
 * Returns the groups that moved, or null when too many had to.
 */
function makeRoomForGroups(ctx, state, boxes, slotOf, moved) {
  const boxOf = (gi) => fitGroupBox(ctx.groups[gi].members.map(i => boxes[i]), ctx.sp);
  const clear = Math.round(ctx.sp.gutter * CLEAR_SHARE);
  const queue = [...moved];
  const touched = new Set(moved);
  let pushes = 0;
  while (queue.length) {
    const p = queue.shift();
    const P = boxOf(p);
    for (let q = 0; q < ctx.groups.length; q++) {
      if (q === p) continue;
      const Q = boxOf(q);
      const own = apart(state.groupBoxes[p], state.groupBoxes[q]);
      const before = Math.min(own, apart(state.groupBoxes[slotOf[p]], state.groupBoxes[slotOf[q]]));
      // never closer than groupsClear lets two groups come
      const least = Math.min(GROUP_CLEAR, own);
      if (apart(P, Q) >= Math.max(least, Math.min(clear, before)) - 0.5) continue;
      const want = Math.max(least, Math.min(ctx.sp.gutter, Math.max(before, 0)));
      const right = Q.x + Q.w / 2 >= P.x + P.w / 2, down = Q.y + Q.h / 2 >= P.y + P.h / 2;
      const shiftX = right ? P.x + P.w + want - Q.x : P.x - want - (Q.x + Q.w);
      const shiftY = down ? P.y + P.h + want - Q.y : P.y - want - (Q.y + Q.h);
      const [dx, dy] = Math.abs(shiftX) <= Math.abs(shiftY) ? [Math.round(shiftX), 0] : [0, Math.round(shiftY)];
      for (const i of ctx.groups[q].members) {
        boxes[i].x += dx;
        boxes[i].y += dy;
      }
      touched.add(q);
      queue.push(q);
      if (touched.size > moved.length + MAX_PUSHED_GROUPS || ++pushes > 50) return null;
    }
  }
  return touched;
}

/**
 * A group turned over, left for right (axis 'x') or top for bottom ('y'): each
 * table goes where its mirror image stood, within the same bounds, so the box
 * stays put. Returns the move, or null when no table moves.
 */
function placeFlip(ctx, state, flip) {
  const boxes = boxesOf(ctx, state.positions);
  const [pos, size] = flip.axis === 'x' ? ['x', 'w'] : ['y', 'h'];
  const members = ctx.groups[flip.g].members;
  const lo = Math.min(...members.map(i => boxes[i][pos]));
  const hi = Math.max(...members.map(i => boxes[i][pos] + boxes[i][size]));
  const tables = [];
  for (const i of [...members].sort((x, y) => x - y)) {
    const at = lo + hi - boxes[i][pos] - boxes[i][size];
    if (at === boxes[i][pos]) continue;
    tables.push(flip.axis === 'x' ? [i, at, boxes[i].y] : [i, boxes[i].x, at]);
  }
  return tables.length ? { pair: flip, tables } : null;
}

/** The route a line has in `d`, as the canvas draws it. */
function routeOf(d, e) {
  const a = d.edgeAnchors.get(e.key);
  const p1 = getTableAnchor(e.from, e.fc, null, a?.fromAnchor, 0, d.diagramLevel);
  const p2 = getTableAnchor(e.to, e.tc, null, a?.toAnchor, 0, d.diagramLevel);
  return buildOrthogonalPoints(p1, p2, (d.edgeWaypoints.get(e.key) || []).map(p => ({ ...p })), [], 0);
}

/** The lines a move routes again: those of the tables that moved, and any other that now runs through one. */
function linesToRoute(d, moved) {
  const set = new Set(moved);
  const keys = [];
  for (const e of getDiagramEdges(d)) {
    if (set.has(e.from) || set.has(e.to) || !d.edgeAnchors.has(e.key)) {
      keys.push(e.key);
      continue;
    }
    const pts = routeOf(d, e);
    const hits = moved.some(t => pts.some((p, k) => k > 0 && segmentIntersectsBox(pts[k - 1], p, t, HIT_MARGIN).hit));
    if (hits) keys.push(e.key);
  }
  return keys;
}

/**
 * Judge a move (placeSwap) by the real lines: route again only the lines it
 * touches, once each, the others held where `state` has them. Returns its score
 * and metrics and, for every line routed, [key, anchors, waypoints], null for none.
 */
export function evaluateMove(ctx, state, move) {
  const d = stateDiagram(ctx, state);
  const moved = move.tables.map(([i, x, y]) => {
    const t = d.model.tables[i];
    t.x = x;
    t.y = y;
    return t;
  });
  const keys = linesToRoute(d, moved);
  // no key at all would route every line
  if (keys.length) {
    organizeLinesShortestPath(d, keys, { recordHistory: false, forceStyle: false, keepOthers: true, quick: true, ripUpPasses: 0 });
  }
  const { metrics } = realLinesOf(d);
  return {
    score: rankScore(metrics, ctx.objective),
    metrics,
    lines: keys.map(key => [key, d.edgeAnchors.get(key) || null, d.edgeWaypoints.get(key) || null]),
  };
}

/** `state` once `move` is made, with the lines evaluateMove() routed for it. */
function applyMove(ctx, state, move, result) {
  const positions = state.positions.map(p => p.slice());
  for (const [i, x, y] of move.tables) positions[i] = [positions[i][0], x, y];
  const anchors = new Map(state.anchors);
  const waypoints = new Map(state.waypoints);
  for (const [key, a, pts] of result.lines) {
    if (a) anchors.set(key, a); else anchors.delete(key);
    if (pts) waypoints.set(key, pts); else waypoints.delete(key);
  }
  const groupBoxes = state.groupBoxes.slice();
  if (!ctx.implicit) {
    const boxes = boxesOf(ctx, positions);
    const changed = new Set(move.tables.map(([i]) => ctx.container[i]).filter(gi => gi !== 'loose'));
    for (const gi of changed) {
      groupBoxes[gi] = { ...copyBox(groupBoxes[gi]), ...fitGroupBox(ctx.groups[gi].members.map(k => boxes[k]), ctx.sp) };
    }
  }
  return { positions, groupBoxes, anchors: [...anchors], waypoints: [...waypoints], metrics: result.metrics, score: result.score };
}

/**
 * A state as the search panel keeps a layout: where the tables are, the group
 * boxes, the estimate's metrics and score (as every other layout has them), and
 * the measurement with the real lines (measureRealLines).
 */
function entryOf(ctx, state, orientation) {
  const d = stateDiagram(ctx, state);
  const metrics = compactLayoutMetrics(d);
  return {
    signature: signatureOf(state.positions),
    positions: state.positions,
    implicit: ctx.implicit,
    groups: ctx.groups.length,
    groupBoxes: ctx.implicit ? [] : state.groupBoxes.map(copyBox),
    metrics,
    score: rankScore(metrics, ctx.objective),
    orientation,
    measurement: realLinesOf(d),
  };
}

/**
 * Improve, step by step, for as long as it is let run (or `maxTries` tries). It
 * yields what it cannot do itself: { type: 'route' }, quick Optimal Route over a
 * whole layout, answered with measureRealLines(); and { type: 'evaluate', state,
 * moves }, answered with evaluateMove() of every move against that state, in
 * order. Everything else it yields is a report: 'measured' when a layout has
 * been measured; 'best' whenever the best layout so far changes (the first is
 * `start` itself); 'candidate' whenever a layout being refined improves without
 * becoming the best, since it may still be the one to pick; 'settled' once a
 * layout has been refined to the end, with the layout it ended on as `result`;
 * and 'progress'. 'best', 'candidate' and 'settled' carry the `chain` they come
 * from, one per layout refined: each replaces the one before it in its chain.
 *
 * It refines `start` first, then explores: EXPLORE_BATCH other starting points
 * (seeds, from `firstSeed` on) judged by the estimate, the most promising of them
 * measured and, unless it measures too far behind, refined; and again. A layout
 * marked `settled` is only measured, since refining it again finds nothing.
 */
export function* improveSteps(ctx, start, { firstSeed = 1, maxTries = Infinity, maxRounds = MAX_ROUNDS } = {}) {
  let best = null;
  let tries = 0;
  let seed = firstSeed;
  let chains = 0;
  const seen = new Set();

  function* improveFrom(layout) {
    const chain = chains++;
    const from = startFrom(ctx, layout);
    // the best so far, or else a layout still worth picking
    const report = (state) => {
      const type = !best || state.score < best.score - 0.5 ? 'best' : 'candidate';
      if (type === 'best') best = state;
      return { type, chain, result: entryOf(ctx, state, from.orientation) };
    };
    seen.add(from.signature);
    // A layout measured already keeps those lines: one Improve reached can have
    // better ones than routing it from scratch gives.
    let measurement = layout.measurement;
    if (!measurement) {
      yield { type: 'progress', phase: 'measuring', round: 0, evaluated: 0, total: 0, tries, seed };
      measurement = yield { type: 'route', positions: from.positions };
    }
    let state = stateFrom(ctx, from, measurement);
    yield { type: 'measured', signature: from.signature, measurement };
    if (best && state.score > best.score * REACH) return;
    yield report(state);
    if (layout.settled) return;

    for (let round = 0; round < maxRounds; round++) {
      let accepted = 0;
      let pairs = candidateMoves(ctx, state);
      for (;;) {
        const moves = pairs.map(p => placeMove(ctx, state, p)).filter(m => m && promising(ctx, state, m));
        if (!moves.length) break;
        const results = yield { type: 'evaluate', state, moves, round, tries, seed };
        const improving = results
          .map((r, i) => [r, i])
          .filter(([r]) => r.score < state.score - 0.5)
          .sort((x, y) => x[0].score - y[0].score || x[1] - y[1]);
        if (!improving.length) break;
        const [result, i] = improving[0];
        state = applyMove(ctx, state, moves[i], result);
        accepted++;
        yield report(state);
        // the other improving moves, placed and judged again from here
        pairs = improving.slice(1).map(([, k]) => moves[k].pair);
      }
      if (!accepted) break;
    }
    yield {
      type: 'settled',
      chain,
      signatures: [from.signature, signatureOf(state.positions)],
      result: entryOf(ctx, state, from.orientation),
    };
  }

  yield* improveFrom(start);
  while (tries < maxTries) {
    let pick = null;
    for (let k = 0; k < EXPLORE_BATCH && tries < maxTries; k++) {
      const attempt = compactAttempt(ctx.input, seed++);
      tries++;
      yield { type: 'progress', phase: 'exploring', round: 0, evaluated: 0, total: 0, tries, seed };
      if (!seen.has(attempt.signature) && (!pick || attempt.score < pick.score)) pick = attempt;
    }
    if (pick) yield* improveFrom({ positions: pick.positions, groupBoxes: pick.groupBoxes, orientation: 'LR' });
  }
}

/** Judges moves and routes layouts on this thread, one at a time. */
export function localJudge(ctx) {
  return {
    size: 1,
    evaluate: (state, moves) => moves.map(m => evaluateMove(ctx, state, m)),
    route: (positions) => measureRealLines(ctx.input, positions),
    close() {},
  };
}

const then = (value, f) => (value && typeof value.then === 'function' ? value.then(f) : f(value));

/**
 * An improve job, driven like the others of the search (compact-search-core.js
 * createJob): `{ kind: 'improve', input, start, options }`, with `start` the
 * layout on the canvas and `options` those of improveSteps. `makeJudge(ctx)`
 * gives what judges the moves and routes the layouts (localJudge, or helpers on
 * other cores from refine-parallel.js), and a step judges as many moves at a time
 * as it has cores. A step returns a report, or a promise of one when the judge
 * works elsewhere.
 */
export function createImproveJob(message, makeJudge = localJudge) {
  const ctx = refineContext(message.input);
  const judge = makeJudge(ctx);
  const steps = improveSteps(ctx, message.start, message.options);
  let next = steps.next();
  let batch = null;
  let where = { round: 0, tries: 0, seed: message.options?.firstSeed ?? 1 };
  const progress = (phase, evaluated = 0, total = 0) => ({ type: 'progress', phase, ...where, evaluated, total });

  const judgeSome = () => {
    const part = batch.moves.slice(batch.results.length, batch.results.length + judge.size * 3);
    return then(judge.evaluate(batch.state, part), (results) => {
      batch.results.push(...results);
      const report = progress('swapping', batch.results.length, batch.moves.length);
      if (batch.results.length >= batch.moves.length) {
        const done = batch.results;
        batch = null;
        next = steps.next(done);
      }
      return report;
    });
  };

  return {
    done: () => next.done && !batch,
    step() {
      if (batch) return judgeSome();
      const request = next.value;
      if (request.type === 'evaluate') {
        where = { round: request.round, tries: request.tries, seed: request.seed };
        batch = { state: request.state, moves: request.moves, results: [] };
        return judgeSome();
      }
      if (request.type === 'route') {
        return then(judge.route(request.positions), (measurement) => {
          next = steps.next(measurement);
          return progress('measuring');
        });
      }
      if (request.type === 'progress') where = { round: request.round, tries: request.tries, seed: request.seed };
      next = steps.next();
      return request;
    },
    finish() {
      judge.close();
      return { type: 'done' };
    },
    close: () => judge.close(),
  };
}
