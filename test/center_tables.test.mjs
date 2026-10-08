import test from 'node:test';
import assert from 'node:assert';
import { Diagram } from '../src/diagram.js';

// Diagram.showTables needs a camera and a view, not a canvas: it runs on a
// stand-in that has just what it reads and calls.
function view({ scale = 0.05, hidden = [] } = {}) {
  const table = (key, x, y, w = 200, h = 300) => ({ key, name: key, x, y, w, h });
  return {
    model: {
      tables: [table('a', 0, 0), table('b', 1000, 0), table('c', 0, 2000), table('far', 9000, 9000)],
      relations: [{ fromTable: 'b', toTable: 'a', fromCols: ['a_id'], toCols: ['id'] }],
    },
    manualLinks: [{ from: { table: 'c', col: 'a_id' }, to: { table: 'a', col: 'id' } }],
    hidden: new Set(hidden),
    cam: { x: 0, y: 0, scale },
    viewW: 1200,
    viewH: 800,
    pinned: null,
    zoomed: null,
    setTableHidden(key, on) { if (on) this.hidden.add(key); else this.hidden.delete(key); },
    _setPin(t) { this.pinned = t.key; },
    markDirty() {},
    onZoom(s) { this.zoomed = s; },
    showTables: Diagram.prototype.showTables,
  };
}

/** Where a table lands on screen, as [left, top, right, bottom]. */
const onScreen = (d, key) => {
  const t = d.model.tables.find(x => x.key === key);
  const { x, y, scale } = d.cam;
  return [t.x * scale + x, t.y * scale + y, (t.x + t.w) * scale + x, (t.y + t.h) * scale + y];
};
const inside = (d, key) => {
  const [l, t, r, b] = onScreen(d, key);
  return l >= 0 && t >= 0 && r <= d.viewW && b <= d.viewH;
};

test('a table is centred at 100%, and pinned so its lines stand out', () => {
  const d = view();
  assert.ok(d.showTables(['a']));
  assert.strictEqual(d.cam.scale, 1);
  const [l, t, r, b] = onScreen(d, 'a');
  assert.deepStrictEqual([(l + r) / 2, (t + b) / 2], [600, 400]);
  assert.strictEqual(d.pinned, 'a');
  assert.strictEqual(d.zoomed, 1, 'the zoom label hears of it');
});

test('a view already closer stays as close while the table fits, and backs off when it does not', () => {
  const d = view({ scale: 1.5 });
  d.showTables(['a']);
  assert.strictEqual(d.cam.scale, 1.5, '300px tall fits 800px at 150%');
  const tall = view({ scale: 3 });
  tall.showTables(['a']);
  assert.ok(tall.cam.scale <= 1 && inside(tall, 'a'));
});

test('with its relations, every table it has a line with comes into the frame, manual links too', () => {
  const d = view();
  d.showTables(['a'], { relations: true });
  for (const key of ['a', 'b', 'c']) assert.ok(inside(d, key), `${key} in view`);
  assert.ok(!inside(d, 'far'), 'a table it has no line with is not framed');
  assert.strictEqual(d.pinned, 'a');
});

test('a hidden table asked for is shown, its hidden relations stay hidden and out of the frame', () => {
  const d = view({ hidden: ['a', 'c'] });
  d.showTables(['a'], { relations: true });
  assert.ok(!d.hidden.has('a'));
  assert.ok(d.hidden.has('c'));
  // a and b alone fit at 90%; with c, 2000px below, it would have taken 30%
  assert.strictEqual(d.cam.scale, 0.9);
});

test('several tables are framed together and none is pinned', () => {
  const d = view();
  d.showTables(['a', 'far']);
  assert.ok(inside(d, 'a') && inside(d, 'far'));
  assert.strictEqual(d.pinned, null);
  assert.strictEqual(view().showTables(['nothing']), false);
});
