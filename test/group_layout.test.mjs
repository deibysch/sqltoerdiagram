import test from 'node:test';
import assert from 'node:assert';
import { arrangeGroupsCompact, collectGroupsCompact } from '../src/group-layout-compact.js';
import { arrangeGroupsSingleAxis } from '../src/group-layout-axis.js';
import { arrangeGroupsMinCrossings } from '../src/group-layout-crossings.js';
import { reorderWithExistingGroups } from '../src/ai-layout.js';
import { organizeLinesShortestPath, spCountCrossings } from '../src/line-organizer.js';
import { getTableAnchor, buildOrthogonalPoints } from '../src/routing.js';

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

function buildDiagram() {
  const tables = [];
  let i = 0;
  for (const names of Object.values(DOMAINS)) {
    for (const n of names) {
      tables.push({
        key: n, name: n, x: 60 + (i % 5) * 240, y: 60 + Math.floor(i / 5) * 220,
        columns: [{ name: 'id', type: 'bigint' }, { name: 'nombre', type: 'varchar(100)' }, { name: 'ref_id', type: 'bigint' }],
      });
      i++;
    }
  }
  // Two tables deliberately left out of every group.
  tables.push({ key: 'auditoria', name: 'auditoria', x: 60, y: 900, columns: [{ name: 'id', type: 'bigint' }, { name: 'usuario_id', type: 'bigint' }] });
  tables.push({ key: 'config', name: 'config', x: 300, y: 900, columns: [{ name: 'id', type: 'bigint' }, { name: 'clave', type: 'varchar(50)' }] });

  const relations = RELS.map(([f, t]) => ({ fromTable: f, toTable: t, fromCols: ['ref_id'], toCols: ['id'] }));
  relations.push({ fromTable: 'auditoria', toTable: 'usuario', fromCols: ['usuario_id'], toCols: ['id'] });

  const annotations = Object.entries(DOMAINS).map(([name, names]) => ({
    id: 'g_' + name, type: 'group', text: name, color: 'blue', tables: names, x: 0, y: 0, w: 100, h: 100,
  }));

  return {
    model: { tables, relations }, annotations, manualLinks: [], hidden: new Set(),
    edgeAnchors: new Map(), edgeWaypoints: new Map(), edgeRoutings: new Map(),
    diagramLevel: 'physical',
    markDirty() {}, onLayoutChange() {}, onHistorySnapshot(s) { this.snapshots = (this.snapshots || 0) + 1; },
    getSnapshot() { return {}; },
    setAnnotations(a) { this.annotations = a; },
  };
}

/** Route the diagram for real and report what the drawn lines look like. */
function routeAndMeasure(d) {
  organizeLinesShortestPath(d);
  const byKey = new Map(d.model.tables.map(t => [t.key.toLowerCase(), t]));
  const pts = [];
  let length = 0, vertices = 0;
  for (const r of d.model.relations) {
    const key = `${r.fromTable}.${r.fromCols[0]}->${r.toTable}.${r.toCols[0]}`;
    const a = d.edgeAnchors.get(key);
    if (!a) continue;
    const p1 = getTableAnchor(byKey.get(r.fromTable), r.fromCols[0], null, a.fromAnchor, 0, 'physical');
    const p2 = getTableAnchor(byKey.get(r.toTable), r.toCols[0], null, a.toAnchor, 0, 'physical');
    const p = buildOrthogonalPoints(p1, p2, (d.edgeWaypoints.get(key) || []).map(q => ({ ...q })), [], 0);
    pts.push(p);
    vertices += p.length - 2;
    for (let i = 0; i < p.length - 1; i++) {
      length += Math.abs(p[i].x - p[i + 1].x) + Math.abs(p[i].y - p[i + 1].y);
    }
  }
  return { crossings: spCountCrossings(pts), length: Math.round(length), vertices };
}

test('collectGroupsCompact resolves members and reports the ungrouped tables', () => {
  const d = buildDiagram();
  const { groups, loose } = collectGroupsCompact(d.model, d.annotations);
  assert.strictEqual(groups.length, 4);
  assert.deepStrictEqual(loose.map(t => t.key).sort(), ['auditoria', 'config']);
  assert.strictEqual(groups.reduce((n, g) => n + g.keys.length, 0), 17);
});

test('arrangeGroupsCompact wipes every vertex and anchor before laying out', () => {
  const d = buildDiagram();
  d.edgeWaypoints.set('pedido.ref_id->usuario.id', [{ x: -500, y: -500 }]);
  d.edgeAnchors.set('pedido.ref_id->usuario.id', { fromAnchor: { side: 'top', offset: 0.1 }, toAnchor: { side: 'top', offset: 0.1 } });

  arrangeGroupsCompact(d);

  assert.strictEqual(d.edgeWaypoints.size, 0, 'no waypoint survives');
  assert.strictEqual(d.edgeAnchors.size, 0, 'no anchor position survives');
  assert.ok(d.snapshots > 0, 'a history snapshot was taken so the move can be undone');
});

test('arrangeGroupsCompact untangles far better than filling groups by list order', () => {
  const before = routeAndMeasure((() => {
    const d = buildDiagram();
    const res = reorderWithExistingGroups(d.model, d.annotations, { createGroups: true });
    if (res.annotations) d.annotations = res.annotations;
    return d;
  })());

  const after = routeAndMeasure((() => {
    const d = buildDiagram();
    arrangeGroupsCompact(d);
    return d;
  })());

  // Measured: 10 -> 5 crossings, 34 -> 23 vertices, and 9196 -> 6953px of line.
  assert.ok(after.crossings <= before.crossings / 2,
    `crossings should at least halve (${before.crossings} -> ${after.crossings})`);
  assert.ok(after.vertices < before.vertices * 0.75,
    `vertices should drop clearly (${before.vertices} -> ${after.vertices})`);
  assert.ok(after.length < before.length * 1.2,
    `line length must not balloon (${before.length} -> ${after.length})`);
});

test('arrangeGroupsCompact keeps each group whole, boxed and non-overlapping', () => {
  const d = buildDiagram();
  const res = arrangeGroupsCompact(d);
  assert.strictEqual(res.groups, 4);
  assert.strictEqual(res.loose, 2);

  const boxes = d.annotations.filter(a => a.type === 'group');
  assert.strictEqual(boxes.length, 4, 'one box per group, none invented or dropped');

  const byKey = new Map(d.model.tables.map(t => [t.key.toLowerCase(), t]));
  for (const b of boxes) {
    // Every member sits inside its own box...
    for (const k of b.tables) {
      const t = byKey.get(k);
      assert.ok(t.x >= b.x && t.y >= b.y && t.x + t.w <= b.x + b.w && t.y + t.h <= b.y + b.h,
        `${k} is inside the ${b.text} box`);
    }
    // ...and no table from another group strays into it.
    for (const t of d.model.tables) {
      if (b.tables.includes(t.key.toLowerCase())) continue;
      const inside = t.x + t.w > b.x && t.x < b.x + b.w && t.y + t.h > b.y && t.y < b.y + b.h;
      assert.ok(!inside, `${t.key} must not sit inside the ${b.text} box`);
    }
  }

  // Group boxes must not overlap each other either.
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0
                   && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0;
      assert.ok(!overlap, `${a.text} and ${b.text} boxes overlap`);
    }
  }
});

test('arrangeGroupsCompact parks ungrouped tables next to the group they talk to', () => {
  const d = buildDiagram();
  arrangeGroupsCompact(d);

  const boxes = d.annotations.filter(a => a.type === 'group');
  const auth = boxes.find(b => b.text === 'auth');
  const auditoria = d.model.tables.find(t => t.key === 'auditoria');

  // auditoria's only relation is to usuario, which lives in auth.
  const dx = Math.max(auth.x - (auditoria.x + auditoria.w), auditoria.x - (auth.x + auth.w), 0);
  const dy = Math.max(auth.y - (auditoria.y + auditoria.h), auditoria.y - (auth.y + auth.h), 0);
  assert.ok(dx + dy < 200, `auditoria should hug the auth box (gap ${Math.round(dx + dy)}px)`);

  // And it gets no box of its own.
  assert.ok(!boxes.some(b => b.tables.includes('auditoria')), 'loose tables stay unboxed');
});

test('arrangeGroupsCompact refuses politely when there are no groups', () => {
  const d = buildDiagram();
  d.annotations = [];
  assert.throws(() => arrangeGroupsCompact(d), /No hay grupos definidos/);
});

test('arrangeGroupsCompact keeps the canvas compact and screen-shaped', () => {
  // A layout can shorten every single line and still be miserable: letting dagre
  // choose the overall shape produced a canvas 2.85x wider than tall, so "Fit"
  // shrank everything to nothing and reading meant panning sideways forever.
  const d = buildDiagram();
  arrangeGroupsCompact(d);

  const x0 = Math.min(...d.model.tables.map(t => t.x));
  const y0 = Math.min(...d.model.tables.map(t => t.y));
  const x1 = Math.max(...d.model.tables.map(t => t.x + t.w));
  const y1 = Math.max(...d.model.tables.map(t => t.y + t.h));
  const w = x1 - x0, h = y1 - y0;
  const ratio = Math.max(w / h, h / w);
  assert.ok(ratio < 2.2, `canvas should stay screen-shaped, got ${w}x${h} (${ratio.toFixed(2)}:1)`);

  // And it must not be mostly empty space, or every read needs a zoom.
  const tableArea = d.model.tables.reduce((s, t) => s + t.w * t.h, 0);
  const density = tableArea / (w * h);
  assert.ok(density > 0.15, `canvas is too sparse: only ${(density * 100).toFixed(1)}% is table`);
});

test('arrangeGroupsCompact shortens lines rather than merely untangling them', () => {
  const lengths = (d) => {
    organizeLinesShortestPath(d);
    const byKey = new Map(d.model.tables.map(t => [t.key.toLowerCase(), t]));
    let total = 0, longest = 0;
    for (const r of d.model.relations) {
      const key = `${r.fromTable}.${r.fromCols[0]}->${r.toTable}.${r.toCols[0]}`;
      const a = d.edgeAnchors.get(key);
      if (!a) continue;
      const p1 = getTableAnchor(byKey.get(r.fromTable), r.fromCols[0], null, a.fromAnchor, 0, 'physical');
      const p2 = getTableAnchor(byKey.get(r.toTable), r.toCols[0], null, a.toAnchor, 0, 'physical');
      const p = buildOrthogonalPoints(p1, p2, (d.edgeWaypoints.get(key) || []).map(q => ({ ...q })), [], 0);
      let l = 0;
      for (let i = 0; i < p.length - 1; i++) l += Math.abs(p[i].x - p[i + 1].x) + Math.abs(p[i].y - p[i + 1].y);
      total += l;
      longest = Math.max(longest, l);
    }
    return { total, longest };
  };

  const before = lengths((() => {
    const d = buildDiagram();
    const res = reorderWithExistingGroups(d.model, d.annotations, { createGroups: true });
    if (res.annotations) d.annotations = res.annotations;
    return d;
  })());
  const after = lengths((() => { const d = buildDiagram(); arrangeGroupsCompact(d); return d; })());

  assert.ok(after.total < before.total,
    `total line length should drop (${Math.round(before.total)} -> ${Math.round(after.total)})`);
  assert.ok(after.longest <= before.longest * 1.05,
    `the longest line must not grow (${Math.round(before.longest)} -> ${Math.round(after.longest)})`);
});

// --- The two frozen alternatives -----------------------------------------
// They exist to lay a diagram out DIFFERENTLY, so these tests pin the contract
// they share with the compact one rather than any quality threshold: quality is
// the whole point of keeping three, and each one's numbers live in its header.

for (const [name, arrange] of [
  ['1 Columna o 1 Fila (group-layout-axis)', arrangeGroupsSingleAxis],
  ['Minimos Cruces (group-layout-crossings)', arrangeGroupsMinCrossings],
]) {
  test(`${name} honours the shared group-layout contract`, () => {
    const d = buildDiagram();
    d.edgeWaypoints.set('pedido.ref_id->usuario.id', [{ x: -500, y: -500 }]);
    d.edgeAnchors.set('pedido.ref_id->usuario.id', { fromAnchor: { side: 'top', offset: 0.1 }, toAnchor: { side: 'top', offset: 0.1 } });

    const res = arrange(d);

    assert.strictEqual(d.edgeWaypoints.size, 0, 'wipes every stored vertex');
    assert.strictEqual(d.edgeAnchors.size, 0, 'wipes every stored anchor');
    assert.ok(d.snapshots > 0, 'takes a history snapshot so it can be undone');
    assert.strictEqual(res.groups, 4, 'keeps all four groups');
    assert.strictEqual(res.loose, 2, 'reports the ungrouped tables');

    const boxes = d.annotations.filter(a => a.type === 'group');
    assert.strictEqual(boxes.length, 4, 'one box per group, none invented or dropped');

    const byKey = new Map(d.model.tables.map(t => [t.key.toLowerCase(), t]));
    for (const b of boxes) {
      for (const k of b.tables) {
        const t = byKey.get(k);
        assert.ok(t.x >= b.x && t.y >= b.y && t.x + t.w <= b.x + b.w && t.y + t.h <= b.y + b.h,
          `${k} sits inside the ${b.text} box`);
      }
    }
    for (const t of d.model.tables) {
      assert.ok(Number.isFinite(t.x) && Number.isFinite(t.y), `${t.key} got a real position`);
    }
  });
}

test('the three group algorithms really do lay the diagram out differently', () => {
  // If two of them ever converge on the same positions, one has stopped earning
  // its place in the menu and should be dropped rather than quietly duplicated.
  const fingerprint = (arrange) => {
    const d = buildDiagram();
    arrange(d);
    return d.model.tables.map(t => `${t.key}:${t.x},${t.y}`).join('|');
  };
  const prints = [
    fingerprint(arrangeGroupsSingleAxis),
    fingerprint(arrangeGroupsMinCrossings),
    fingerprint(arrangeGroupsCompact),
  ];
  assert.strictEqual(new Set(prints).size, 3, 'all three produce distinct layouts');
});
