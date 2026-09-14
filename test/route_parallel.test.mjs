import test from 'node:test';
import assert from 'node:assert';
import { organizeLinesShortestPath, getDiagramEdges } from '../src/line-organizer.js';
import { organizeLinesShortestPathInParallel, HelpersFailed } from '../src/route-parallel.js';
import { createRouteHelper } from '../src/route-helper.js';
import { routeInput, routeOnData, routeOnDataInParallel } from '../src/background-tasks.js';

// the seeded grid of test/optimal_route.test.mjs
function gridDiagram(rows, cols, seed = 12345) {
  const tables = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      tables.push({
        key: `t${i}`, name: `t${i}`, x: 60 + c * 260, y: 60 + r * 230, w: 180, h: 126,
        columns: [{ name: 'id' }, { name: 'a_id' }, { name: 'b_id' }, { name: 'c_id' }],
      });
    }
  }
  const rnd = (() => { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
  const names = ['a_id', 'b_id', 'c_id'];
  const relations = [];
  for (let i = 0; i < tables.length; i++) {
    for (let k = 0; k < 2; k++) {
      const j = Math.floor(rnd() * tables.length);
      if (j !== i) relations.push({ fromTable: tables[i].key, toTable: tables[j].key, fromCols: ['id'], toCols: [names[k % 3]] });
    }
  }
  return {
    model: { tables, relations }, manualLinks: [], hidden: new Set(),
    edgeAnchors: new Map(), edgeWaypoints: new Map(), edgeRoutings: new Map(), edgeRouting: 'curved',
    diagramLevel: 'physical',
    snapshots: 0,
    markDirty() {}, onLayoutChange() {}, onHistorySnapshot() { this.snapshots++; }, getSnapshot() { return {}; },
  };
}

// Everything routing leaves behind, the order of the Maps included.
const linesOf = (d) => ({
  routing: d.edgeRouting,
  anchors: [...d.edgeAnchors],
  waypoints: [...d.edgeWaypoints],
  routings: [...d.edgeRoutings],
  snapshots: d.snapshots,
});

// Seeded, so a failing run can be repeated exactly.
function delays(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) % 7);
}

/**
 * A helper worker on this thread. Like a real one it takes a moment to start,
 * gets copies of messages, handles them one by one, and answers a while later:
 * here after a seeded delay, so helpers finish out of order and later trials
 * often come back first.
 */
function fakeHelper(delay, { upForTrials = false } = {}) {
  const ready = () => { if (!helper.dead) helper.onmessage?.({ data: { type: 'ready' } }); };
  const helper = {
    onmessage: null,
    onerror: null,
    dead: false,
    terminate() { helper.dead = true; },
    postMessage(message) {
      const copy = structuredClone(message);
      setTimeout(() => {
        if (helper.dead) return;
        handle(copy);
        if (upForTrials && copy.type === 'items') ready();
      }, 0);
    },
  };
  const handle = createRouteHelper((answer) => {
    const copy = structuredClone(answer);
    setTimeout(() => { if (!helper.dead) helper.onmessage?.({ data: copy }); }, delay());
  });
  // up after a while, or only once the trials begin
  if (!upForTrials) setTimeout(ready, delay());
  return helper;
}

// Helpers from the start, whatever the size, so these small diagrams use them.
const eager = (spawn, helpers, stats) => ({ spawn, helpers, stats, startAfter: 0, minLines: 0 });

test('Optimal Route with helpers draws exactly the lines it draws on one core', async () => {
  for (const [rows, cols, seed, helpers] of [[3, 4, 12345, 2], [4, 4, 4242, 5]]) {
    const one = gridDiagram(rows, cols, seed);
    const many = gridDiagram(rows, cols, seed);
    const expected = organizeLinesShortestPath(one);
    const stats = { handedOut: 0, stale: 0, here: 0 };
    const next = delays(seed);
    const got = await organizeLinesShortestPathInParallel(many, null, {}, eager(() => fakeHelper(next), helpers, stats));
    assert.deepStrictEqual(got, expected, `${rows}x${cols}: the same report`);
    assert.deepStrictEqual(linesOf(many), linesOf(one), `${rows}x${cols}: every anchor and vertex`);
    assert.ok(stats.handedOut > 0, 'trials went to the helpers');
  }
});

test('with helpers that come up late and cold, this thread routes and runs trials too, and the lines are the same', async () => {
  const one = gridDiagram(3, 4, 31);
  const many = gridDiagram(3, 4, 31);
  const expected = organizeLinesShortestPath(one);
  const stats = { handedOut: 0, stale: 0, here: 0 };
  const next = delays(31);
  const late = () => fakeHelper(() => 5 + next(), { upForTrials: true });
  const got = await organizeLinesShortestPathInParallel(many, null, {}, eager(late, 3, stats));
  assert.deepStrictEqual(got, expected);
  assert.deepStrictEqual(linesOf(many), linesOf(one));
  assert.ok(stats.here > 0 && stats.handedOut > 0, `both ran trials (${JSON.stringify(stats)})`);
});

test('and so it does with tables off the pixel grid, on a selection, and repairing around fixed lines', async () => {
  // routed once, then a table moves off the pixel grid, as a drag leaves it
  const routed = gridDiagram(3, 4, 99);
  routed.model.tables.forEach((t, i) => { t.x += ((i * 0.37) % 1); t.y += ((i * 0.61) % 1); });
  organizeLinesShortestPath(routed, null, { recordHistory: false });
  routed.model.tables[5].x += 33.3;
  const copy = () => ({
    ...routed,
    model: { tables: routed.model.tables.map(t => ({ ...t })), relations: routed.model.relations },
    hidden: new Set(routed.hidden),
    edgeAnchors: new Map([...routed.edgeAnchors].map(([k, a]) => [k, structuredClone(a)])),
    edgeWaypoints: new Map([...routed.edgeWaypoints].map(([k, pts]) => [k, pts.map(p => ({ ...p }))])),
    edgeRoutings: new Map(routed.edgeRoutings),
  });
  const next = delays(7);
  const keys = getDiagramEdges(routed).map(e => e.key).filter((_, i) => i % 2 === 0);
  for (const [options, targetKeys] of [
    [{}, null],
    [{}, keys],
    [{ keepOthers: true, recordHistory: false, forceStyle: false, quick: true }, keys],
  ]) {
    const one = copy();
    const many = copy();
    const expected = organizeLinesShortestPath(one, targetKeys, options);
    const got = await organizeLinesShortestPathInParallel(many, targetKeys, options, eager(() => fakeHelper(next), 4));
    assert.deepStrictEqual(got, expected);
    assert.deepStrictEqual(linesOf(many), linesOf(one));
  }
});

test('helpers that cannot start, or stop half way, leave the lines to one core', async () => {
  const cannot = () => { throw new Error('no workers inside workers here'); };
  await assert.rejects(organizeLinesShortestPathInParallel(gridDiagram(3, 4), null, {}, eager(cannot, 3)), HelpersFailed);

  const crashing = () => {
    const helper = fakeHelper(() => 1);
    const post = helper.postMessage;
    helper.postMessage = (message) => {
      if (message.type === 'rip' || message.type === 'pair') setTimeout(() => helper.onerror?.({ message: 'crashed' }), 1);
      else post(message);
    };
    return helper;
  };
  const input = routeInput(gridDiagram(4, 5, 777));
  const expected = routeOnData(input);
  assert.deepStrictEqual(await routeOnDataInParallel(input, eager(crashing, 3)), expected,
    'the run starts again on one core, from a fresh copy');
});

test('a short run, few lines or a single helper do not start helpers at all', async () => {
  const never = () => { throw new Error('should not start a helper'); };
  const cases = [
    [() => gridDiagram(2, 3), { helpers: 4, spawn: never, minLines: 0 }],              // over before helpers are due
    [() => gridDiagram(3, 4), { helpers: 4, spawn: never, startAfter: 0 }],            // fewer lines than it takes
    [() => gridDiagram(3, 4), { helpers: 1, spawn: never, startAfter: 0, minLines: 0 }],
  ];
  for (const [make, helpers] of cases) {
    const expected = organizeLinesShortestPath(make());
    assert.deepStrictEqual(await organizeLinesShortestPathInParallel(make(), null, {}, helpers), expected);
  }
});
