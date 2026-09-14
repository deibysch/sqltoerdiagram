// Looking for a better arrangement for "Optimize for" than the first one.
//
// More polish rounds cannot do it: the layout already polishes until a whole
// round finds nothing to improve, and it gives the same arrangement every time.
// What does find better arrangements is starting somewhere else. Each try reads
// the schema in another order (the seed), which sends dagre and everything
// built on it down another path. Measured over 20 tries per schema, the best one
// scored 2% to 20% lower than the first; most tries score worse, so only the
// best few are kept.
//
// The tries also take turns at how they are polished: for the goal picked, then
// for the other two, while all of them are ranked by the goal picked
// (layout-goals.js). A try polished for one goal can be the best at another: on
// 60 tables in 10 groups, Fewest crossings reached its 3 crossings with 20%
// shorter lines once it could keep a try polished as Balanced.
//
// Nothing here touches the page: the worker (compact-search-worker.js) runs the
// tries and the real-line measurements, the panel (compact-search-ui.js) shows
// them and lets you pick, and the tests call it directly.

import { arrangeGroupsCompact, compactLayoutMetrics, collectGroupsCompact } from './group-layout-compact.js';
import { GOAL_IDS, goalOf, rankScore, resolveShape, keepFront } from './layout-goals.js';
import { organizeLinesShortestPath, getDiagramEdges, spCountCrossings } from './line-organizer.js';
import { getTableAnchor, buildOrthogonalPoints } from './routing.js';

// the layouts no other beats on both lines and crossings, kept for Balanced
const FRONT_CAP = 8;

/**
 * What a try needs from the diagram, as plain data a worker can receive: the
 * tables already measured (a worker cannot measure text), with the columns the
 * real lines attach to. `settings` is { spacing, goal, shape }, with the shape
 * resolved (resolveShape in layout-goals.js).
 */
export function compactInput(diagram, { spacing, goal, shape } = {}) {
  const model = diagram.model || {};
  return {
    spacing,
    goal: goalOf(goal).id,
    shape: shape || resolveShape('auto'),
    level: diagram.diagramLevel || 'physical',
    tables: (model.tables || []).map(t => ({
      key: t.key, name: t.name, x: t.x, y: t.y, w: t.w, h: t.h, rowH: t.rowH, headerH: t.headerH,
      columns: t.columns || [],
    })),
    relations: (model.relations || []).map(r => ({
      fromTable: r.fromTable, toTable: r.toTable, fromCols: r.fromCols || [], toCols: r.toCols || [],
    })),
    groups: (model.groups || []).map(g => ({ name: g.name, color: g.color, tables: [...(g.tables || [])] })),
    manualLinks: (diagram.manualLinks || []).map(l => ({
      from: { table: l.from?.table, col: l.from?.col }, to: { table: l.to?.table, col: l.to?.col },
    })),
    hidden: [...(diagram.hidden || [])],
    annotations: (diagram.annotations || [])
      .filter(a => a.type === 'group')
      .map(a => ({
        id: a.id, type: 'group', text: a.text, color: a.color,
        tables: Array.isArray(a.tables) ? [...a.tables] : [],
        x: a.x, y: a.y, w: a.w, h: a.h,
      })),
  };
}

/**
 * What every try and every measurement depends on, as a string: two inputs with
 * the same key get the same layouts from the same seeds, and the same real lines.
 * Where the tables stand is left out, since a try never reads it (except to find
 * the tables inside a box that lists none, which the groups below already account
 * for). So what a search found stays good while tables are moved around, and not
 * once the goal, the shape, the spacing, a table, a relation, a hidden table, a
 * group member, or a group's name or colour changes.
 */
export function compactInputKey(input) {
  const { groups } = collectGroupsCompact({ tables: input.tables, groups: input.groups }, input.annotations);
  return JSON.stringify([
    input.spacing || '',
    input.level,
    input.goal,
    input.shape?.ratio ?? null,
    input.tables.map(t => [t.key, t.w, t.h]),
    input.relations.map(r => [r.fromTable, r.toTable, r.fromCols[0], r.toCols[0]]),
    input.manualLinks.map(l => [l.from?.table, l.to?.table]),
    [...input.hidden].sort(),
    groups.map(g => [g.name, g.color, g.keys]),
  ]);
}

// A throwaway diagram for one try or one measurement: its own copies of the tables.
function diagramFrom(input, positions = null) {
  const at = positions ? new Map(positions.map(([key, x, y]) => [key, { x, y }])) : null;
  return {
    model: {
      tables: input.tables.map(t => ({ ...t, ...(at?.get(t.key) || {}) })),
      relations: input.relations,
      groups: input.groups,
    },
    annotations: input.annotations.map(a => ({ ...a, tables: [...a.tables] })),
    manualLinks: input.manualLinks,
    hidden: new Set(input.hidden),
    diagramLevel: input.level,
    edgeWaypoints: new Map(),
    edgeAnchors: new Map(),
    edgeRoutings: new Map(),
    edgeRouting: 'ortho-rounded',
    markDirty() {},
    onLayoutChange() {},
    setAnnotations(list) { this.annotations = list; },
  };
}

/** The goal a try from `seed` is polished for: the goal picked first, then the other two in turn. */
export function polishGoalFor(goal, seed) {
  const first = goalOf(goal).id;
  const order = [first, ...GOAL_IDS.filter(g => g !== first)];
  return order[seed % order.length];
}

/**
 * One try from starting point `seed` (0 is the arrangement the menu gives). Returns
 * where every table went, the group boxes, the metrics, the score for the goal
 * picked, and a signature that is the same for identical layouts.
 */
export function compactAttempt(input, seed = 0) {
  const d = diagramFrom(input);
  const polish = polishGoalFor(input.goal, seed);
  const res = arrangeGroupsCompact(d, { spacing: input.spacing, seed, keepSizes: true, goal: polish, shape: input.shape });
  const positions = d.model.tables.map(t => [t.key, t.x, t.y]);
  const metrics = compactLayoutMetrics(d);
  return {
    seed,
    polish,
    implicit: res.implicit,
    groups: res.groups,
    loose: res.loose,
    tables: res.tables,
    metrics,
    score: rankScore(metrics, { goal: input.goal, shape: input.shape }),
    positions,
    groupBoxes: res.implicit ? [] : res.annotations,
    signature: positions.map(p => `${p[1]},${p[2]}`).join(';'),
  };
}

/**
 * The `k` best results, lowest score first, never two of the same layout.
 * Returns the same list when `result` does not make it in.
 */
export function keepBest(list, result, k) {
  if (!k || list.some(r => r.signature === result.signature)) return list;
  if (list.length >= k && result.score >= list[list.length - 1].score) return list;
  return [...list, result].sort((a, b) => a.score - b.score).slice(0, k);
}

/**
 * Everything in `more` that belongs in the list: the `k` best by score, or, with
 * `front`, the layouts no other beats on both lines and crossings. Returns `list`
 * itself when nothing gets in.
 */
export function mergeTop(list, more, k, { front = false } = {}) {
  let out = list;
  for (const result of more || []) out = front ? keepFront(out, result, k) : keepBest(out, result, k);
  return out;
}

/**
 * A search that runs one try per step(), from `firstSeed` on, until it has made
 * `maxAttempts` tries or spent `budgetMs`. The budget is checked between tries,
 * so a try that has started always finishes. `keepTop` also keeps the best few
 * distinct layouts, and every search keeps the ones that improve both lines and
 * crossings (`front`). `now` is the clock, for the tests.
 */
export function compactSearch(input, { firstSeed = 0, budgetMs = Infinity, maxAttempts = Infinity, keepTop = 0, now } = {}) {
  const clock = now || (() => performance.now());
  const started = clock();
  const state = { best: null, top: [], front: [], attempts: 0, elapsed: 0, done: maxAttempts <= 0, nextSeed: firstSeed };
  return {
    state,
    step() {
      if (state.done) return null;
      const seed = state.nextSeed++;
      const result = compactAttempt(input, seed);
      state.attempts++;
      const improved = !state.best || result.score < state.best.score - 0.5;
      if (improved) state.best = result;
      const top = keepBest(state.top, result, keepTop);
      const front = keepTop ? keepFront(state.front, result, FRONT_CAP) : state.front;
      const topChanged = top !== state.top;
      const frontChanged = front !== state.front;
      state.top = top;
      state.front = front;
      state.elapsed = clock() - started;
      state.done = state.attempts >= maxAttempts || state.elapsed >= budgetMs;
      return { seed, result, improved, topChanged, frontChanged };
    },
  };
}

/**
 * What a step tells the page: the layout only when it is the best so far, and the
 * lists only when they changed, so a long search does not post every layout.
 */
export function stepReport(search, step) {
  return {
    type: 'step',
    seed: step.seed,
    attempts: search.state.attempts,
    elapsed: search.state.elapsed,
    improved: step.improved,
    result: step.improved ? step.result : null,
    top: step.topChanged ? search.state.top : null,
    front: step.frontChanged ? search.state.front : null,
  };
}

/**
 * A layout measured with the real lines: Optimal Route over the tables where
 * `positions` puts them, which is what the canvas draws once that route is
 * applied. Returns the metrics as the estimate names them (bends are the corners
 * of the drawn lines), the lines themselves as the diagram stores them, and each
 * route as points, for the thumbnails. Takes a second or more on a big diagram.
 */
export function measureRealLines(input, positions) {
  const d = diagramFrom(input, positions);
  organizeLinesShortestPath(d, null, { recordHistory: false, forceStyle: false });
  const routes = [];
  let length = 0, bends = 0;
  for (const e of getDiagramEdges(d)) {
    const anchors = d.edgeAnchors.get(e.key);
    if (!anchors) continue;
    const p1 = getTableAnchor(e.from, e.fc, null, anchors.fromAnchor, 0, d.diagramLevel);
    const p2 = getTableAnchor(e.to, e.tc, null, anchors.toAnchor, 0, d.diagramLevel);
    const pts = buildOrthogonalPoints(p1, p2, (d.edgeWaypoints.get(e.key) || []).map(p => ({ ...p })), [], 0);
    routes.push(pts);
    bends += Math.max(0, pts.length - 2);
    for (let i = 0; i < pts.length - 1; i++) {
      length += Math.abs(pts[i].x - pts[i + 1].x) + Math.abs(pts[i].y - pts[i + 1].y);
    }
  }
  const { width, height } = compactLayoutMetrics(d);
  return {
    metrics: { length: Math.round(length), bends, crossings: spCountCrossings(routes), width, height },
    lines: {
      anchors: [...d.edgeAnchors].map(([key, a]) => [key, { fromAnchor: { ...a.fromAnchor }, toAnchor: { ...a.toAnchor } }]),
      waypoints: [...d.edgeWaypoints].map(([key, pts]) => [key, pts.map(p => ({ x: p.x, y: p.y }))]),
    },
    routes: routes.map(pts => pts.map(p => [Math.round(p.x), Math.round(p.y)])),
  };
}

/**
 * A job as a series of steps, run the same in the worker and on the page:
 * `{ kind: 'search', input, options }` makes tries (compactSearch), and
 * `{ kind: 'measure', input, layouts: [{ signature, positions }] }` measures each
 * layout with the real lines. Returns { done(), step(), finish() }.
 */
export function createJob(message) {
  if (message.kind === 'measure') {
    let index = 0;
    return {
      done: () => index >= message.layouts.length,
      step() {
        const layout = message.layouts[index];
        const measurement = measureRealLines(message.input, layout.positions);
        return { type: 'measured', index: index++, signature: layout.signature, measurement };
      },
      finish: () => ({ type: 'done', measured: index }),
    };
  }
  const search = compactSearch(message.input, message.options);
  return {
    done: () => search.state.done,
    step: () => stepReport(search, search.step()),
    finish: () => ({ type: 'done', attempts: search.state.attempts, nextSeed: search.state.nextSeed }),
  };
}

/**
 * Put a try's layout on the real diagram: the same changes the layout makes when
 * it runs there, so undo, saving and the group boxes behave exactly as after a
 * normal rearrange. `lines`, from measureRealLines, also puts the measured lines
 * on it, for a diagram that draws 90 degree lines.
 */
export function applyCompactResult(diagram, result, { lines = null } = {}) {
  diagram.onHistorySnapshot?.(diagram.getSnapshot());
  diagram.edgeWaypoints.clear();
  diagram.edgeAnchors.clear();
  const byKey = new Map(diagram.model.tables.map(t => [t.key, t]));
  for (const [key, x, y] of result.positions) {
    const t = byKey.get(key);
    if (t) { t.x = x; t.y = y; }
  }
  const notes = (diagram.annotations || []).filter(a => a.type !== 'group');
  diagram.setAnnotations(result.implicit
    ? notes
    : [...notes, ...result.groupBoxes.map(b => ({ ...b, tables: [...b.tables] }))]);
  if (lines) {
    for (const [key, anchors] of lines.anchors) {
      diagram.edgeAnchors.set(key, { fromAnchor: { ...anchors.fromAnchor }, toAnchor: { ...anchors.toAnchor } });
      diagram.edgeRoutings?.delete(key);
    }
    for (const [key, pts] of lines.waypoints) diagram.edgeWaypoints.set(key, pts.map(p => ({ x: p.x, y: p.y })));
  }
  diagram.markDirty?.();
  diagram.onLayoutChange?.();
}
