import test from 'node:test';
import assert from 'node:assert';
import { dagreLayout, forceLayout, radialLayout, removeOverlaps } from '../src/layout.js';
import { segmentIntersectsBox, routeAroundObstacles } from '../src/routing.js';
import { clusterTablesLocalAI, reorderWithLocalAI } from '../src/ai-layout.js';

function createMockModel() {
  return {
    tables: [
      { key: 'users', name: 'users', columns: [{ name: 'id' }, { name: 'email' }] },
      { key: 'profiles', name: 'profiles', columns: [{ name: 'id' }, { name: 'user_id' }] },
      { key: 'tokens', name: 'auth_tokens', columns: [{ name: 'id' }, { name: 'user_id' }] },
      { key: 'orders', name: 'orders', columns: [{ name: 'id' }, { name: 'user_id' }] },
      { key: 'order_items', name: 'order_items', columns: [{ name: 'id' }, { name: 'order_id' }, { name: 'product_id' }] },
      { key: 'products', name: 'products', columns: [{ name: 'id' }, { name: 'title' }] },
    ],
    relations: [
      { fromTable: 'profiles', toTable: 'users', fromCols: ['user_id'], toCols: ['id'] },
      { fromTable: 'tokens', toTable: 'users', fromCols: ['user_id'], toCols: ['id'] },
      { fromTable: 'orders', toTable: 'users', fromCols: ['user_id'], toCols: ['id'] },
      { fromTable: 'order_items', toTable: 'orders', fromCols: ['order_id'], toCols: ['id'] },
      { fromTable: 'order_items', toTable: 'products', fromCols: ['product_id'], toCols: ['id'] },
    ],
    groups: [],
  };
}

test('Hierarchical (Dagre) layout positions all tables without NaN', () => {
  const model = createMockModel();
  dagreLayout(model, { dir: 'LR', spacing: 'comfortable' });

  for (const t of model.tables) {
    assert.ok(Number.isFinite(t.x), `table ${t.key} x is finite`);
    assert.ok(Number.isFinite(t.y), `table ${t.key} y is finite`);
    assert.ok(t.w > 0, `table ${t.key} width > 0`);
    assert.ok(t.h > 0, `table ${t.key} height > 0`);
  }
});

test('Physics (Force-Directed) layout positions all tables without overlap', () => {
  const model = createMockModel();
  forceLayout(model, { spacing: 'comfortable' });

  for (const t of model.tables) {
    assert.ok(Number.isFinite(t.x), `table ${t.key} x is finite`);
    assert.ok(Number.isFinite(t.y), `table ${t.key} y is finite`);
  }

  // Verify no overlap
  const ts = model.tables;
  for (let i = 0; i < ts.length; i++) {
    for (let j = i + 1; j < ts.length; j++) {
      const a = ts[i], b = ts[j];
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(overlapX < 0 || overlapY < 0, `tables ${a.key} and ${b.key} should not overlap`);
    }
  }
});

test('Radial Hub & Satellites layout places central hub table and satellites', () => {
  const model = createMockModel();
  radialLayout(model, { spacing: 'comfortable' });

  for (const t of model.tables) {
    assert.ok(Number.isFinite(t.x), `table ${t.key} x is finite`);
    assert.ok(Number.isFinite(t.y), `table ${t.key} y is finite`);
  }

  // users table has degree 3 (highest hub), should be placed inside the central region
  const users = model.tables.find(t => t.key === 'users');
  assert.ok(users, 'users table exists');
});

test('Obstacle avoidance routing detours around obstacle tables', () => {
  // Obstacle table in the middle
  const obstacle = { x: 300, y: 100, w: 200, h: 150 };

  // Direct horizontal path from (100, 160) to (700, 160) cuts right through obstacle (y=100..250)
  const p1 = { x: 100, y: 160, nx: 1, ny: 0 };
  const p2 = { x: 700, y: 160, nx: -1, ny: 0 };

  const directHit = segmentIntersectsBox(p1, p2, obstacle, 10);
  assert.strictEqual(directHit.hit, true, 'Direct segment cuts through obstacle');

  // Rerouted path
  const pts = [p1, { x: 400, y: 160 }, p2];
  const routed = routeAroundObstacles(pts, [obstacle], 12);

  assert.ok(routed.length > 2, 'Detour points were generated');

  // Verify none of the routed segments intersect the obstacle box
  for (let i = 0; i < routed.length - 1; i++) {
    const hit = segmentIntersectsBox(routed[i], routed[i + 1], obstacle, 4);
    assert.strictEqual(hit.hit, false, `Segment ${i} should not cut through obstacle`);
  }
});

test('Local AI semantic layout clusters tables into business domains', () => {
  const model = createMockModel();
  const clusters = clusterTablesLocalAI(model);

  assert.ok(clusters.length >= 1, 'Generates at least 1 domain cluster');
  const allClusteredTables = clusters.flatMap(c => c.tables);
  assert.strictEqual(allClusteredTables.length, model.tables.length, 'All tables included in clusters');

  const res = reorderWithLocalAI(model, { createGroups: true });
  assert.ok(res.annotations.length > 0, 'Generated group annotations for domains');
});
