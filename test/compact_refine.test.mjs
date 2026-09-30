import test from 'node:test';
import assert from 'node:assert';
import { compactInput, compactAttempt, measureRealLines, applyCompactResult } from '../src/compact-search-core.js';
import { refineContext, neighbourPairs, placeSwap, evaluateMove, createImproveJob, localJudge } from '../src/compact-refine.js';
import { parallelJudge, createRefineHelper } from '../src/refine-parallel.js';
import { rankScore } from '../src/layout-goals.js';
import { measureTable } from '../src/renderer.js';

// --- schemas --------------------------------------------------------------

function lcg(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

function shell(tables, relations, annotations = []) {
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

/** Random tables in `groupCount` groups (none when 0), mostly linked inside their group, measured. */
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
  const d = shell(tables, relations, annotations);
  for (const t of d.model.tables) {
    const m = measureTable(t, d.diagramLevel);
    t.w = m.w; t.h = m.h; t.rowH = m.rowH; t.headerH = m.headerH;
  }
  return d;
}

/** Tables of the given sizes where they are put, with no relation unless given. */
function boxes(list, relations = [], annotations = []) {
  const tables = list.map(([key, x, y, w, h]) => ({ key, name: key, x, y, w, h, columns: [{ name: 'id' }, { name: 'a_id' }] }));
  return shell(tables, relations, annotations);
}

const SETTINGS = { spacing: 'comfortable', goal: 'balanced' };

/** The first arrangement of Balanced, as a start for Improve. */
function firstLayout(d) {
  const input = compactInput(d, SETTINGS);
  const a = compactAttempt(input, 0);
  return { input, start: { signature: a.signature, positions: a.positions, groupBoxes: a.groupBoxes } };
}

function runAll(job) {
  const reports = [];
  while (!job.done()) reports.push(job.step());
  reports.push(job.finish());
  return reports;
}

async function runAllAsync(job) {
  const reports = [];
  while (!job.done()) reports.push(await job.step());
  reports.push(job.finish());
  return reports;
}

/** What Improve found: the layouts it measured and reached, with their lines. */
const outcome = (reports) => reports
  .filter(m => m.type === 'measured' || m.type === 'best' || m.type === 'candidate')
  .map(m => (m.type === 'measured' ? ['measured', m.signature, m.measurement] : [m.type, m.result.signature, m.result.measurement]));

function assertNoOverlap(positions, input) {
  const size = new Map(input.tables.map(t => [t.key, t]));
  const b = positions.map(([key, x, y]) => ({ key, x, y, w: size.get(key).w, h: size.get(key).h }));
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) {
      const ox = Math.min(b[i].x + b[i].w, b[j].x + b[j].w) - Math.max(b[i].x, b[j].x);
      const oy = Math.min(b[i].y + b[i].h, b[j].y + b[j].h) - Math.max(b[i].y, b[j].y);
      assert.ok(ox <= 0 || oy <= 0, `${b[i].key} and ${b[j].key} overlap`);
    }
  }
}

// --- which tables trade places ----------------------------------------------

test('each table is tried with its nearest neighbour in each direction, never diagonally', () => {
  const d = boxes([['a', 0, 0, 100, 60], ['b', 200, 0, 100, 60], ['c', 0, 150, 100, 60], ['d', 200, 150, 100, 60]]);
  const ctx = refineContext(compactInput(d, SETTINGS));
  const pairs = neighbourPairs(ctx, d.model.tables.map(t => [t.key, t.x, t.y]));
  assert.deepStrictEqual(pairs, [
    { a: 0, b: 1, axis: 'x' }, { a: 0, b: 2, axis: 'y' }, { a: 1, b: 3, axis: 'y' }, { a: 2, b: 3, axis: 'x' },
  ]);
});

test('only tables of the same group trade places, and a hidden table never does', () => {
  const d = boxes([['a', 0, 0, 100, 60], ['b', 200, 0, 100, 60], ['c', 400, 0, 100, 60], ['h', 600, 0, 100, 60]], [], [
    { id: 'g1', type: 'group', text: 'one', tables: ['a', 'b'], x: -30, y: -50, w: 360, h: 140 },
    { id: 'g2', type: 'group', text: 'two', tables: ['c', 'h'], x: 370, y: -50, w: 360, h: 140 },
  ]);
  d.hidden.add('h');
  const ctx = refineContext(compactInput(d, SETTINGS));
  const pairs = neighbourPairs(ctx, d.model.tables.map(t => [t.key, t.x, t.y]));
  assert.deepStrictEqual(pairs, [{ a: 0, b: 1, axis: 'x' }]);
});

// --- where they land ----------------------------------------------------------

test('two tables of a column trade places and the column keeps its span', () => {
  const d = boxes([['a', 0, 0, 100, 100], ['b', 20, 140, 60, 200], ['c', 0, 380, 100, 80]]);
  const input = compactInput(d, SETTINGS);
  const ctx = refineContext(input);
  const state = { positions: d.model.tables.map(t => [t.key, t.x, t.y]), groupBoxes: [] };
  const move = placeSwap(ctx, state, { a: 0, b: 1, axis: 'y' });
  // b now starts where a did, a ends where b did; each centred where the other was
  assert.deepStrictEqual(move.tables, [[0, 0, 240], [1, 20, 0]]);
});

test('a table that no longer fits is pushed out of the way, back to the gap it had', () => {
  // b is tall: at a's place, centred on a's row, it reaches down into c
  const d = boxes([['a', 0, 0, 100, 60], ['b', 140, 0, 100, 300], ['c', 0, 100, 100, 60]]);
  const input = compactInput(d, SETTINGS);
  const ctx = refineContext(input);
  const state = { positions: d.model.tables.map(t => [t.key, t.x, t.y]), groupBoxes: [] };
  const move = placeSwap(ctx, state, { a: 0, b: 1, axis: 'x' });
  const at = new Map(move.tables.map(([i, x, y]) => [i, [x, y]]));
  assert.deepStrictEqual(at.get(1), [0, -120], 'b takes the left, centred where a was');
  assert.deepStrictEqual(at.get(0), [140, 120], 'a takes the right, centred where b was');
  assert.deepStrictEqual(at.get(2), [0, 220], 'c goes down, 40 px under b as it was under a');
  const positions = state.positions.map((p, i) => (at.has(i) ? [p[0], ...at.get(i)] : p));
  assertNoOverlap(positions, input);
});

test('a swap that would push a group box into another group is not made', () => {
  const groups = [
    { id: 'g1', type: 'group', text: 'one', tables: ['a', 'b'], x: -32, y: -56, w: 304, h: 344 },
    { id: 'g2', type: 'group', text: 'two', tables: ['c'], x: -32, y: -246, w: 164, h: 144 },
  ];
  // a and b sit side by side; b is tall, so at a's place, centred on a's row, it
  // would reach far above group one, into group two
  const d = boxes([['a', 0, 0, 100, 60], ['b', 140, 0, 100, 260], ['c', 0, -190, 100, 60]], [], groups);
  const input = compactInput(d, SETTINGS);
  const ctx = refineContext(input);
  const state = { positions: d.model.tables.map(t => [t.key, t.x, t.y]), groupBoxes: groups };
  assert.strictEqual(placeSwap(ctx, state, { a: 0, b: 1, axis: 'x' }), null);

  // with group two well out of the way, the same swap is made
  const far = groups.map(g => (g.id === 'g2' ? { ...g, y: g.y - 400 } : g));
  const e = boxes([['a', 0, 0, 100, 60], ['b', 140, 0, 100, 260], ['c', 0, -590, 100, 60]], [], far);
  const farState = { positions: e.model.tables.map(t => [t.key, t.x, t.y]), groupBoxes: far };
  assert.ok(placeSwap(refineContext(compactInput(e, SETTINGS)), farState, { a: 0, b: 1, axis: 'x' }));
});

// --- judging a swap by the real lines ------------------------------------------

test('a swap routes again only the lines of the tables that moved, and those now in their way', () => {
  const d = schema(16, 0, 5);
  const { input, start } = firstLayout(d);
  const ctx = refineContext(input);
  const m = measureRealLines(input, start.positions);
  const state = { positions: start.positions, groupBoxes: [], anchors: m.lines.anchors, waypoints: m.lines.waypoints };
  const move = neighbourPairs(ctx, start.positions).map(p => placeSwap(ctx, state, p)).find(Boolean);
  const result = evaluateMove(ctx, state, move);

  const moved = new Set(move.tables.map(([i]) => input.tables[i].key));
  const routed = new Set(result.lines.map(([key]) => key));
  for (const r of input.relations) {
    const key = `${r.fromTable}.${r.fromCols[0]}->${r.toTable}.${r.toCols[0]}`.toLowerCase();
    if (moved.has(r.fromTable) || moved.has(r.toTable)) assert.ok(routed.has(key), `${key} touches a table that moved`);
  }
  assert.ok(routed.size < input.relations.length, 'not every line');
  assert.strictEqual(result.score, rankScore(result.metrics, { goal: input.goal, shape: input.shape }));
});

// --- Improve --------------------------------------------------------------------

/** Improve from `start` on `input`, `maxTries` starting points explored after refining it. */
const improve = (input, start, maxTries = 0, makeJudge) =>
  createImproveJob({ kind: 'improve', input, start, options: { maxTries } }, makeJudge);

// Improve takes seconds, so each run the tests look at runs once.
const once = (f) => { let value; return () => (value ??= f()); };
const improveOf = (n, groups, seed) => once(() => {
  const { input, start } = firstLayout(schema(n, groups, seed));
  return { input, start, reports: runAll(improve(input, start)) };
});
const RUNS = [['without groups', improveOf(14, 0, 3)], ['with groups', improveOf(18, 3, 5)]];
const lastBest = (reports) => reports.filter(m => m.type === 'best').at(-1).result;

for (const [label, run] of RUNS) {
  test(`${label}: Improve starts from the layout given, never ends worse, and reports real lines of valid layouts`, () => {
    const { input, start, reports } = run();
    const measured = reports.filter(m => m.type === 'measured');
    assert.deepStrictEqual(measured.map(m => m.signature), [start.signature]);
    const objective = { goal: input.goal, shape: input.shape };
    const startScore = rankScore(measured[0].measurement.metrics, objective);

    const bests = reports.filter(m => m.type === 'best').map(m => m.result);
    // the first is the layout it started from, with its lines, for the canvas to draw
    assert.strictEqual(bests[0].signature, start.signature);
    assert.deepStrictEqual(bests[0].measurement.metrics, measured[0].measurement.metrics);
    let last = Infinity;
    for (const b of bests) {
      const score = rankScore(b.measurement.metrics, objective);
      assert.ok(score < last, 'each best beats the one before');
      last = score;
      assertNoOverlap(b.positions, input);
      // the lines are those of that layout: every relation, measured as drawn
      assert.strictEqual(b.measurement.routes.length, input.relations.length);
      for (const box of b.groupBoxes) {
        for (const key of box.tables) {
          const [, x, y] = b.positions.find(p => p[0].toLowerCase() === key);
          const t = input.tables.find(t => t.key.toLowerCase() === key);
          assert.ok(x >= box.x && y >= box.y && x + t.w <= box.x + box.w && y + t.h <= box.y + box.h, `${key} inside ${box.id}`);
        }
      }
    }
    assert.ok(last <= startScore, 'the best is never worse than the start');
    assert.strictEqual(reports.at(-1).type, 'done');
  });
}

test('with groups, Improve finds shorter real lines than the first arrangement', () => {
  const { reports } = RUNS[1][1]();
  const before = reports.find(m => m.type === 'measured').measurement.metrics;
  const after = lastBest(reports).measurement.metrics;
  assert.ok(after.length < before.length && after.crossings <= before.crossings,
    `lines ${before.length} -> ${after.length}, crossings ${before.crossings} -> ${after.crossings}`);
});

test('a layout Improve reached goes on the diagram with its group boxes and its lines', () => {
  const { input, reports } = RUNS[1][1]();
  const best = lastBest(reports);
  const d = schema(18, 3, 5);
  applyCompactResult(d, best, { lines: best.measurement.lines });
  assert.deepStrictEqual(d.model.tables.map(t => [t.key, t.x, t.y]), best.positions);
  assert.deepStrictEqual(d.annotations.map(a => a.id).sort(), ['g0', 'g1', 'g2']);
  assert.strictEqual(d.edgeAnchors.size, input.relations.length);
});

test('exploring measures the most promising of each few starting points, and refines it unless it is far behind', () => {
  const { input, start } = firstLayout(schema(14, 2, 21));
  const reports = runAll(createImproveJob({ kind: 'improve', input, start, options: { firstSeed: 5, maxTries: 8 } }));

  const tried = reports.filter(m => m.type === 'progress' && m.phase === 'exploring');
  assert.deepStrictEqual(tried.map(m => [m.tries, m.seed]), [1, 2, 3, 4, 5, 6, 7, 8].map(n => [n, 5 + n]));
  // of seeds 5 to 8, and of 9 to 12, the one the estimate scores best
  const pick = (seeds) => seeds.map(seed => compactAttempt(input, seed)).sort((a, b) => a.score - b.score)[0].signature;
  const measured = reports.filter(m => m.type === 'measured').map(m => m.signature);
  assert.deepStrictEqual(measured, [start.signature, pick([5, 6, 7, 8]), pick([9, 10, 11, 12])]);

  // Each layout measured is refined (swaps tried before the next is measured)
  // unless it measures more than 30% behind the best so far. Each one refined
  // is a chain of better and better layouts, the best so far or candidates to
  // pick, and it settles on the last one it reported.
  const objective = { goal: input.goal, shape: input.shape };
  const scoreOf = (m) => rankScore(m.result.measurement.metrics, objective);
  let best = Infinity;
  let behind = null;
  const last = new Map();
  for (const m of reports) {
    if (m.type === 'measured') {
      const score = rankScore(m.measurement.metrics, objective);
      behind = score > Math.min(best, score) * 1.3;
    } else if (m.type === 'best') {
      assert.ok(scoreOf(m) < best, 'a best beats the one before');
      best = scoreOf(m);
    } else if (m.type === 'candidate') {
      assert.ok(scoreOf(m) >= best - 0.5, 'a candidate does not beat the best');
      assert.ok(!behind, 'and it is not far behind');
    } else if (m.type === 'progress' && m.phase === 'swapping') {
      assert.ok(!behind, 'a layout far behind is not refined');
    }
    if (m.type === 'best' || m.type === 'candidate') {
      if (last.has(m.chain)) assert.ok(scoreOf(m) < last.get(m.chain).score, 'a chain only gets better');
      last.set(m.chain, { signature: m.result.signature, score: scoreOf(m) });
    }
    if (m.type === 'settled') assert.strictEqual(m.result.signature, last.get(m.chain).signature);
  }
  assert.ok(last.size >= 2, 'the layout it started from, and at least one explored');
});

test('a layout measured already keeps its lines and is not routed again', () => {
  const { input, start } = firstLayout(schema(12, 0, 7));
  const run = (s) => {
    let routed = 0;
    const counting = (ctx) => {
      const local = localJudge(ctx);
      return { ...local, route: (positions) => { routed++; return local.route(positions); } };
    };
    return { reports: runAll(improve(input, s, 0, counting)), routed };
  };
  const measurement = measureRealLines(input, start.positions);
  const known = run({ ...start, measurement });
  const fresh = run(start);
  const measured = (r) => r.reports.find(m => m.type === 'measured');
  assert.strictEqual(measured(known).measurement, measurement);
  assert.strictEqual(known.routed, 0, 'Improve routes a whole layout only to measure it');
  assert.strictEqual(fresh.routed, 1);
  assert.deepStrictEqual(outcome(known.reports), outcome(fresh.reports), 'measured the same, it refines the same');
});

test('Improve says which layouts it refined to the end, and a settled one is only measured', () => {
  const { input, start, reports } = RUNS[0][1]();
  const settled = reports.filter(m => m.type === 'settled');
  const end = lastBest(reports).signature;
  assert.deepStrictEqual(settled.map(m => m.signatures), [[start.signature, end]]);
  assert.strictEqual(settled[0].result.signature, end, 'with the layout it ended on, to pick later');

  const again = runAll(improve(input, { ...start, settled: true }));
  assert.ok(again.some(m => m.type === 'measured'), 'measured');
  assert.ok(!again.some(m => m.type === 'progress' && m.phase === 'swapping'), 'but no swap tried');
  assert.ok(!again.some(m => m.type === 'settled'));
});

// --- on several cores -----------------------------------------------------------

function delays(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) % 5);
}

/** A helper worker on this thread: copies of messages, handled in turn, answered a while later. */
function fakeHelper(delay, { failAfter = Infinity } = {}) {
  let answered = 0;
  const helper = {
    onmessage: null, onerror: null, dead: false,
    terminate() { helper.dead = true; },
    postMessage(message) {
      const copy = structuredClone(message);
      setTimeout(() => {
        if (helper.dead) return;
        if (copy.type === 'evaluate' && answered >= failAfter) {
          helper.onerror?.({ message: 'helper crashed', preventDefault() {} });
          return;
        }
        handle(copy);
      }, 0);
    },
  };
  const handle = createRefineHelper((answer) => {
    answered++;
    const copy = structuredClone(answer);
    setTimeout(() => { if (!helper.dead) helper.onmessage?.({ data: copy }); }, delay());
  });
  return helper;
}

const onOneCore = once(() => {
  const { input, start } = firstLayout(schema(16, 2, 11));
  const message = { kind: 'improve', input, start, options: { maxTries: 4 } };
  return { message, reports: runAll(createImproveJob(message)) };
});

test('helpers on other cores reach exactly the layouts and lines of one core', async () => {
  const { message, reports: one } = onOneCore();
  const delay = delays(7);
  let spawned = 0;
  const judge = (ctx) => parallelJudge(ctx, {
    spawn: () => { spawned++; return fakeHelper(delay); }, helpers: 3,
  });
  const many = await runAllAsync(createImproveJob(message, judge));
  assert.strictEqual(spawned, 3);
  assert.ok(outcome(one).filter(([type]) => type === 'best').length >= 2, 'Improve moves tables');
  assert.deepStrictEqual(outcome(many), outcome(one));
});

test('helpers that stop part way leave the rest to this thread, with the same result', async () => {
  const { message, reports: one } = onOneCore();
  const delay = delays(3);
  const judge = (ctx) => parallelJudge(ctx, {
    spawn: () => fakeHelper(delay, { failAfter: 4 }), helpers: 3,
  });
  const many = await runAllAsync(createImproveJob(message, judge));
  assert.deepStrictEqual(outcome(many), outcome(one));
});
