import test from 'node:test';
import assert from 'node:assert';
import { organizeLinesShortestPath, getDiagramEdges } from '../src/line-organizer.js';
import { routeInput, routeOnData, applyRoute } from '../src/background-tasks.js';

// the seeded grid of test/line_organizer.test.mjs, smaller
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

const sorted = (map) => [...map].sort(([a], [b]) => (a < b ? -1 : 1));
const linesOf = (d) => ({
  routing: d.edgeRouting,
  anchors: sorted(d.edgeAnchors),
  waypoints: sorted(d.edgeWaypoints),
  routings: sorted(d.edgeRoutings),
  snapshots: d.snapshots,
});

/** Route one copy in place and one through the plain-data path, and compare. */
function bothWays(prepare, targetKeys, options) {
  const inPlace = prepare();
  const viaData = prepare();
  const direct = organizeLinesShortestPath(inPlace, targetKeys, options);
  const result = routeOnData(routeInput(viaData, { targetKeys, options }));
  applyRoute(viaData, result, { recordHistory: options?.recordHistory !== false });
  return { inPlace, viaData, direct, result };
}

// FNV-1a over the lines, sorted by key
function fingerprint(d) {
  const text = JSON.stringify({ anchors: sorted(d.edgeAnchors), waypoints: sorted(d.edgeWaypoints) });
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

test('the lines routed on a copy are exactly the lines routed in place', () => {
  const { inPlace, viaData, direct, result } = bothWays(() => gridDiagram(3, 4), null, {});
  assert.deepStrictEqual(linesOf(viaData), linesOf(inPlace));
  assert.deepStrictEqual(result.summary, direct, 'and the summary agrees');
  assert.strictEqual(viaData.edgeRouting, 'ortho-rounded', 'the line style turns to rounded 90 degree corners');
  assert.strictEqual(viaData.snapshots, 1, 'one undo step');
});

test('so are a selection of lines, and a repair that keeps the others', () => {
  const routed = () => {
    const d = gridDiagram(3, 4);
    organizeLinesShortestPath(d, null, { recordHistory: false });
    d.edgeRoutings.set(getDiagramEdges(d)[1].key, 'curved');
    // a table moves, so some lines need routing again
    d.model.tables[5].x += 40;
    return d;
  };
  const keys = getDiagramEdges(routed()).map(e => e.key).filter((_, i) => i % 4 === 1);
  const selection = bothWays(routed, keys, {});
  assert.deepStrictEqual(linesOf(selection.viaData), linesOf(selection.inPlace), 'a selection');
  const repair = bothWays(routed, keys, { keepOthers: true, recordHistory: false, forceStyle: false, quick: true });
  assert.deepStrictEqual(linesOf(repair.viaData), linesOf(repair.inPlace), 'a repair around the other lines');
  assert.strictEqual(repair.viaData.edgeRouting, 'ortho-rounded', 'kept as it was');
});

test('what goes to the worker is plain data, and routing it leaves the diagram alone', () => {
  const d = gridDiagram(2, 3);
  organizeLinesShortestPath(d, null, { recordHistory: false });
  const before = JSON.stringify(linesOf(d));
  const input = routeInput(d);
  assert.deepStrictEqual(structuredClone(input), input, 'survives being posted to a worker');
  input.anchors[0][1].fromAnchor.side = 'nowhere';
  input.tables[0].x = -999;
  routeOnData(routeInput(d));
  assert.strictEqual(JSON.stringify(linesOf(d)), before, 'the diagram is untouched until the result is applied');
  assert.strictEqual(d.model.tables[0].x, 60);
});

test('with no line to route, applying changes nothing and adds no undo step', () => {
  const d = gridDiagram(2, 2);
  d.model.relations = [];
  const result = routeOnData(routeInput(d));
  applyRoute(d, result);
  assert.strictEqual(d.snapshots, 0);
  assert.strictEqual(d.edgeRouting, 'curved');
});

test('Optimal Route still draws exactly the lines it drew before it was made faster', () => {
  // Fingerprints taken with the router as it was before its search stopped
  // allocating (commit e09fe72). The optimisation must not move a single line;
  // if a change to the router is meant to, take them again and say why.
  for (const [rows, cols, seed, expected, crossings] of [[3, 4, 12345, 3935932542, 18], [4, 5, 777, 3419801877, 73]]) {
    const d = gridDiagram(rows, cols, seed);
    const res = organizeLinesShortestPath(d);
    assert.strictEqual(res.crossings, crossings, `${rows}x${cols}: crossings`);
    assert.strictEqual(fingerprint(d), expected, `${rows}x${cols}: every anchor and vertex`);
  }
});
