// Refine, in the search panel of "Optimize for": neighbouring tables trade places
// wherever the real lines come out better.
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
// A round tries every table with its nearest neighbour in each of the four
// directions, within its own group. It takes the swap that improves the most,
// tries the other improving ones again from there, and ends with Optimal Route
// over the whole diagram, since lines re-routed a few at a time drift from what
// it would draw. Rounds go on until one finds nothing. Measured from Balanced's
// first arrangement: 35 tables without groups, lines -7.6%; 35 tables in 6
// groups, -13.8%; 60 tables in 10 groups, -12.4% and 13 crossings down to 7.
//
// Tables of different sizes trade places too. Along the row or column the two
// share, the pair keeps the span it had; whatever the bigger one now presses
// against is pushed out of its way, inside its own group, as long as no group
// box runs into another.
//
// It refines the layout on the canvas and, after a search, the best few others,
// since a better start often refines into a better end. The swaps of a round are
// independent of each other, so in a worker with cores to spare helpers judge
// them (refine-parallel.js), with the same result as here.

import { getDiagramEdges, organizeLinesShortestPath } from './line-organizer.js';
import { getTableAnchor, buildOrthogonalPoints, segmentIntersectsBox } from './routing.js';
import { rankScore } from './layout-goals.js';
import { collectGroupsCompact, compactLayoutMetrics, compactSpacing, fitGroupBox } from './group-layout-compact.js';
import { diagramFrom, measureRealLines, realLinesOf } from './compact-search-core.js';

const MAX_ROUNDS = 8;
const MAX_PUSHED = 8;        // tables a swap may push out of its way
const CLEAR_SHARE = 0.6;     // closer than this share of the gap between tables, a table is in the way
const GROUP_CLEAR = 24;      // px a group box keeps from another group box
const TABLE_CLEAR = 16;      // ... and from a table outside it
const HIT_MARGIN = 8;        // a line this close to a table that moved is routed again
// A round has never gained more than 14% (the most measured), so a start that
// measures further than this behind the best so far is only measured.
const REACH = 1.15;

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
 * Each table with its nearest neighbour in each of the four directions, in the
 * same group: the pairs a round tries to swap, each once, with the axis they
 * share ('x' for a row, 'y' for a column).
 */
export function neighbourPairs(ctx, positions) {
  const boxes = boxesOf(ctx, positions);
  const c = boxes.map(b => [b.x + b.w / 2, b.y + b.h / 2]);
  const seen = new Set();
  const pairs = [];
  for (let a = 0; a < boxes.length; a++) {
    if (ctx.skip[a]) continue;
    for (const [dx, dy] of DIRECTIONS) {
      let best = -1, bestD = Infinity;
      for (let b = 0; b < boxes.length; b++) {
        if (b === a || ctx.skip[b] || ctx.container[b] !== ctx.container[a]) continue;
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
 * touches, the others held where `state` has them. Returns its score and metrics
 * and, for every line routed, [key, anchors, waypoints], null for none.
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
  if (keys.length) organizeLinesShortestPath(d, keys, { recordHistory: false, forceStyle: false, keepOthers: true, quick: true });
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
 * Refine, step by step. It yields what it cannot do itself: { type: 'route' },
 * Optimal Route over a whole layout, answered with measureRealLines(); and
 * { type: 'evaluate', state, moves }, answered with evaluateMove() of every move
 * against that state, in order. Everything else it yields is a report:
 * 'measured' when a start has been measured, 'best' when the best layout so far
 * changes, and 'progress'.
 */
export function* refineSteps(ctx, starts, { maxRounds = MAX_ROUNDS } = {}) {
  let best = null;
  const report = (state, orientation) => ({ type: 'best', result: entryOf(ctx, state, orientation) });

  for (let index = 0; index < starts.length; index++) {
    const start = startFrom(ctx, starts[index]);
    // A start measured already keeps those lines: a layout Refine reached can have
    // better ones than routing it from scratch gives.
    let measurement = starts[index].measurement;
    if (!measurement) {
      yield { type: 'progress', index, round: 0, phase: 'measuring', evaluated: 0, total: 0 };
      measurement = yield { type: 'route', positions: start.positions };
    }
    let state = stateFrom(ctx, start, measurement);
    yield { type: 'measured', index, signature: start.signature, measurement };
    if (!best || state.score < best.score - 0.5) {
      best = state;
      yield report(state, start.orientation);
    }
    if (state.score > best.score * REACH) continue;

    for (let round = 0; round < maxRounds; round++) {
      let accepted = 0;
      let pairs = neighbourPairs(ctx, state.positions);
      for (;;) {
        const moves = pairs.map(p => placeSwap(ctx, state, p)).filter(Boolean);
        if (!moves.length) break;
        const results = yield { type: 'evaluate', state, moves, index, round };
        const improving = results
          .map((r, i) => [r, i])
          .filter(([r]) => r.score < state.score - 0.5)
          .sort((x, y) => x[0].score - y[0].score || x[1] - y[1]);
        if (!improving.length) break;
        const [result, i] = improving[0];
        state = applyMove(ctx, state, moves[i], result);
        accepted++;
        if (state.score < best.score - 0.5) {
          best = state;
          yield report(state, start.orientation);
        }
        // the other improving swaps, placed and judged again from here
        pairs = improving.slice(1).map(([, k]) => moves[k].pair);
      }
      if (!accepted) break;

      yield { type: 'progress', index, round, phase: 'measuring', evaluated: 0, total: 0 };
      const fresh = yield { type: 'route', positions: state.positions };
      if (rankScore(fresh.metrics, ctx.objective) < state.score - 0.5) {
        state = stateFrom(ctx, state, fresh);
        if (state.score < best.score - 0.5) {
          best = state;
          yield report(state, start.orientation);
        }
      }
    }
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
 * A refine job, driven like the others of the search (compact-search-core.js
 * createJob): `{ kind: 'refine', input, starts, options }`, with `starts` the
 * layouts to refine, first the one on the canvas. `makeJudge(ctx)` gives what
 * judges the moves and routes the layouts (localJudge, or helpers on other cores
 * from refine-parallel.js), and a step judges as many moves at a time as it has
 * cores. A step returns a report, or a promise of one when the judge works
 * elsewhere.
 */
export function createRefineJob(message, makeJudge = localJudge) {
  const ctx = refineContext(message.input);
  const judge = makeJudge(ctx);
  const steps = refineSteps(ctx, message.starts || [], message.options);
  let next = steps.next();
  let batch = null;
  let where = { index: 0, round: 0 };

  const judgeSome = () => {
    const part = batch.moves.slice(batch.results.length, batch.results.length + judge.size * 3);
    return then(judge.evaluate(batch.state, part), (results) => {
      batch.results.push(...results);
      const progress = { type: 'progress', ...where, phase: 'swapping', evaluated: batch.results.length, total: batch.moves.length };
      if (batch.results.length >= batch.moves.length) {
        const done = batch.results;
        batch = null;
        next = steps.next(done);
      }
      return progress;
    });
  };

  return {
    done: () => next.done && !batch,
    step() {
      if (batch) return judgeSome();
      const request = next.value;
      if (request.type === 'evaluate') {
        where = { index: request.index, round: request.round };
        batch = { state: request.state, moves: request.moves, results: [] };
        return judgeSome();
      }
      if (request.type === 'route') {
        return then(judge.route(request.positions), (measurement) => {
          next = steps.next(measurement);
          return { type: 'progress', ...where, phase: 'measuring', evaluated: 0, total: 0 };
        });
      }
      if (request.type === 'progress') where = { index: request.index, round: request.round };
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
