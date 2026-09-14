import test from 'node:test';
import assert from 'node:assert';
import {
  GOALS, SHAPES, resolveShape, ratioText, rankScore, layoutScore, rankCandidates, chooseBest, keepFront, improvesBoth,
} from '../src/layout-goals.js';
import { arrangeGroupsCompact, compactLayoutMetrics } from '../src/group-layout-compact.js';

const m = (length, crossings, width = 1600, height = 1000, bends = 0) => ({ length, crossings, width, height, bends });
const auto = resolveShape('auto');

// --- shapes -------------------------------------------------------------------

test('every shape in the menu resolves to its proportion', () => {
  assert.deepStrictEqual(SHAPES.map(s => s.id), ['auto', 'screen', '1:1', '4:3', '3:4', '16:9', 'a4-landscape', 'a4-portrait']);
  assert.strictEqual(resolveShape('auto').ratio, null);
  assert.strictEqual(resolveShape('3:4').ratio, 0.75);
  assert.ok(Math.abs(resolveShape('a4-portrait').ratio * Math.SQRT2 - 1) < 1e-9);
  assert.strictEqual(resolveShape('screen', 1280 / 668).ratio, 1.92, 'Screen takes the window, rounded');
  assert.strictEqual(resolveShape('nonsense').id, 'auto');
  assert.strictEqual(ratioText(1600, 1000), '1.6 : 1');
  assert.strictEqual(ratioText(700, 1000), '1 : 1.4', 'a tall one reads the other way round');
});

test('a chosen shape costs nothing within 5% of it, and more the further off', () => {
  const square = { goal: 'balanced', shape: resolveShape('1:1') };
  const exact = rankScore(m(10000, 0, 1000, 1000), square);
  assert.strictEqual(rankScore(m(10000, 0, 1040, 1000), square), exact, '4% off is as good as exact');
  const tenOff = rankScore(m(10000, 0, 1100, 1000), square);
  const twentyOff = rankScore(m(10000, 0, 1200, 1000), square);
  assert.ok(exact < tenOff && tenOff < twentyOff, 'past that, further is worse');
  assert.strictEqual(rankScore(m(10000, 0, 1000, 1200), square), twentyOff, 'too tall costs what too wide costs');
});

test('Auto ranks anything from square to 2:1 the same, and charges past that', () => {
  const o = { goal: 'balanced', shape: auto };
  const square = rankScore(m(10000, 0, 1000, 1000), o);
  assert.strictEqual(rankScore(m(10000, 0, 1900, 1000), o), square);
  assert.ok(rankScore(m(10000, 0, 3000, 1000), o) > square, 'a strip');
  assert.ok(rankScore(m(10000, 0, 1000, 1500), o) > square, 'taller than wide');
});

test('while polishing, Auto with groups still leans towards 1.6:1, and bends count', () => {
  const o = { goal: 'balanced', shape: auto };
  assert.ok(layoutScore(m(10000, 0, 1600, 1000), o, true) < layoutScore(m(10000, 0, 1000, 1000), o, true));
  assert.strictEqual(layoutScore(m(10000, 0, 1600, 1000), o, false), layoutScore(m(10000, 0, 1000, 1000), o, false));
  assert.strictEqual(layoutScore(m(10000, 2, 1600, 1000, 3), o, false), 10000 + 3 * GOALS.balanced.bend + 2 * GOALS.balanced.cross);
});

// --- goals --------------------------------------------------------------------

// Current and two options from a Compare in the browser, on 40 tables in 7 groups.
const current = { signature: 'current', metrics: m(33564, 16) };
const optionA = { signature: 'A', metrics: m(27714, 19) };   // lines -17%, 3 more crossings
const optionB = { signature: 'B', metrics: m(29965, 14) };   // lines -11%, 2 fewer crossings
const scored = (goal, e) => ({ ...e, score: rankScore(e.metrics, { goal, shape: auto }) });

test('each goal ranks by what it is named after', () => {
  const lines = { goal: 'lines', shape: auto };
  assert.ok(rankScore(m(1000, 9), lines) < rankScore(m(1100, 0), lines), 'Shortest lines: shorter wins');
  const crossings = { goal: 'crossings', shape: auto };
  assert.ok(rankScore(m(100000, 1), crossings) < rankScore(m(1000, 2), crossings), 'Fewest crossings: fewer always wins');
  assert.ok(rankScore(m(900, 2), crossings) < rankScore(m(1000, 2), crossings), '...and the lines settle a tie');
  const balanced = { goal: 'balanced', shape: auto };
  assert.strictEqual(rankScore(m(1200, 0), balanced), rankScore(m(1000, 1), balanced), 'Balanced: a crossing is 200 px');
});

test('Balanced puts first the layout that improves lines and crossings at once', () => {
  const pick = (goal) => chooseBest(goal, scored(goal, current), [scored(goal, optionA), scored(goal, optionB)]).signature;
  // A scores better on the Balanced sum, and still B comes first: it gives up nothing
  assert.ok(scored('balanced', optionA).score < scored('balanced', optionB).score);
  assert.strictEqual(pick('balanced'), 'B');
  assert.strictEqual(pick('crossings'), 'B');
  assert.strictEqual(pick('lines'), 'A');
  assert.deepStrictEqual(
    rankCandidates('balanced', scored('balanced', current), [scored('balanced', optionA), scored('balanced', optionB)]).map(c => c.signature),
    ['B', 'A']);
});

test('nothing is chosen when nothing beats the layout on the canvas', () => {
  const goal = 'balanced';
  const best = scored(goal, { signature: 'best', metrics: m(20000, 2) });
  const worse = scored(goal, { signature: 'worse', metrics: m(25000, 3) });
  assert.strictEqual(chooseBest(goal, best, [worse]), null);
  assert.strictEqual(chooseBest(goal, best, [{ ...best }]), null, 'the same layout is not an option');
});

test('the layouts nobody beats on both are kept, once per pair of numbers', () => {
  const e = (signature, length, crossings) => ({ signature, score: length + 200 * crossings, metrics: m(length, crossings) });
  let front = [];
  for (const x of [e('a', 1000, 5), e('b', 900, 7), e('c', 1100, 5), e('d', 1000, 5), e('e', 950, 4)]) front = keepFront(front, x, 8);
  // c is beaten by a, d has a's numbers, and e beats a
  assert.deepStrictEqual(front.map(x => x.signature).sort(), ['b', 'e']);
  assert.ok(front.every(x => !front.some(y => improvesBoth(y.metrics, x.metrics))));
  const same = keepFront(front, e('f', 2000, 9), 8);
  assert.strictEqual(same, front, 'a beaten layout leaves the list as it was');
});

// --- the layout, polished for a goal and a shape --------------------------------

function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

// the same schemas as test/compact_search.test.mjs
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
  const annotations = [];
  for (let g = 0; g < groupCount; g++) {
    const keys = tables.map((_, i) => i).filter(i => groupOf[i] === g).map(i => 't' + i);
    if (keys.length) annotations.push({ id: 'g' + g, type: 'group', text: 'group ' + g, color: 'blue', tables: keys, x: 0, y: 0, w: 100, h: 100 });
  }
  return {
    model: { tables, relations }, annotations, manualLinks: [], hidden: new Set(),
    edgeAnchors: new Map(), edgeWaypoints: new Map(), edgeRoutings: new Map(), diagramLevel: 'physical',
    markDirty() {}, onLayoutChange() {}, onHistorySnapshot() {}, getSnapshot() { return {}; },
    setAnnotations(a) { this.annotations = a; },
  };
}

const SCHEMAS = [['24 tables in 5 groups', 24, 5, 4], ['24 tables, no groups', 24, 0, 3], ['40 tables in 6 groups', 40, 6, 11], ['40 tables, no groups', 40, 0, 12]];
const arranged = (spec, opts) => {
  const d = schema(...spec);
  arrangeGroupsCompact(d, opts);
  return compactLayoutMetrics(d);
};

test('a chosen shape comes out within 10% of it, at the first try', () => {
  // measured: 0% to 9% off, with and without groups
  for (const [name, ...spec] of SCHEMAS) {
    for (const id of ['1:1', '4:3', '3:4', '16:9', 'a4-portrait']) {
      const shape = resolveShape(id);
      const got = arranged(spec, { shape });
      const ratio = got.width / got.height;
      const off = Math.max(ratio / shape.ratio, shape.ratio / ratio) - 1;
      assert.ok(off <= 0.1, `${name}, ${id}: ${ratio.toFixed(2)} is ${Math.round(off * 100)}% off`);
    }
  }
});

test('polished for crossings the lines cross less, polished for lines they come out shorter', () => {
  // three tries each, summed: measured 5 vs 10, 1 vs 7, 5 vs 13 and 13 vs 38 crossings
  for (const [name, ...spec] of SCHEMAS) {
    const total = (goal) => [0, 1, 2].map(seed => arranged(spec, { goal, seed }))
      .reduce((sum, x) => ({ length: sum.length + x.length, crossings: sum.crossings + x.crossings }), { length: 0, crossings: 0 });
    const lines = total('lines'), crossings = total('crossings');
    assert.ok(crossings.crossings < lines.crossings, `${name}: ${crossings.crossings} crossings against ${lines.crossings}`);
    assert.ok(lines.length < crossings.length, `${name}: ${lines.length} px of line against ${crossings.length}`);
  }
});
