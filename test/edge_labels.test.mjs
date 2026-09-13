import test from 'node:test';
import assert from 'node:assert';
import {
  multiplicityText,
  cardTexts,
  routePolyline,
  pointAtFraction,
  labelAnchor,
  nearestPosition,
  readableOn,
  contrastRatio,
  multiplicityPaint,
  isDarkCanvas,
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

// --- multiplicity that can be read on either theme ------------------------

const DARK = { bg: '#0e1116', headerText: '#e8edf4' };
const LIGHT = { bg: '#f4f6fa', headerText: '#1c2530' };
const rgb = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

test('a colour that already reads is left alone', () => {
  assert.strictEqual(readableOn('#06d6a0', DARK.bg, 6), '#06d6a0');
  assert.strictEqual(readableOn('#1c2530', LIGHT.bg, 6), '#1c2530');
});

test('a dim colour on a dark canvas is lightened just enough, not to white', () => {
  const grey = readableOn('#5d6b7d', DARK.bg, 6);   // the single-colour grey
  const ratio = contrastRatio(grey, DARK.bg);
  assert.ok(ratio >= 6, `reads now (${ratio.toFixed(2)})`);
  assert.ok(ratio < 6.5, `but no brighter than it has to be (${ratio.toFixed(2)})`);

  const orchid = rgb(readableOn('#b5179e', DARK.bg, 6));
  assert.ok(contrastRatio(readableOn('#b5179e', DARK.bg, 6), DARK.bg) >= 6);
  assert.ok(orchid[0] > orchid[1] && orchid[2] > orchid[1], `still an orchid, not a grey (${orchid})`);
});

test('a pale colour on a light canvas is darkened instead', () => {
  const amber = readableOn('#ffd166', LIGHT.bg, 4.5);
  assert.ok(contrastRatio(amber, LIGHT.bg) >= 4.5);
  assert.ok(rgb(amber).every((v, i) => v <= rgb('#ffd166')[i]), `darker on every channel (${amber})`);
});

test('what is not a hex colour comes back as it was', () => {
  assert.strictEqual(readableOn('rebeccapurple', DARK.bg, 6), 'rebeccapurple');
  assert.strictEqual(contrastRatio('rgb(0,0,0)', DARK.bg), null);
});

test('a canvas is dark when white stands out on it more than black', () => {
  assert.strictEqual(isDarkCanvas(DARK), true);
  assert.strictEqual(isDarkCanvas(LIGHT), false);
  assert.strictEqual(isDarkCanvas({ bg: 'not a colour' }), false);
});

test('light canvas: the line colour with a thin dark border', () => {
  assert.deepStrictEqual(multiplicityPaint('#ffd166', LIGHT), { fill: '#ffd166', outline: '#1c2530', width: 1.25, weight: 400 });
});

test('dark canvas: a readable shade of the line colour, bordered in the canvas colour', () => {
  // a light border there made the letters read as white
  const paint = multiplicityPaint('#5d6b7d', DARK);
  assert.strictEqual(paint.outline, DARK.bg);
  assert.strictEqual(paint.weight, 600, 'a touch bolder, since nothing outlines it');
  assert.ok(contrastRatio(paint.fill, DARK.bg) >= 6);
  assert.strictEqual(multiplicityPaint('#06d6a0', DARK).fill, '#06d6a0', 'a bright colour keeps its exact shade');
});

test('the export paints the multiplicity as the canvas does, names keep a background border', () => {
  for (const [themeName, theme] of [['dark', DARK], ['light', LIGHT]]) {
    const svg = exportSVG(EXPORT_MODEL, themeName, [], null, 'multi', null, 'curved', null, null, null, 'physical', {
      edgeNames: new Map([[KEY, 'wrote']]),
      multiplicityMode: 'always',
      relationNamesMode: 'always',
    });
    const tagOf = (content) => {
      const at = svg.indexOf(`>${content}<`);
      return svg.slice(svg.lastIndexOf('<text', at), at);
    };
    const card = tagOf('0..1');
    const fill = /fill="(#[0-9a-f]{6})"/i.exec(card)[1];
    const paint = multiplicityPaint(fill, theme);
    assert.ok(card.includes(`stroke="${paint.outline}"`), `${themeName}: bordered in ${paint.outline}`);
    assert.ok(card.includes(`font-weight="${paint.weight}"`), `${themeName}: weight ${paint.weight}`);
    assert.ok(card.includes('stroke-width="1.25"'), `${themeName}: a border, not a glow`);
    assert.ok(card.includes('letter-spacing="1"'), `${themeName}: with room between the dots`);
    if (themeName === 'dark') assert.ok(contrastRatio(fill, theme.bg) >= 6, `dark: the fill reads (${fill})`);
    assert.ok(!tagOf('wrote').includes('letter-spacing'), `${themeName}: names keep their normal spacing`);
    assert.ok(tagOf('wrote').includes(`stroke="${theme.bg}"`), `${themeName}: the name keeps a background-coloured border`);
  }
});
