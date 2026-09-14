import test from 'node:test';
import assert from 'node:assert';
import { layout } from '../src/layout.js';
import { orientDiagram } from '../src/rotate-diagram.js';
import { reorderWithLocalAI, reorderWithExistingGroups, reorderWithDomains } from '../src/ai-layout.js';
import { organizeLinesShortestPath, organizeLinesElkPorts, organizeLinesAStar, getDiagramEdges } from '../src/line-organizer.js';
import { arrangeGroupsCompact } from '../src/group-layout-compact.js';
import { computeGroupBounds } from '../src/annotations.js';
import { measureTable } from '../src/renderer.js';
import {
  runTask, routeInput, routeOnData, applyRoute, layoutInput, layoutOnData, applyLayout,
  orientInput, orientOnData, applyOrient, groupsInput, groupsOnData,
} from '../src/background-tasks.js';
import { startJob } from '../src/background.js';

// Four domains with plenty of cross-domain traffic (as in rotate_diagram.test.mjs).
const DOMAINS = {
  auth: ['usuario', 'rol', 'permiso', 'rol_permiso', 'sesion'],
  catalog: ['producto', 'categoria', 'marca', 'inventario'],
  sales: ['pedido', 'pedido_item', 'pago', 'factura'],
  logistics: ['envio', 'transportista', 'ruta', 'almacen'],
};
const RELS = [
  ['rol_permiso', 'rol'], ['rol_permiso', 'permiso'], ['usuario', 'rol'], ['sesion', 'usuario'],
  ['producto', 'categoria'], ['producto', 'marca'], ['inventario', 'producto'], ['inventario', 'almacen'],
  ['pedido', 'usuario'], ['pedido_item', 'pedido'], ['pedido_item', 'producto'],
  ['pago', 'pedido'], ['factura', 'pedido'], ['factura', 'usuario'],
  ['envio', 'pedido'], ['envio', 'transportista'], ['envio', 'ruta'], ['ruta', 'almacen'],
  ['almacen', 'usuario'], ['transportista', 'usuario'], ['pago', 'usuario'], ['categoria', 'usuario'],
];

function schema() {
  const tables = Object.values(DOMAINS).flat().map((n, i) => ({
    key: n, name: n,
    columns: [{ name: 'id', type: 'bigint', pk: true }, { name: 'nombre', type: 'varchar(100)' }, { name: 'ref_id', type: 'bigint' }]
      .concat(i % 3 ? [] : [{ name: 'descripcion_larga', type: 'text' }]),
  }));
  for (const t of tables) {
    const { w, h, rowH, headerH } = measureTable(t);
    Object.assign(t, { w, h, rowH, headerH });
  }
  const relations = RELS.map(([f, t]) => ({ fromTable: f, toTable: t, fromCols: ['ref_id'], toCols: ['id'] }));
  return { tables, relations };
}

// A stand-in for Diagram with what the algorithms use, fitAllGroups included.
function mockDiagram() {
  return {
    model: schema(),
    annotations: Object.entries(DOMAINS).map(([name, names]) => ({
      id: 'g_' + name, type: 'group', text: name, color: 'blue', tables: names, x: 0, y: 0, w: 100, h: 100,
    })).concat([{ id: 'n1', type: 'note', text: 'hello', color: 'yellow', x: 900, y: 40, w: 160, h: 90 }]),
    manualLinks: [{ from: { table: 'sesion', col: 'nombre' }, to: { table: 'rol', col: 'id' } }],
    hidden: new Set(),
    edgeAnchors: new Map(), edgeWaypoints: new Map(), edgeRoutings: new Map(), edgeRouting: 'ortho-rounded',
    diagramLevel: 'physical', orientation: 'LR', snapshots: 0,
    markDirty() {}, onLayoutChange() {},
    onHistorySnapshot() { this.snapshots++; }, getSnapshot() { return {}; },
    setAnnotations(a) { this.annotations = a; },
    fitAllGroups() {
      for (const a of this.annotations) {
        if (a.type !== 'group' || !Array.isArray(a.tables) || !a.tables.length) continue;
        const b = computeGroupBounds(a, this.model.tables);
        if (b) Object.assign(a, b);
      }
    },
  };
}

/** Arranged, with every line routed and one of them drawn curved. */
function routedDiagram() {
  const d = mockDiagram();
  arrangeGroupsCompact(d, { spacing: 'comfortable' });
  organizeLinesShortestPath(d, null, { recordHistory: false });
  d.edgeRoutings.set(getDiagramEdges(d)[3].key, 'curved');
  d.snapshots = 0;
  return d;
}

const places = (model) => model.tables.map(t => [t.key, t.x, t.y, t.w, t.h, t.rowH, t.headerH]);
// Maps in their own order: the copy must not even reorder them.
const everything = (d) => ({
  tables: d.model.tables.map(t => [t.key, t.x, t.y, t.w, t.h]),
  annotations: d.annotations,
  anchors: [...d.edgeAnchors],
  waypoints: [...d.edgeWaypoints],
  routings: [...d.edgeRoutings],
  edgeRouting: d.edgeRouting,
  orientation: d.orientation,
  memory: JSON.stringify(d._orientMemory ?? null, (_, v) => (v instanceof Map ? [...v] : v)),
  snapshots: d.snapshots,
});

test('the tables-without-groups layouts place a copy exactly as they place the tables themselves', () => {
  for (const algo of ['dagre', 'force', 'radial']) {
    for (const placed of [false, true]) {
      const make = () => {
        const d = mockDiagram();
        d.model.groups = Object.entries(DOMAINS).map(([name, tables]) => ({ name, tables }));
        if (placed) d.model.tables.forEach((t, i) => { t.x = 40 + (i % 6) * 250; t.y = 40 + Math.floor(i / 6) * 200; });
        return d.model;
      };
      const inPlace = make();
      const viaData = make();
      const opts = { algo, dir: 'LR', spacing: 'comfortable' };
      const hidden = new Set(['marca']);
      layout(inPlace, opts, hidden);
      const input = layoutInput(viaData, opts, hidden);
      assert.deepStrictEqual(structuredClone(input), input, 'what goes to the worker is plain data');
      applyLayout(viaData, layoutOnData(input));
      assert.deepStrictEqual(places(viaData), places(inPlace), `${algo}, ${placed ? 'from where the tables are' : 'from nothing'}`);
    }
  }
});

test('Direction on a copy turns the diagram exactly as turning it in place, and still knows the way back', () => {
  const inPlace = routedDiagram();
  const viaData = routedDiagram();

  const turned = orientDiagram(inPlace, 'TB');
  const input = orientInput(viaData, 'TB');
  assert.deepStrictEqual(structuredClone(input), input, 'what goes to the worker is plain data');
  assert.deepStrictEqual(applyOrient(viaData, orientOnData(input)), turned, 'the same report');
  assert.ok(turned.repaired > 0, 'the quarter turn re-routed lines, so the repair ran too');
  assert.deepStrictEqual(everything(viaData), everything(inPlace));

  // Back again: both come back from the remembered state, which survived the copy.
  const back = orientDiagram(inPlace, 'LR');
  const backViaData = applyOrient(viaData, orientOnData(structuredClone(orientInput(viaData, 'LR'))));
  assert.ok(back.restored && backViaData.restored, 'restored, not turned again');
  assert.deepStrictEqual(everything(viaData), everything(inPlace));

  // A half turn from there takes the exact way through the opposite direction.
  orientDiagram(inPlace, 'RL');
  applyOrient(viaData, orientOnData(orientInput(viaData, 'RL')));
  assert.deepStrictEqual(everything(viaData), everything(inPlace));
});

test('turning to the direction the diagram already has changes nothing and records no undo step', () => {
  const d = routedDiagram();
  const before = everything(d);
  const res = applyOrient(d, orientOnData(orientInput(d, 'LR')));
  assert.strictEqual(res.changed, false);
  assert.deepStrictEqual(everything(d), before);
});

test('Ports and channels and Around tables route a copy exactly as they route the diagram', () => {
  for (const [tool, organize] of [['ports', organizeLinesElkPorts], ['around', organizeLinesAStar]]) {
    for (const keys of [null, (d) => getDiagramEdges(d).map(e => e.key).filter((_, i) => i % 3 === 0)]) {
      const inPlace = routedDiagram();
      const viaData = routedDiagram();
      inPlace.model.tables[4].x += 90;   // something for the tools to do
      viaData.model.tables[4].x += 90;
      const targetKeys = keys && keys(inPlace);
      const count = organize(inPlace, targetKeys);
      const input = routeInput(viaData, { tool, targetKeys });
      assert.deepStrictEqual(structuredClone(input), input, 'what goes to the worker is plain data');
      assert.strictEqual(applyRoute(viaData, routeOnData(input)), count, `${tool}: the same count`);
      assert.deepStrictEqual(everything(viaData), everything(inPlace), `${tool}, ${keys ? 'a selection' : 'every line'}`);
    }
  }
});

test('the AI arrangements lay out a copy exactly as they lay out the diagram', () => {
  // A generated group id carries the time, so it is the one thing left out.
  const boxes = (annotations) => annotations.map(a => ({ ...a, id: a.id.startsWith('group_ai_') ? 'generated' : a.id }));
  const options = { createGroups: true, lineStyle: 'ortho-rounded', spacing: 'compact' };
  const answer = [
    { name: 'People', color: 'rose', tables: ['USUARIO', 'rol', 'sesion', 'rol'] },
    { name: 'Selling', tables: ['pedido', 'pago', 'factura', 'no_such_table'] },
    { name: 'Empty', tables: [] },
  ];
  const runs = {
    local: (model) => reorderWithLocalAI(model, options),
    domains: (model) => reorderWithDomains(model, answer, options),
    existing: (model, d) => reorderWithExistingGroups(model, d.annotations, options),
  };
  for (const [mode, direct] of Object.entries(runs)) {
    const inPlace = mockDiagram();
    const viaData = mockDiagram();
    arrangeGroupsCompact(inPlace, { spacing: 'comfortable' });
    arrangeGroupsCompact(viaData, { spacing: 'comfortable' });
    if (mode === 'existing') {
      // a group listing no tables takes the ones inside its box
      inPlace.annotations[1].tables = [];
      viaData.annotations[1].tables = [];
    }
    const expected = direct(inPlace.model, inPlace);
    const input = groupsInput(viaData, { mode, domains: mode === 'domains' ? answer : null, options });
    assert.deepStrictEqual(structuredClone(input), input, 'what goes to the worker is plain data');
    const res = groupsOnData(input);
    applyLayout(viaData.model, res);
    assert.deepStrictEqual(places(viaData.model), places(inPlace.model), `${mode}: every table`);
    assert.deepStrictEqual(boxes(res.annotations), boxes(expected.annotations), `${mode}: the group boxes`);
    assert.strictEqual(res.implicit, !!expected.implicit);
  }
});

test('a task works on its own copy: running one never touches the diagram it was read from', () => {
  const d = routedDiagram();
  const before = everything(d);
  const sizes = places(d.model);
  routeOnData(routeInput(d, { tool: 'ports' }));
  orientOnData(orientInput(d, 'TB'));
  layoutOnData(layoutInput(d.model, { algo: 'dagre' }, d.hidden));
  groupsOnData(groupsInput(d, { mode: 'local', options: {} }));
  assert.deepStrictEqual(everything(d), before);
  assert.deepStrictEqual(places(d.model), sizes);
});

test('an unknown task or tool is an error, not a silent no-op', () => {
  assert.throws(() => runTask('nope', {}), /Unknown background task/);
  assert.throws(() => runTask('lines', routeInput(mockDiagram(), { tool: 'nope' })), /Unknown line tool/);
  assert.throws(() => runTask('groups', groupsInput(mockDiagram(), { mode: 'nope' })), /Unknown arrangement/);
});

/** Start a job and wait for whichever callback it ends with. */
function outcome(task, read, { change, cancel } = {}) {
  return new Promise((resolve) => {
    const job = startJob(task, read, {
      apply: (result) => resolve({ end: 'apply', result }),
      onStale: () => resolve({ end: 'stale' }),
      onFail: (message) => resolve({ end: 'fail', message }),
    });
    change?.();
    if (cancel) {
      job.cancel();
      setTimeout(() => resolve({ end: 'nothing' }), 30);
    }
  });
}

test('a background job lands only if the diagram is still what it read', async () => {
  const model = schema();
  const opts = { algo: 'dagre', dir: 'LR', spacing: 'comfortable' };
  const read = () => layoutInput(model, opts, new Set());

  const done = await outcome('layout', read);
  assert.strictEqual(done.end, 'apply', 'nothing changed: the result lands');
  const direct = schema();
  layout(direct, opts, new Set());
  applyLayout(model, done.result);
  assert.deepStrictEqual(places(model), places(direct), 'and it is the layout itself');

  const moved = await outcome('layout', read, { change: () => { model.tables[2].x += 5; } });
  assert.strictEqual(moved.end, 'stale', 'a table moved meanwhile: dropped');

  const widened = await outcome('layout', read, { change: () => { model.tables[0].columns.push({ name: 'a_much_longer_column_name', type: 'text' }); } });
  assert.strictEqual(widened.end, 'stale', 'a table grew meanwhile: dropped');

  const failed = await outcome('nope', () => ({}));
  assert.strictEqual(failed.end, 'fail');
  assert.match(failed.message, /Unknown background task/);

  const cancelled = await outcome('layout', read, { cancel: true });
  assert.strictEqual(cancelled.end, 'nothing', 'a cancelled job ends in silence');
});
