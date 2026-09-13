import test from 'node:test';
import assert from 'node:assert';
import {
  multiplicityText,
  cardTexts,
  routePolyline,
  pointAtFraction,
  labelAnchor,
  nearestPosition,
  DEFAULT_NAME_POS,
} from '../src/edge-labels.js';
import { exportSVG } from '../src/svg-export.js';

test('multiplicity is written in UML notation', () => {
  assert.strictEqual(multiplicityText('one'), '1');
  assert.strictEqual(multiplicityText('many'), '1..*');
  assert.strictEqual(multiplicityText('zero-or-one'), '0..1');
  assert.strictEqual(multiplicityText('zero-or-many'), '0..*');
  assert.strictEqual(multiplicityText('nonsense'), '');
});

test('what the user types wins over what the schema says', () => {
  const card = { from: 'many', to: 'one' };
  assert.deepStrictEqual(cardTexts(card, null), { from: '1..*', to: '1' });
  assert.deepStrictEqual(cardTexts(card, { from: '0..5' }), { from: '0..5', to: '1' });
  // blank is not an override: it falls back to the schema
  assert.deepStrictEqual(cardTexts(card, { from: '   ', to: '' }), { from: '1..*', to: '1' });
});

test('a straight line keeps its own points', () => {
  const p1 = { x: 0, y: 0 }, p2 = { x: 100, y: 0 };
  const pts = routePolyline('straight', p1, p2, [{ x: 50, y: 40 }]);
  assert.deepStrictEqual(pts, [{ x: 0, y: 0 }, { x: 50, y: 40 }, { x: 100, y: 0 }]);
});

test('a curve is sampled, and starts and ends on its anchors', () => {
  const p1 = { x: 0, y: 0, nx: 1, ny: 0 }, p2 = { x: 200, y: 100, nx: -1, ny: 0 };
  const pts = routePolyline('curved', p1, p2);
  assert.ok(pts.length > 8, 'sampled into a polyline');
  assert.deepStrictEqual(pts[0], { x: 0, y: 0 });
  assert.deepStrictEqual(pts[pts.length - 1], { x: 200, y: 100 });
});

test('halfway along a line is halfway along its length, not its points', () => {
  // a long leg then a short one: the midpoint by length falls on the long leg
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 120, y: 0 }];
  const mid = pointAtFraction(pts, 0.5);
  assert.strictEqual(Math.round(mid.x), 60);
  assert.strictEqual(Math.round(mid.y), 0);
  assert.deepStrictEqual([mid.tx, mid.ty], [1, 0]);
});

test('a label sits beside the line, not on it', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const above = labelAnchor(pts, { t: 0.5, off: -12 });
  assert.deepStrictEqual([above.x, above.y], [50, -12]);
  const below = labelAnchor(pts, { t: 0.25, off: 20 });
  assert.deepStrictEqual([below.x, below.y], [25, 20]);
  // no stored position means the default one
  const fallback = labelAnchor(pts);
  assert.strictEqual(fallback.y, DEFAULT_NAME_POS.off);
});

test('dragging a label reports the spot it was dropped on', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  const pos = nearestPosition(pts, 100, 70);
  const back = labelAnchor(pts, pos);
  assert.strictEqual(Math.round(back.x), 100);
  assert.strictEqual(Math.round(back.y), 70);

  // and the side is kept: the same spot mirrored lands on the other side
  const left = nearestPosition(pts, 60, -25);
  const right = nearestPosition(pts, 60, 25);
  assert.ok(left.off < 0 && right.off > 0, `sides should differ (${left.off} / ${right.off})`);
  assert.strictEqual(Math.round(labelAnchor(pts, left).y), -25);
  assert.strictEqual(Math.round(labelAnchor(pts, right).y), 25);
});

// --- the SVG export has to draw exactly what the canvas draws -------------

const EXPORT_MODEL = {
  tables: [
    { name: 'users', key: 'users', x: 50, y: 50, w: 200, h: 110,
      columns: [{ name: 'id', type: 'bigint', pk: true }, { name: 'email', type: 'text' }] },
    { name: 'posts', key: 'posts', x: 400, y: 60, w: 200, h: 110,
      columns: [{ name: 'id', type: 'bigint', pk: true }, { name: 'author_id', type: 'bigint', fk: true }] },
  ],
  relations: [{ fromTable: 'posts', fromCols: ['author_id'], toTable: 'users', toCols: ['id'] }],
};
const KEY = 'posts.author_id->users.id';

const buildSVG = (opts) =>
  exportSVG(EXPORT_MODEL, 'dark', [], null, 'multi', null, 'curved', null, null, null, 'physical', opts);

test('the SVG export writes the same multiplicity and name as the canvas', () => {
  const svg = buildSVG({
    edgeCards: new Map([[KEY, { from: '0..5', to: '' }]]),
    edgeNames: new Map([[KEY, 'wrote']]),
    edgeNamePos: new Map([[KEY, { t: 0.5, off: -12 }]]),
    multiplicityMode: 'always',
    relationNamesMode: 'always',
  });
  assert.ok(svg.includes('>0..5<'), 'the end the user typed');
  assert.ok(svg.includes('>0..1<'), 'the end still read from the schema');
  assert.ok(svg.includes('>wrote<'), 'the relation name');
});

test('an export has no pointer, so what shows on hover is exported', () => {
  const hover = buildSVG({
    edgeNames: new Map([[KEY, 'wrote']]),
    multiplicityMode: 'hover',
    relationNamesMode: 'hover',
  });
  assert.ok(hover.includes('>wrote<'), 'the name is in the export');
  assert.ok(hover.includes('>0..1<'), 'and so is the multiplicity');

  const hidden = buildSVG({
    edgeNames: new Map([[KEY, 'wrote']]),
    multiplicityMode: 'hidden',
    relationNamesMode: 'hidden',
  });
  assert.ok(!hidden.includes('>wrote<'), 'hidden names stay out');
  assert.ok(!hidden.includes('0..1'), 'hidden multiplicity stays out');
});

test('turning the connector off drops the crow\'s foot from the SVG', () => {
  const withFoot = buildSVG({});
  const without = buildSVG({ connectorStyle: 'none' });
  assert.ok(without.length < withFoot.length, 'the markers were paths that are now gone');
});

// --- nothing on the lines may cover a table ------------------------------

// A third table parked right where the name would land (measured: 324, 89).
const BLOCKED_MODEL = {
  tables: [
    ...EXPORT_MODEL.tables,
    { name: 'middle', key: 'middle', x: 280, y: 60, w: 120, h: 80, columns: [{ name: 'id', type: 'bigint' }] },
  ],
  relations: EXPORT_MODEL.relations,
};

const buildBlockedSVG = (opts) =>
  exportSVG(BLOCKED_MODEL, 'dark', [], null, 'multi', null, 'curved', null, null, null, 'physical', opts);

test('a name that lands on a table is still exported, on top of it', () => {
  const svg = buildBlockedSVG({
    edgeNames: new Map([[KEY, 'wrote']]),
    relationNamesMode: 'always',
  });
  const name = svg.indexOf('>wrote<');
  assert.ok(name > 0, 'nothing disappears because a table is in the way');
  assert.ok(name > svg.lastIndexOf('<g transform="translate('), 'and it is written over the tables');
});

test('the words are written after the tables, so nothing paints over them', () => {
  const svg = buildSVG({
    edgeNames: new Map([[KEY, 'wrote']]),
    relationNamesMode: 'always',
    multiplicityMode: 'always',
  });
  const lastTable = svg.lastIndexOf('<g transform="translate(');
  assert.ok(lastTable > 0, 'the tables are in there');
  assert.ok(svg.indexOf('>wrote<') > lastTable, 'the name comes after the last table');
  assert.ok(svg.indexOf('>0..1<') > lastTable, 'and so does the multiplicity');
});

test('multiplicity gets a thin border in the theme text colour, names one in the background', () => {
  for (const [themeName, text, bg] of [['dark', '#e8edf4', '#0e1116'], ['light', '#1c2530', '#f4f6fa']]) {
    const svg = exportSVG(EXPORT_MODEL, themeName, [], null, 'multi', null, 'curved', null, null, null, 'physical', {
      edgeNames: new Map([[KEY, 'wrote']]),
      multiplicityMode: 'always',
      relationNamesMode: 'always',
    });
    const tagOf = (content) => {
      const at = svg.indexOf(`>${content}<`);
      return svg.slice(svg.lastIndexOf('<text', at), at);
    };
    assert.ok(tagOf('0..1').includes(`stroke="${text}"`), `${themeName}: the coloured multiplicity is outlined in ${text}`);
    assert.ok(tagOf('0..1').includes('stroke-width="1.25"'), `${themeName}: a border, not a glow`);
    assert.ok(tagOf('0..1').includes('letter-spacing="1"'), `${themeName}: with room between the dots`);
    assert.ok(!tagOf('wrote').includes('letter-spacing'), `${themeName}: names keep their normal spacing`);
    assert.ok(tagOf('wrote').includes(`stroke="${bg}"`), `${themeName}: the name keeps a background-coloured border`);
  }
});
