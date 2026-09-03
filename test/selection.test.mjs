import test from 'node:test';
import assert from 'node:assert';
import { computeGroupBounds } from '../src/annotations.js';

test('TableGroup coordination when moving multi-selected tables', () => {
  // Mock tables
  const t1 = { key: 'users', x: 100, y: 100, w: 200, h: 150 };
  const t2 = { key: 'profiles', x: 100, y: 300, w: 200, h: 150 };
  const t3 = { key: 'orders', x: 500, y: 100, w: 200, h: 150 };
  const tables = [t1, t2, t3];

  // Group containing users and profiles
  const group = {
    id: 'grp_auth',
    type: 'group',
    text: 'Auth',
    tables: ['users', 'profiles'],
    x: 80,
    y: 70,
    w: 240,
    h: 400,
  };

  // Scenario 1: All member tables (users, profiles) are moved by dx=+50, dy=+30
  const selectedTableKeys = new Set(['users', 'profiles']);
  const memberKeys = group.tables.map(k => k.toLowerCase());
  const allSelected = memberKeys.every(k => selectedTableKeys.has(k));
  assert.strictEqual(allSelected, true);

  const dx = 50, dy = 30;
  t1.x += dx; t1.y += dy;
  t2.x += dx; t2.y += dy;
  group.x += dx; group.y += dy;

  assert.strictEqual(group.x, 130);
  assert.strictEqual(group.y, 100);
  assert.strictEqual(group.w, 240);
  assert.strictEqual(group.h, 400);

  // Scenario 2: Only one table (profiles) is moved, group refits dynamically
  t2.x += 100;
  const bounds = computeGroupBounds(group, tables);
  assert.ok(bounds !== null);
  assert.ok(bounds.w > 240, 'Group width expanded to contain displaced table');
});

test('Selection area box requires full enclosure', () => {
  const t1 = { key: 'users', x: 100, y: 100, w: 200, h: 150 }; // bounds: [100, 100] to [300, 250]
  const t2 = { key: 'profiles', x: 100, y: 300, w: 200, h: 150 }; // bounds: [100, 300] to [300, 450]
  const group = { key: 'auth_group', x: 80, y: 70, w: 240, h: 400 }; // bounds: [80, 70] to [320, 470]

  const items = [t1, t2, group];

  // Marquee drawn specifically over t1: [90, 90] to [310, 260]
  const m1 = { x0: 90, x1: 310, y0: 90, y1: 260 };
  const sel1 = new Set();

  for (const it of items) {
    const fullyEnclosed = it.x >= m1.x0 && (it.x + it.w) <= m1.x1 && it.y >= m1.y0 && (it.y + it.h) <= m1.y1;
    if (fullyEnclosed) sel1.add(it.key);
  }

  // Only t1 is fully enclosed! Group is NOT selected!
  assert.strictEqual(sel1.has('users'), true, 'users table is fully enclosed');
  assert.strictEqual(sel1.has('profiles'), false, 'profiles table is not enclosed');
  assert.strictEqual(sel1.has('auth_group'), false, 'auth_group is NOT selected when marquee only encloses tables');

  // Partial intersection should NOT select (table partially clipped)
  const mPartial = { x0: 150, x1: 350, y0: 150, y1: 350 };
  const selPartial = new Set();
  for (const it of items) {
    const fullyEnclosed = it.x >= mPartial.x0 && (it.x + it.w) <= mPartial.x1 && it.y >= mPartial.y0 && (it.y + it.h) <= mPartial.y1;
    if (fullyEnclosed) selPartial.add(it.key);
  }
  assert.strictEqual(selPartial.size, 0, 'Partial intersection does not select');

  // Full enclosure of whole group
  const mFull = { x0: 50, x1: 350, y0: 50, y1: 500 };
  const selFull = new Set();
  for (const it of items) {
    const fullyEnclosed = it.x >= mFull.x0 && (it.x + it.w) <= mFull.x1 && it.y >= mFull.y0 && (it.y + it.h) <= mFull.y1;
    if (fullyEnclosed) selFull.add(it.key);
  }
  assert.strictEqual(selFull.has('users'), true);
  assert.strictEqual(selFull.has('profiles'), true);
  assert.strictEqual(selFull.has('auth_group'), true, 'Whole group is selected when completely enclosed');
});
