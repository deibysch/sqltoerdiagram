import test from 'node:test';
import assert from 'node:assert';
import { computeLineHops } from '../src/line-hops.js';
import { buildSVGPath, buildOrthogonalPoints, drawRoutePath } from '../src/routing.js';

const horizontal = (key, y, x0 = 0, x1 = 400, routingStyle = 'ortho-sharp') => ({
  key, routingStyle,
  p1: { x: x0, y, nx: 1, ny: 0 },
  p2: { x: x1, y, nx: -1, ny: 0 },
  waypoints: [], obstacles: [],
});

const vertical = (key, x, y0 = 0, y1 = 260, routingStyle = 'ortho-sharp') => ({
  key, routingStyle,
  p1: { x, y: y0, nx: 0, ny: 1 },
  p2: { x, y: y1, nx: 0, ny: -1 },
  waypoints: [], obstacles: [],
});

test('a crossing puts one bridge on the horizontal line and none on the vertical', () => {
  const hops = computeLineHops([horizontal('h', 100), vertical('v', 200)]);
  assert.deepStrictEqual(hops.get('h'), [{ x: 200, y: 100 }]);
  assert.strictEqual(hops.get('v'), undefined, 'the line being crossed stays flat');
});

test('the answer does not depend on which line is listed first', () => {
  const a = computeLineHops([horizontal('h', 100), vertical('v', 200)]);
  const b = computeLineHops([vertical('v', 200), horizontal('h', 100)]);
  assert.deepStrictEqual([...a.entries()], [...b.entries()]);
});

test('only the 90 degree styles get bridges', () => {
  for (const style of ['curved', 'straight']) {
    const hops = computeLineHops([horizontal('h', 100, 0, 400, style), vertical('v', 200, 0, 260, style)]);
    assert.strictEqual(hops.size, 0, `${style} lines cross without a bridge`);
  }
  // and a 90 degree line does not hop over a curved one either
  const mixed = computeLineHops([horizontal('h', 100), vertical('v', 200, 0, 260, 'curved')]);
  assert.strictEqual(mixed.size, 0);
});

test('no bridge lands on top of a corner or an endpoint', () => {
  // the vertical line crosses 5px from where the horizontal one ends
  const nearEnd = computeLineHops([horizontal('h', 100, 0, 400), vertical('v', 395)]);
  assert.strictEqual(nearEnd.size, 0, 'too close to the end of the horizontal run');

  // ... and here it is the vertical line that ends right at the crossing
  const nearOtherEnd = computeLineHops([horizontal('h', 100, 0, 400), vertical('v', 200, 96, 260)]);
  assert.strictEqual(nearOtherEnd.size, 0, 'too close to the end of the vertical run');
});

test('two lines crossing at the same spot still leave a single bridge', () => {
  const hops = computeLineHops([
    horizontal('h', 100),
    vertical('v1', 200, 0, 260),
    vertical('v2', 200, 40, 300),
  ]);
  assert.deepStrictEqual(hops.get('h'), [{ x: 200, y: 100 }]);
});

test('several crossings on one line each get their own bridge', () => {
  const hops = computeLineHops([horizontal('h', 100), vertical('v1', 120), vertical('v2', 300)]);
  assert.deepStrictEqual(hops.get('h').map(p => p.x).sort((a, b) => a - b), [120, 300]);
});

test('the drawn path arcs over the crossing, and stays plain without one', () => {
  const p1 = { x: 0, y: 100, nx: 1, ny: 0 }, p2 = { x: 400, y: 100, nx: -1, ny: 0 };
  const plain = buildSVGPath('ortho-sharp', p1, p2, [], 8, [], 0, null);
  assert.strictEqual(plain, 'M 0 100 L 400 100');

  const hopped = buildSVGPath('ortho-sharp', p1, p2, [], 8, [], 0, [{ x: 200, y: 100 }]);
  assert.ok(hopped.includes('A 6 6 0 0 1 206 100'), `expected a bridge, got ${hopped}`);
  assert.ok(hopped.startsWith('M 0 100 L 194 100'), 'the line runs up to the bridge first');
});

test('a line travelled right to left bridges the other way round', () => {
  const p1 = { x: 400, y: 100, nx: -1, ny: 0 }, p2 = { x: 0, y: 100, nx: 1, ny: 0 };
  const d = buildSVGPath('ortho-sharp', p1, p2, [], 8, [], 0, [{ x: 200, y: 100 }]);
  assert.ok(d.includes('A 6 6 0 0 0 194 100'), `expected the mirrored bridge, got ${d}`);
});

// --- the painter the bridges share with the corners ----------------------

test('a rounded corner never asks for more room than its runs can spare', () => {
  // A short run followed by a 5px jog: arcTo does not clamp the radius itself,
  // so asking for the full 8px used to double the path back and draw a hook.
  const p1 = { x: 863, y: 113, nx: 1, ny: 0 };
  const p2 = { x: 1017, y: 165, nx: 0, ny: -1 };
  const waypoints = [{ x: 874, y: 113 }, { x: 994, y: 118 }];   // runs of 11, 5, 143 and 47px
  const pts = buildOrthogonalPoints(p1, p2, waypoints, []);

  const rounded = [];
  const ctx = {
    moveTo() {}, lineTo() {}, arc() {},
    arcTo(x1, y1, x2, y2, r) { rounded.push({ x: x1, y: y1, r }); },
  };
  drawRoutePath(ctx, 'ortho-rounded', p1, p2, waypoints, 8, [], 0, null);

  assert.ok(rounded.length, 'corners were drawn');
  for (const call of rounded) {
    const i = pts.findIndex(p => Math.abs(p.x - call.x) < 0.01 && Math.abs(p.y - call.y) < 0.01);
    assert.ok(i > 0 && i < pts.length - 1, 'the rounding sits on a real corner');
    const room = Math.min(
      Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y),
      Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)) / 2;
    assert.ok(call.r <= room + 0.001, `corner at ${call.x},${call.y}: radius ${call.r} needs ${room}`);
    assert.ok(call.r > 0, 'a corner that has room still gets rounded');
  }
  assert.ok(rounded.some(c => c.r < 8), 'the tight corner was cut down from the default');
});
