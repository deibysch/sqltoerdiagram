import test from 'node:test';
import assert from 'node:assert';
import { arrangeGroupsCompact, compactLayoutMetrics } from '../src/group-layout-compact.js';
import {
  compactInput, compactInputKey, compactAttempt, compactSearch, keepBest, mergeTop, applyCompactResult,
  polishGoalFor, measureRealLines, createJob,
} from '../src/compact-search-core.js';
import { rankScore, resolveShape, improvesBoth } from '../src/layout-goals.js';
import { spCountCrossings } from '../src/line-organizer.js';
import { measureTable } from '../src/renderer.js';

// --- schemas --------------------------------------------------------------

function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function shell(tables, relations, annotations) {
  return {
    model: { tables, relations }, annotations, manualLinks: [], hidden: new Set(),
    edgeAnchors: new Map(), edgeWaypoints: new Map(), edgeRoutings: new Map(),
    diagramLevel: 'physical',
    markDirty() {}, onLayoutChange() {},
    onHistorySnapshot() { this.snapshots = (this.snapshots || 0) + 1; },
    getSnapshot() { return {}; },
    setAnnotations(a) { this.annotations = a; },
  };
}

/** Random tables in `groupCount` groups (none when 0), mostly linked inside their group. */
function schema(n, groupCount, seed) {
  const rand = lcg(seed);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const columns = [{ name: 'id', type: 'bigint' }];
    const k = 2 + Math.floor(rand() * 6);
    for (let c = 0; c < k; c++) columns.push({ name: 'c' + c, type: 'varchar(80)' });
    tables.push({ key: 't' + i, name: 'tabla_' + i, x: (i % 6) * 260, y: Math.floor(i / 6) * 240, columns });
  }
  const groupOf = tables.map(() => (groupCount ? Math.floor(rand() * groupCount) : 0));
  const relations = [];
  for (let i = 1; i < n; i++) {
    const same = tables.map((_, j) => j).filter(j => j < i && groupOf[j] === groupOf[i]);
    if (same.length && rand() < 0.9) {
      relations.push({ fromTable: 't' + i, toTable: 't' + same[Math.floor(rand() * same.length)], fromCols: ['c0'], toCols: ['id'] });
    }
    if (rand() < 0.3) {
      const q = Math.floor(rand() * n);
      if (q !== i) relations.push({ fromTable: 't' + i, toTable: 't' + q, fromCols: ['c1'], toCols: ['id'] });
    }
  }
  const annotations = [{ id: 'n1', type: 'note', text: 'a note', x: 0, y: 0, w: 120, h: 40 }];
  for (let g = 0; g < groupCount; g++) {
    const keys = tables.map((_, i) => i).filter(i => groupOf[i] === g).map(i => 't' + i);
    if (keys.length) annotations.push({ id: 'g' + g, type: 'group', text: 'group ' + g, color: 'blue', tables: keys, x: 0, y: 0, w: 100, h: 100 });
  }
  return shell(tables, relations, annotations);
}

/** Sizes as the page measures them, which is what a search is handed. */
function measured(d) {
  for (const t of d.model.tables) {
    const m = measureTable(t, d.diagramLevel);
    t.w = m.w; t.h = m.h; t.rowH = m.rowH; t.headerH = m.headerH;
  }
  return d;
}

const SETTINGS = { spacing: 'comfortable' };
const positionsOf = (d) => d.model.tables.map(t => [t.key, t.x, t.y]);

function assertNoOverlap(boxes) {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(ox <= 0 || oy <= 0, `${a.key} and ${b.key} overlap`);
    }
  }
}

const CASES = [['without groups', 24, 0, 3], ['with groups', 24, 5, 4]];

// --- a try ----------------------------------------------------------------

for (const [label, n, groups, seed] of CASES) {
  test(`${label}: seed 0 of Balanced with the Auto shape is the layout's own default`, () => {
    const direct = schema(n, groups, seed);
    const res = arrangeGroupsCompact(direct, {});
    const attempt = compactAttempt(compactInput(measured(schema(n, groups, seed))), 0);
    assert.deepStrictEqual(attempt.positions, positionsOf(direct));
    assert.strictEqual(attempt.implicit, res.implicit);
    assert.deepStrictEqual(attempt.groupBoxes, groups ? res.annotations : []);
  });

  test(`${label}: another seed starts elsewhere, the same seed lands in the same place`, () => {
    const input = compactInput(measured(schema(n, groups, seed)), SETTINGS);
    const signatures = new Set();
    for (let s = 0; s < 6; s++) signatures.add(compactAttempt(input, s).signature);
    assert.ok(signatures.size > 1, `six starting points gave ${signatures.size} different layout(s)`);
    assert.strictEqual(compactAttempt(input, 4).signature, compactAttempt(input, 4).signature);
  });

  test(`${label}: every try is a whole, valid arrangement`, () => {
    const d = measured(schema(n, groups, seed));
    const input = compactInput(d, SETTINGS);
    const size = new Map(d.model.tables.map(t => [t.key, t]));
    for (let s = 1; s <= 4; s++) {
      const r = compactAttempt(input, s);
      assert.strictEqual(r.positions.length, n, 'every table has a place');
      const boxes = r.positions.map(([key, x, y]) => ({ key, x, y, w: size.get(key).w, h: size.get(key).h }));
      assert.ok(boxes.every(b => Number.isFinite(b.x) && Number.isFinite(b.y)));
      assertNoOverlap(boxes);
      if (groups) {
        const want = d.annotations.filter(a => a.type === 'group');
        assert.deepStrictEqual(r.groupBoxes.map(b => b.id), want.map(a => a.id), 'the group boxes, in their own order');
        for (const b of r.groupBoxes) {
          const members = want.find(a => a.id === b.id).tables;
          assert.deepStrictEqual([...b.tables].sort(), [...members].sort(), `${b.id} keeps its tables`);
        }
      }
    }
  });
}

test('tries are polished for the goal picked first, then for the other two in turn', () => {
  assert.deepStrictEqual([0, 1, 2, 3].map(s => polishGoalFor('crossings', s)), ['crossings', 'lines', 'balanced', 'crossings']);
  assert.deepStrictEqual([0, 1, 2].map(s => polishGoalFor('lines', s)), ['lines', 'crossings', 'balanced']);
  assert.strictEqual(polishGoalFor('nonsense', 0), 'balanced', 'an unknown goal is Balanced');

  // and a try is exactly the layout polished that way, ranked by the goal picked
  const d = measured(schema(24, 5, 4));
  const shape = resolveShape('4:3');
  const input = compactInput(d, { ...SETTINGS, goal: 'crossings', shape });
  const r = compactAttempt(input, 1);
  const direct = measured(schema(24, 5, 4));
  arrangeGroupsCompact(direct, { spacing: 'comfortable', seed: 1, goal: 'lines', shape });
  assert.strictEqual(r.polish, 'lines');
  assert.deepStrictEqual(r.positions, positionsOf(direct));
  assert.strictEqual(r.score, rankScore(compactLayoutMetrics(direct), { goal: 'crossings', shape }));
});

test('a seed does not reorder the diagram it arranges', () => {
  const d = schema(20, 4, 9);
  const tableOrder = d.model.tables.map(t => t.key);
  const boxes = () => d.annotations.filter(a => a.type === 'group').map(a => `${a.id}: ${a.tables.join(',')}`);
  const listed = boxes();
  arrangeGroupsCompact(d, { seed: 7 });
  assert.deepStrictEqual(d.model.tables.map(t => t.key), tableOrder);
  // the boxes, and the tables each one lists, in the order they had: an order
  // left behind by one try would change where the next run starts
  assert.deepStrictEqual(boxes(), listed);
});

test('seed 0 gives the same arrangement after a try from another seed was applied', () => {
  const d = measured(schema(24, 5, 4));
  const first = compactAttempt(compactInput(d, SETTINGS), 0);
  applyCompactResult(d, compactAttempt(compactInput(d, SETTINGS), 6));
  assert.strictEqual(compactAttempt(compactInput(d, SETTINGS), 0).signature, first.signature);
});

test('the score of a try is the score of that layout once it is on the diagram', () => {
  for (const [, n, groups, seed] of CASES) {
    for (const goal of ['lines', 'crossings', 'balanced']) {
      const d = measured(schema(n, groups, seed));
      const input = compactInput(d, { ...SETTINGS, goal, shape: resolveShape('1:1') });
      const r = compactAttempt(input, 3);
      applyCompactResult(d, r);
      assert.deepStrictEqual(compactLayoutMetrics(d), r.metrics, `${goal}: the same metrics on the canvas`);
      assert.strictEqual(rankScore(compactLayoutMetrics(d), { goal, shape: input.shape }), r.score, `${goal}: and the same score`);
    }
  }
});

// --- putting a try on the diagram -------------------------------------------

test('applying a try moves the tables, redraws the lines from scratch and adds one undo step', () => {
  const d = measured(schema(24, 5, 4));
  d.edgeWaypoints.set('x', [{ x: 1, y: 1 }]);
  d.edgeAnchors.set('x', { fromAnchor: 'right' });
  const r = compactAttempt(compactInput(d, SETTINGS), 2);
  applyCompactResult(d, r);
  assert.deepStrictEqual(positionsOf(d), r.positions);
  assert.strictEqual(d.edgeWaypoints.size, 0);
  assert.strictEqual(d.edgeAnchors.size, 0);
  assert.strictEqual(d.snapshots, 1);
  assert.deepStrictEqual(d.annotations.filter(a => a.type === 'note').map(a => a.id), ['n1'], 'notes stay');
});

test('without groups, applying a try leaves no group box behind', () => {
  const d = measured(schema(12, 0, 2));
  d.annotations.push({ id: 'stale', type: 'group', text: 'empty', tables: [], x: 0, y: 0, w: 10, h: 10 });
  const r = compactAttempt(compactInput(d, SETTINGS), 1);
  applyCompactResult(d, r);
  assert.deepStrictEqual(d.annotations.map(a => a.id), ['n1']);
});

// --- the real lines ---------------------------------------------------------

test('a layout measured with the real lines counts what those lines do', () => {
  const d = measured(schema(16, 3, 8));
  const input = compactInput(d, SETTINGS);
  const r = compactAttempt(input, 1);
  const real = measureRealLines(input, r.positions);

  assert.strictEqual(real.lines.anchors.length, d.model.relations.length, 'every relation gets a line');
  assert.strictEqual(real.routes.length, d.model.relations.length);
  const routes = real.routes.map(pts => pts.map(([x, y]) => ({ x, y })));
  assert.strictEqual(real.metrics.crossings, spCountCrossings(routes), 'the crossings of the drawn lines');
  assert.strictEqual(real.metrics.bends, routes.reduce((n, pts) => n + pts.length - 2, 0), 'bends are their corners');
  const length = routes.reduce((sum, pts) => sum + pts.slice(1).reduce((s, p, i) => s + Math.abs(p.x - pts[i].x) + Math.abs(p.y - pts[i].y), 0), 0);
  assert.ok(Math.abs(real.metrics.length - length) <= routes.length, 'and their length');
  assert.strictEqual(real.metrics.width, r.metrics.width, 'the same canvas as the estimate');
  assert.deepStrictEqual(measureRealLines(input, r.positions), real, 'the same layout measures the same');
});

test('applying a layout with its measured lines puts those lines on the diagram', () => {
  const d = measured(schema(16, 3, 8));
  const input = compactInput(d, SETTINGS);
  const r = compactAttempt(input, 2);
  const real = measureRealLines(input, r.positions);
  const someKey = real.lines.anchors[0][0];
  d.edgeRoutings.set(someKey, 'curved');

  applyCompactResult(d, r, { lines: real.lines });
  assert.strictEqual(d.edgeAnchors.size, real.lines.anchors.length);
  assert.deepStrictEqual(d.edgeAnchors.get(someKey), real.lines.anchors[0][1]);
  assert.strictEqual(d.edgeWaypoints.size, real.lines.waypoints.length);
  assert.ok(!d.edgeRoutings.has(someKey), 'a measured line takes the diagram-wide style, as Optimal Route leaves it');
});

test('a measuring job measures each layout in turn', () => {
  const d = measured(schema(12, 0, 6));
  const input = compactInput(d, SETTINGS);
  const layouts = [0, 1].map(s => compactAttempt(input, s)).map(r => ({ signature: r.signature, positions: r.positions }));
  const job = createJob({ kind: 'measure', input, layouts });
  const reports = [];
  while (!job.done()) reports.push(job.step());
  assert.deepStrictEqual(reports.map(m => [m.type, m.index, m.signature]), layouts.map((l, i) => ['measured', i, l.signature]));
  assert.deepStrictEqual(reports[1].measurement, measureRealLines(input, layouts[1].positions));
  assert.deepStrictEqual(job.finish(), { type: 'done', measured: 2 });
});

// --- the search -------------------------------------------------------------

test('the search keeps the best try and stops on its budget', () => {
  const input = compactInput(measured(schema(24, 0, 3)), SETTINGS);
  let t = 0;
  const search = compactSearch(input, { firstSeed: 5, budgetMs: 350, now: () => (t += 100) - 100 });
  const scores = [];
  while (!search.state.done) scores.push(search.step().result.score);
  // the clock moves 100 per reading: tries end at 100, 200, 300 and 400
  assert.strictEqual(search.state.attempts, 4);
  assert.strictEqual(search.state.nextSeed, 9);
  assert.strictEqual(search.state.best.score, Math.min(...scores));
  assert.strictEqual(search.step(), null, 'a finished search makes no more tries');
});

test('the search stops after its tries even with time to spare', () => {
  const input = compactInput(measured(schema(12, 0, 5)), SETTINGS);
  const search = compactSearch(input, { maxAttempts: 2 });
  search.step();
  assert.strictEqual(search.state.done, false);
  search.step();
  assert.strictEqual(search.state.done, true);
});

test('the search also keeps the layouts that no other beats on both lines and crossings', () => {
  const input = compactInput(measured(schema(24, 5, 4)), { ...SETTINGS, goal: 'balanced' });
  const search = compactSearch(input, { maxAttempts: 9, keepTop: 4 });
  const all = [];
  while (!search.state.done) all.push(search.step().result);
  const { front } = search.state;
  assert.ok(front.length >= 1);
  for (const a of front) {
    assert.ok(!all.some(b => improvesBoth(b.metrics, a.metrics)), 'nothing tried beats a kept layout on both');
  }
  for (const a of all) {
    const beaten = all.some(b => improvesBoth(b.metrics, a.metrics));
    const twin = front.some(f => f.metrics.length === a.metrics.length && f.metrics.crossings === a.metrics.crossings);
    if (!beaten) assert.ok(twin, 'and every layout nothing beats is kept, or one with the same numbers');
  }
});

test('the best few are kept once each, lowest score first', () => {
  const r = (signature, score) => ({ signature, score });
  let top = [];
  for (const x of [r('a', 5), r('b', 3), r('a', 5), r('c', 9), r('d', 1)]) top = keepBest(top, x, 3);
  assert.deepStrictEqual(top.map(x => x.signature), ['d', 'b', 'a']);
  const same = keepBest(top, r('e', 10), 3);
  assert.strictEqual(same, top, 'a try that does not make it leaves the list as it was');
  assert.deepStrictEqual(keepBest([], r('a', 1), 0), [], 'nothing kept when nothing is asked for');
});

test('Keep searching adds to what earlier searches found: the best of both, once each', () => {
  const r = (signature, score) => ({ signature, score });
  const earlier = [r('a', 2), r('b', 5), r('c', 7)];
  const merged = mergeTop(earlier, [r('d', 1), r('b', 5), r('e', 6)], 3);
  assert.deepStrictEqual(merged.map(x => x.signature), ['d', 'a', 'b']);
  assert.strictEqual(mergeTop(earlier, [r('f', 9)], 3), earlier, 'nothing better leaves the list as it was');
  assert.strictEqual(mergeTop(earlier, null, 3), earlier);
});

// --- when what was found still applies ---------------------------------------

test('what a search found survives moving tables, and applying one of its layouts', () => {
  const d = measured(schema(24, 5, 4));
  const key = compactInputKey(compactInput(d, SETTINGS));
  for (const t of d.model.tables) { t.x += 300; t.y -= 120; }
  assert.strictEqual(compactInputKey(compactInput(d, SETTINGS)), key, 'tables moved');
  applyCompactResult(d, compactAttempt(compactInput(d, SETTINGS), 3));
  assert.strictEqual(compactInputKey(compactInput(d, SETTINGS)), key, 'a layout applied');
});

test('what a search found is dropped once anything a try reads changes', () => {
  const keyOf = (change, settings = SETTINGS) => {
    const d = measured(schema(24, 5, 4));
    change(d);
    return compactInputKey(compactInput(d, settings));
  };
  const key = keyOf(() => {});
  const changes = {
    'a relation': (d) => d.model.relations.push({ fromTable: 't1', toTable: 't2' }),
    'a manual link': (d) => d.manualLinks.push({ from: { table: 't3' }, to: { table: 't4' } }),
    'a taller table': (d) => { d.model.tables[0].h += 26; },
    'a hidden table': (d) => d.hidden.add('t5'),
    'a table out of its group': (d) => { const g = d.annotations.find(a => a.type === 'group'); g.tables = g.tables.slice(1); },
    'a renamed group': (d) => { d.annotations.find(a => a.type === 'group').text = 'renamed'; },
  };
  for (const [what, change] of Object.entries(changes)) {
    assert.notStrictEqual(keyOf(change), key, what);
  }
  assert.notStrictEqual(keyOf(() => {}, { spacing: 'spacious' }), key, 'the spacing');
  assert.notStrictEqual(keyOf(() => {}, { ...SETTINGS, goal: 'lines' }), key, 'the goal');
  assert.notStrictEqual(keyOf(() => {}, { ...SETTINGS, shape: resolveShape('3:4') }), key, 'the shape');
  assert.strictEqual(keyOf(() => {}, { ...SETTINGS, goal: 'balanced', shape: resolveShape('auto') }), key, 'the defaults spelled out');
});

test('the same seeds give the same layouts whenever the key is the same', () => {
  const a = measured(schema(24, 5, 4));
  const b = measured(schema(24, 5, 4));
  for (const t of b.model.tables) { t.x = -t.x * 2; t.y += 999; }
  const ia = compactInput(a, SETTINGS), ib = compactInput(b, SETTINGS);
  assert.strictEqual(compactInputKey(ia), compactInputKey(ib));
  for (const seed of [0, 2, 5]) {
    assert.strictEqual(compactAttempt(ia, seed).signature, compactAttempt(ib, seed).signature, `seed ${seed}`);
  }
});
