import test from 'node:test';
import assert from 'node:assert';
import {
  getDiagramEdges,
  getObstacles,
  organizeLinesSmartFaces,
  organizeLinesPerimeterBus,
  organizeLinesAStar,
  organizeLinesElkPorts,
  organizeLinesClusterHighways,
  resetLines,
} from '../src/line-organizer.js';
import { segmentIntersectsBox, getTableAnchor } from '../src/routing.js';

function createMockDiagram() {
  const tRol = { key: 'rol', name: 'rol', x: 50, y: 150, w: 160, h: 140, columns: [{ name: 'id' }, { name: 'nombre' }] };
  const tPermiso = { key: 'permiso', name: 'permiso', x: 260, y: 150, w: 160, h: 140, columns: [{ name: 'id' }, { name: 'nombre' }] };
  const tRolPermiso = { key: 'rol_permiso', name: 'rol_permiso', x: 470, y: 150, w: 160, h: 140, columns: [{ name: 'id' }, { name: 'rol_id' }, { name: 'permiso_id' }] };

  const relations = [
    // rol.id -> rol_permiso.rol_id (traverses across permiso)
    { fromTable: 'rol', toTable: 'rol_permiso', fromCols: ['id'], toCols: ['rol_id'] },
    // permiso.id -> rol_permiso.permiso_id (direct neighbors)
    { fromTable: 'permiso', toTable: 'rol_permiso', fromCols: ['id'], toCols: ['permiso_id'] },
  ];

  const diagram = {
    model: {
      tables: [tRol, tPermiso, tRolPermiso],
      relations,
    },
    manualLinks: [],
    hidden: new Set(),
    edgeAnchors: new Map(),
    edgeWaypoints: new Map(),
    historySnapshots: [],
    markDirty() { this.dirty = true; },
    onLayoutChange() { this.layoutChanged = true; },
    onHistorySnapshot(s) { this.historySnapshots.push(s); },
    getSnapshot() {
      return {
        edgeAnchors: new Map(this.edgeAnchors),
        edgeWaypoints: new Map(this.edgeWaypoints),
      };
    },
    diagramLevel: 'physical',
  };

  return { diagram, tRol, tPermiso, tRolPermiso };
}

test('getDiagramEdges and getObstacles extract edges and exclude end tables', () => {
  const { diagram } = createMockDiagram();
  const edges = getDiagramEdges(diagram);
  assert.strictEqual(edges.length, 2);

  const edgeRol = edges.find(e => e.fk === 'rol');
  assert.ok(edgeRol, 'Found rol relation');
  assert.strictEqual(edgeRol.tk, 'rol_permiso');

  const obstacles = getObstacles(diagram, 'rol', 'rol_permiso');
  assert.strictEqual(obstacles.length, 1);
  assert.strictEqual(obstacles[0].key, 'permiso', 'permiso is correctly identified as obstacle');
});

test('organizeLinesSmartFaces routes rol -> rol_permiso above permiso avoiding collision', () => {
  const { diagram, tPermiso } = createMockDiagram();
  const edgeKey = 'rol.id->rol_permiso.rol_id';

  // Initially, a direct horizontal line between rol and rol_permiso intersects permiso
  const directP1 = getTableAnchor(diagram.model.tables[0], 'id', diagram.model.tables[2], null, 0, diagram.diagramLevel);
  const directP2 = getTableAnchor(diagram.model.tables[2], 'rol_id', diagram.model.tables[0], null, 0, diagram.diagramLevel);
  const midX = (directP1.x + directP2.x) / 2;
  const directPath = [directP1, { x: midX, y: directP1.y }, { x: midX, y: directP2.y }, directP2];

  let directHitsPermiso = false;
  for (let i = 0; i < directPath.length - 1; i++) {
    if (segmentIntersectsBox(directPath[i], directPath[i + 1], tPermiso, 8).hit) {
      directHitsPermiso = true;
      break;
    }
  }
  assert.strictEqual(directHitsPermiso, true, 'Direct path without smart faces cuts through permiso');

  // Run Smart Faces algorithm
  const modifiedCount = organizeLinesSmartFaces(diagram);
  assert.strictEqual(modifiedCount, 1, 'Only the blocked edge was rerouted; clean direct edge was preserved');

  assert.ok(diagram.edgeAnchors.has(edgeKey), 'edgeAnchors set for rol -> rol_permiso');
  assert.ok(diagram.edgeWaypoints.has(edgeKey), 'edgeWaypoints set for rol -> rol_permiso');

  const anchors = diagram.edgeAnchors.get(edgeKey);
  assert.strictEqual(anchors.fromAnchor.side, 'top', 'Switched to top face');
  assert.strictEqual(anchors.toAnchor.side, 'top', 'Switched to top face');

  const waypoints = diagram.edgeWaypoints.get(edgeKey);
  assert.ok(waypoints.length >= 2, 'Has waypoints in top corridor');

  // Verify none of the rerouted segments intersect permiso
  const p1 = getTableAnchor(diagram.model.tables[0], 'id', null, anchors.fromAnchor, 0, diagram.diagramLevel);
  const p2 = getTableAnchor(diagram.model.tables[2], 'rol_id', null, anchors.toAnchor, 0, diagram.diagramLevel);
  const fullRoutedPath = [p1, ...waypoints, p2];

  for (let i = 0; i < fullRoutedPath.length - 1; i++) {
    const hit = segmentIntersectsBox(fullRoutedPath[i], fullRoutedPath[i + 1], tPermiso, 4).hit;
    assert.strictEqual(hit, false, `Segment ${i} must NOT intersect permiso`);
  }
  assert.ok(diagram.historySnapshots.length > 0, 'Saved history snapshot for undo/redo');
});

test('organizeLinesPerimeterBus routes cross-table lines via outer channel', () => {
  const { diagram, tPermiso } = createMockDiagram();
  const edgeKey = 'rol.id->rol_permiso.rol_id';

  const modifiedCount = organizeLinesPerimeterBus(diagram);
  assert.strictEqual(modifiedCount, 1);

  assert.ok(diagram.edgeWaypoints.has(edgeKey));
  const waypoints = diagram.edgeWaypoints.get(edgeKey);
  assert.ok(waypoints.length >= 2);

  // All waypoints must be well above or below the tables
  for (const wp of waypoints) {
    const isAboveOrBelow = wp.y < tPermiso.y || wp.y > (tPermiso.y + tPermiso.h);
    assert.ok(isAboveOrBelow, `Waypoint y=${wp.y} is outside table bounds`);
  }
});

test('organizeLinesAStar finds collision-free orthogonal path on grid', () => {
  const { diagram, tPermiso } = createMockDiagram();
  const edgeKey = 'rol.id->rol_permiso.rol_id';

  const count = organizeLinesAStar(diagram);
  assert.strictEqual(count, 1, 'Rerouted blocked edge using A*');

  assert.ok(diagram.edgeWaypoints.has(edgeKey));
  const waypoints = diagram.edgeWaypoints.get(edgeKey);
  assert.ok(waypoints.length > 0, 'A* generated waypoints');

  const p1 = getTableAnchor(diagram.model.tables[0], 'id', diagram.model.tables[2], null, 0, diagram.diagramLevel);
  const p2 = getTableAnchor(diagram.model.tables[2], 'rol_id', diagram.model.tables[0], null, 0, diagram.diagramLevel);
  const fullPath = [p1, ...waypoints, p2];

  for (let i = 0; i < fullPath.length - 1; i++) {
    const hit = segmentIntersectsBox(fullPath[i], fullPath[i + 1], tPermiso, 4).hit;
    assert.strictEqual(hit, false, `A* Segment ${i} must not intersect permiso`);
  }
});

test('resetLines restores direct lines and clears waypoints and custom anchors', () => {
  const { diagram } = createMockDiagram();
  const edgeKey = 'rol.id->rol_permiso.rol_id';

  organizeLinesSmartFaces(diagram);
  assert.ok(diagram.edgeAnchors.has(edgeKey));
  assert.ok(diagram.edgeWaypoints.has(edgeKey));

  const resetCount = resetLines(diagram);
  assert.strictEqual(resetCount, 1);
  assert.strictEqual(diagram.edgeAnchors.has(edgeKey), false);
  assert.strictEqual(diagram.edgeWaypoints.has(edgeKey), false);
});

test('organizeLinesElkPorts sorts ports monotonically preventing border crossings', () => {
  // Table "hub" connects to 3 targets at different heights on the right
  const tHub = { key: 'hub', name: 'hub', x: 100, y: 300, w: 160, h: 200, columns: [{ name: 'id' }] };
  const tTop = { key: 't_top', name: 't_top', x: 500, y: 100, w: 160, h: 100, columns: [{ name: 'id' }, { name: 'hub_id' }] };
  const tMid = { key: 't_mid', name: 't_mid', x: 500, y: 350, w: 160, h: 100, columns: [{ name: 'id' }, { name: 'hub_id' }] };
  const tBot = { key: 't_bot', name: 't_bot', x: 500, y: 700, w: 160, h: 100, columns: [{ name: 'id' }, { name: 'hub_id' }] };

  const relations = [
    // Deliberately inserted in reverse order: bot, mid, top
    { fromTable: 't_bot', toTable: 'hub', fromCols: ['hub_id'], toCols: ['id'] },
    { fromTable: 't_mid', toTable: 'hub', fromCols: ['hub_id'], toCols: ['id'] },
    { fromTable: 't_top', toTable: 'hub', fromCols: ['hub_id'], toCols: ['id'] },
  ];

  const diagram = {
    model: { tables: [tHub, tTop, tMid, tBot], relations },
    manualLinks: [],
    hidden: new Set(),
    edgeAnchors: new Map(),
    edgeWaypoints: new Map(),
    markDirty() {},
    onLayoutChange() {},
    diagramLevel: 'physical',
  };

  const count = organizeLinesElkPorts(diagram);
  assert.strictEqual(count, 3);

  // Check the toAnchors at "hub" on the right side:
  const aTop = diagram.edgeAnchors.get('t_top.hub_id->hub.id').toAnchor;
  const aMid = diagram.edgeAnchors.get('t_mid.hub_id->hub.id').toAnchor;
  const aBot = diagram.edgeAnchors.get('t_bot.hub_id->hub.id').toAnchor;

  assert.strictEqual(aTop.side, 'right');
  assert.strictEqual(aMid.side, 'right');
  assert.strictEqual(aBot.side, 'right');

  // Because t_top (y=100) < t_mid (y=350) < t_bot (y=700),
  // their offsets on the right face of hub must be strictly ascending (no line crossing!)
  assert.ok(aTop.offset < aMid.offset, `aTop (${aTop.offset}) must be less than aMid (${aMid.offset})`);
  assert.ok(aMid.offset < aBot.offset, `aMid (${aMid.offset}) must be less than aBot (${aBot.offset})`);
});

test('organizeLinesElkPorts routes blocked lines via channel avoiding intermediate tables', () => {
  const { diagram, tPermiso } = createMockDiagram();
  const edgeKey = 'rol.id->rol_permiso.rol_id';

  const count = organizeLinesElkPorts(diagram);
  assert.strictEqual(count, 2, 'Organized both lines');

  assert.ok(diagram.edgeAnchors.has(edgeKey));
  assert.ok(diagram.edgeWaypoints.has(edgeKey));

  const anchors = diagram.edgeAnchors.get(edgeKey);
  assert.strictEqual(anchors.fromAnchor.side, 'top');
  assert.strictEqual(anchors.toAnchor.side, 'top');

  const waypoints = diagram.edgeWaypoints.get(edgeKey);
  const p1 = getTableAnchor(diagram.model.tables[0], 'id', null, anchors.fromAnchor, 0, diagram.diagramLevel);
  const p2 = getTableAnchor(diagram.model.tables[2], 'rol_id', null, anchors.toAnchor, 0, diagram.diagramLevel);
  const fullPath = [p1, ...waypoints, p2];

  for (let i = 0; i < fullPath.length - 1; i++) {
    const hit = segmentIntersectsBox(fullPath[i], fullPath[i + 1], tPermiso, 4).hit;
    assert.strictEqual(hit, false, `ELK channel segment ${i} must not intersect permiso`);
  }
});

test('organizeLinesClusterHighways routes inter-cluster edge via highway outside foreign groups (OGDF Fig. 15.14)', () => {
  // Setup 3 domain clusters matching OGDF Fig 15.14: Red (left), Green (middle), Blue (right)
  const tRed = { key: 'order_entry', name: 'order_entry', x: 100, y: 300, w: 160, h: 140, columns: [{ name: 'id' }] };
  const tGreen1 = { key: 'inventory_main', name: 'inventory_main', x: 400, y: 300, w: 160, h: 140, columns: [{ name: 'id' }] };
  const tGreen2 = { key: 'inventory_sub', name: 'inventory_sub', x: 400, y: 500, w: 160, h: 140, columns: [{ name: 'id' }, { name: 'main_id' }] };
  const tBlue = { key: 'accounts', name: 'accounts', x: 700, y: 300, w: 160, h: 140, columns: [{ name: 'id' }, { name: 'order_id' }] };

  const relations = [
    // Inter-cluster: Red -> Blue (must cross around Green without entering Green!)
    { fromTable: 'order_entry', toTable: 'accounts', fromCols: ['id'], toCols: ['order_id'] },
    // Intra-cluster: Green2 -> Green1 (local inside Green)
    { fromTable: 'inventory_sub', toTable: 'inventory_main', fromCols: ['main_id'], toCols: ['id'] },
  ];

  const annotations = [
    { type: 'group', text: 'Order Entry', color: '#ff4444', tables: ['order_entry'], x: 80, y: 280, w: 200, h: 180 },
    { type: 'group', text: 'Inventory', color: '#44ff44', tables: ['inventory_main', 'inventory_sub'], x: 380, y: 280, w: 200, h: 380 },
    { type: 'group', text: 'Accounts', color: '#4444ff', tables: ['accounts'], x: 680, y: 280, w: 200, h: 180 },
  ];

  const diagram = {
    model: {
      tables: [tRed, tGreen1, tGreen2, tBlue],
      relations,
    },
    annotations,
    manualLinks: [],
    hidden: new Set(),
    edgeAnchors: new Map(),
    edgeWaypoints: new Map(),
    markDirty() {},
    onLayoutChange() {},
    diagramLevel: 'physical',
  };

  const count = organizeLinesClusterHighways(diagram);
  assert.strictEqual(count, 2, 'Organized both inter-cluster and intra-cluster edges');

  // Check inter-cluster connection: order_entry -> accounts
  const interKey = 'order_entry.id->accounts.order_id';
  assert.ok(diagram.edgeWaypoints.has(interKey), 'Inter-cluster edge has highway waypoints');

  const waypoints = diagram.edgeWaypoints.get(interKey);
  const anchors = diagram.edgeAnchors.get(interKey);
  const p1 = getTableAnchor(tRed, 'id', null, anchors.fromAnchor, 0, diagram.diagramLevel);
  const p2 = getTableAnchor(tBlue, 'order_id', null, anchors.toAnchor, 0, diagram.diagramLevel);
  const fullPath = [p1, ...waypoints, p2];

  // Verify that NONE of the segments in fullPath intersect the intermediate "Inventory" group box
  const greenGroupBox = annotations[1]; // x: 380, y: 280, w: 200, h: 380
  for (let i = 0; i < fullPath.length - 1; i++) {
    const hit = segmentIntersectsBox(fullPath[i], fullPath[i + 1], greenGroupBox, 6).hit;
    assert.strictEqual(hit, false, `Highway segment ${i} must NOT intersect intermediate Inventory group`);
  }

  // Check intra-cluster connection: inventory_sub -> inventory_main
  const intraKey = 'inventory_sub.main_id->inventory_main.id';
  // If there are waypoints or not, they must stay strictly inside or adjacent to the Inventory group
  if (diagram.edgeWaypoints.has(intraKey)) {
    for (const wp of diagram.edgeWaypoints.get(intraKey)) {
      assert.ok(wp.x >= greenGroupBox.x && wp.x <= (greenGroupBox.x + greenGroupBox.w), 'Intra-cluster waypoint X is within group');
    }
  }
});


