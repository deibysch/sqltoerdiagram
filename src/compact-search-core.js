// Looking for a better "Short lines, compact" arrangement than the first one.
//
// More polish rounds cannot do it: the layout already polishes until a whole
// round finds nothing to improve, and it gives the same arrangement every time.
// What does find better arrangements is starting somewhere else. Each try reads
// the schema in another order (the seed), which sends dagre and everything
// built on it down another path, and the tries are compared on the score the
// layout optimises. Measured over 20 tries per schema, the best one scored
// 2% to 20% lower than the first; most tries score worse, so only the best few
// are kept.
//
// Nothing here touches the page: the worker (compact-search-worker.js) runs the
// search, the panel (compact-search-ui.js) shows it and lets you pick, and the
// tests call it directly.

import { arrangeGroupsCompact, scoreCompactLayout, compactLayoutMetrics, collectGroupsCompact } from './group-layout-compact.js';

/**
 * What a try needs from the diagram, as plain data a worker can receive. The
 * tables must already be measured: a worker cannot measure text.
 */
export function compactInput(diagram, spacing) {
  const model = diagram.model || {};
  return {
    spacing,
    level: diagram.diagramLevel || 'physical',
    tables: (model.tables || []).map(t => ({
      key: t.key, name: t.name, x: t.x, y: t.y, w: t.w, h: t.h, rowH: t.rowH, headerH: t.headerH,
    })),
    relations: (model.relations || []).map(r => ({ fromTable: r.fromTable, toTable: r.toTable })),
    groups: (model.groups || []).map(g => ({ name: g.name, color: g.color, tables: [...(g.tables || [])] })),
    manualLinks: (diagram.manualLinks || []).map(l => ({ from: { table: l.from?.table }, to: { table: l.to?.table } })),
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
 * What every try depends on, as a string: two inputs with the same key get the
 * same layouts from the same seeds. Where the tables stand is left out, since a
 * try never reads it (except to find the tables inside a box that lists none,
 * which the groups below already account for). So what a search found stays
 * good while tables are moved around, and not once a table, a relation, a group
 * member, a group's name or colour, or the spacing changes.
 */
export function compactInputKey(input) {
  const { groups } = collectGroupsCompact({ tables: input.tables, groups: input.groups }, input.annotations);
  return JSON.stringify([
    input.spacing || '',
    input.level,
    input.tables.map(t => [t.key, t.w, t.h]),
    input.relations.map(r => [r.fromTable, r.toTable]),
    input.manualLinks.map(l => [l.from?.table, l.to?.table]),
    groups.map(g => [g.name, g.color, g.keys]),
  ]);
}

// A throwaway diagram for one try: its own copies of the tables and group boxes.
function diagramFrom(input) {
  return {
    model: { tables: input.tables.map(t => ({ ...t })), relations: input.relations, groups: input.groups },
    annotations: input.annotations.map(a => ({ ...a, tables: [...a.tables] })),
    manualLinks: input.manualLinks,
    diagramLevel: input.level,
    edgeWaypoints: new Map(),
    edgeAnchors: new Map(),
    markDirty() {},
    onLayoutChange() {},
    setAnnotations(list) { this.annotations = list; },
  };
}

/**
 * One try from starting point `seed` (0 is the arrangement the menu has always
 * given). Returns where every table went, the group boxes, the score and the
 * readable metrics, and a signature that is the same for identical layouts.
 */
export function compactAttempt(input, seed = 0) {
  const d = diagramFrom(input);
  const res = arrangeGroupsCompact(d, { spacing: input.spacing, seed, keepSizes: true });
  const positions = d.model.tables.map(t => [t.key, t.x, t.y]);
  return {
    seed,
    implicit: res.implicit,
    groups: res.groups,
    loose: res.loose,
    tables: res.tables,
    score: scoreCompactLayout(d),
    metrics: compactLayoutMetrics(d),
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
 * The `k` best of two such lists together: what earlier searches found, and
 * what the one running has found. Returns `list` itself when nothing gets in.
 */
export function mergeTop(list, more, k) {
  let out = list;
  for (const result of more || []) out = keepBest(out, result, k);
  return out;
}

/**
 * A search that runs one try per step(), from `firstSeed` on, until it has made
 * `maxAttempts` tries or spent `budgetMs`. The budget is checked between tries,
 * so a try that has started always finishes. `keepTop` also keeps the best few
 * distinct layouts, for the thumbnails. `now` is the clock, for the tests.
 */
export function compactSearch(input, { firstSeed = 0, budgetMs = Infinity, maxAttempts = Infinity, keepTop = 0, now } = {}) {
  const clock = now || (() => performance.now());
  const started = clock();
  const state = { best: null, top: [], attempts: 0, elapsed: 0, done: maxAttempts <= 0, nextSeed: firstSeed };
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
      const topChanged = top !== state.top;
      state.top = top;
      state.elapsed = clock() - started;
      state.done = state.attempts >= maxAttempts || state.elapsed >= budgetMs;
      return { seed, result, improved, topChanged };
    },
  };
}

/**
 * What a step tells the page: the layout only when it is the best so far and the
 * top list only when it changed, so a long search does not post every layout.
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
  };
}

/**
 * Put a try's layout on the real diagram: the same changes the layout makes when
 * it runs there, so undo, saving and the group boxes behave exactly as after a
 * normal rearrange.
 */
export function applyCompactResult(diagram, result) {
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
  diagram.markDirty?.();
  diagram.onLayoutChange?.();
}
