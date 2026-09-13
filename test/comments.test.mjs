import test from 'node:test';
import assert from 'node:assert';
import { parseSchema } from '../src/parse.js';
import { commentsOf, commentFor, wrapText, layoutCommentCard, CARD } from '../src/comments.js';
import { exportSVG } from '../src/svg-export.js';

const parse = (src) => parseSchema(src, 'dbml');
const tableOf = (res, name) => res.tables.find(t => t.name === name);
const columns = (t) => t.columns.map(c => c.name);

// --- DBML: where a comment can be written --------------------------------

test('a table comment in the header settings is read', () => {
  const t = tableOf(parse(`Table users [note: 'people who sign in'] {\n  id int [pk]\n}`), 'users');
  assert.ok(t, 'a table with settings on its header is parsed at all');
  assert.strictEqual(t.note, 'people who sign in');
});

test('a table comment written as Note: is read', () => {
  const t = tableOf(parse(`Table users {\n  id int [pk]\n  Note: "people who sign in"\n}`), 'users');
  assert.strictEqual(t.note, 'people who sign in');
});

test('a multi-line table comment keeps its lines and loses the shared indentation', () => {
  const src = [
    'Table users {',
    '  id int [pk]',
    "  Note: '''",
    '    first line',
    '    second line',
    "  '''",
    '}',
  ].join('\n');
  const t = tableOf(parse(src), 'users');
  assert.strictEqual(t.note, 'first line\nsecond line');
  assert.deepStrictEqual(columns(t), ['id'], 'its lines do not become columns');
});

test('a table comment written as a Note block is read', () => {
  const src = ['Table users {', '  id int [pk]', '  Note {', "    'people who sign in'", '  }', '}'].join('\n');
  const t = tableOf(parse(src), 'users');
  assert.strictEqual(t.note, 'people who sign in');
  assert.deepStrictEqual(columns(t), ['id'], 'the block does not become a column');
});

test('a column comment is read from its settings', () => {
  const t = tableOf(parse(`Table users {\n  id int [pk, note: 'the key']\n  email varchar [unique, note: "login name"]\n  name varchar\n}`), 'users');
  const byName = Object.fromEntries(t.columns.map(c => [c.name, c]));
  assert.strictEqual(byName.id.note, 'the key');
  assert.strictEqual(byName.id.pk, true, 'the other settings still apply');
  assert.strictEqual(byName.email.note, 'login name');
  assert.strictEqual(byName.email.unique, true);
  assert.strictEqual(byName.name.note, '', 'no comment means an empty one');
});

// --- the parser problems that were hiding comments -----------------------

test('a // inside a comment is text, not the start of a code comment', () => {
  const res = parse(`Table links {\n  id int [pk]\n  url varchar [note: 'see https://example.com/docs']\n}`);
  const t = tableOf(res, 'links');
  assert.ok(t, 'the table no longer disappears');
  assert.strictEqual(t.columns.find(c => c.name === 'url').note, 'see https://example.com/docs');
});

test('real // and /* */ comments are still ignored', () => {
  const src = ['Table users { // who signs in', '  id int [pk] /* the key */', '  // name varchar', '}'].join('\n');
  const t = tableOf(parse(src), 'users');
  assert.deepStrictEqual(columns(t), ['id']);
});

test('the lines of an indexes block do not become columns', () => {
  const src = ['Table users {', '  id int [pk]', '  email varchar', '  indexes {', '    (id, email) [unique]', '  }', '}'].join('\n');
  assert.deepStrictEqual(columns(tableOf(parse(src), 'users')), ['id', 'email']);
});

test('a column that is simply called note is kept', () => {
  const t = tableOf(parse(`Table posts {\n  id int [pk]\n  note text\n}`), 'posts');
  assert.deepStrictEqual(columns(t), ['id', 'note']);
});

test('relations still resolve around the comments', () => {
  const src = [
    "Table users [note: 'people'] {",
    "  id int [pk, note: 'the key']",
    '}',
    'Table posts {',
    '  id int [pk]',
    "  author_id int [ref: > users.id, note: 'who wrote it']",
    '}',
  ].join('\n');
  const res = parse(src);
  assert.strictEqual(res.relations.length, 1);
  assert.strictEqual(res.relations[0].toTable, 'users');
  assert.strictEqual(tableOf(res, 'posts').columns[1].note, 'who wrote it');
});

// --- what gets shown -----------------------------------------------------

// every character is 6 units wide, whatever the font: easy to reason about
const monospace = (text) => String(text).length * 6;

test('only the comments that exist, and only on the columns on show', () => {
  const table = { name: 'users', note: ' people ', columns: [] };
  const visible = [
    { name: 'id', note: 'the key' },
    { name: 'email', note: '   ' },
    { name: 'name' },
  ];
  assert.deepStrictEqual(commentsOf(table, visible), { note: 'people', columns: [{ name: 'id', note: 'the key' }] });
  assert.strictEqual(commentsOf({ name: 'plain' }, [{ name: 'id' }]), null, 'a table with nothing to say gets no card');
});

test('hover shows just the comment under the pointer', () => {
  const table = { name: 'users', note: 'people' };
  assert.deepStrictEqual(commentFor(table, null), { note: 'people', columns: [] });
  assert.deepStrictEqual(commentFor(table, { name: 'id', note: 'the key' }), { note: '', columns: [{ name: 'id', note: 'the key' }] });
  assert.strictEqual(commentFor(table, { name: 'name', note: '' }), null);
});

test('text wraps inside the card, keeps its own line breaks and cuts long words', () => {
  assert.deepStrictEqual(wrapText('one two three four', 60, monospace), ['one two', 'three four']);
  assert.deepStrictEqual(wrapText('first\nsecond', 600, monospace), ['first', 'second']);
  for (const line of wrapText('https://example.com/a/very/long/path', 60, monospace)) {
    assert.ok(monospace(line) <= 60, `"${line}" fits`);
  }
});

test('a card lists the table comment first, then each column by name', () => {
  const card = layoutCommentCard(
    { note: 'people who sign in', columns: [{ name: 'id', note: 'the key' }] },
    monospace,
  );
  assert.deepStrictEqual(card.lines.map(l => `${l.role}:${l.text}`), ['table:people who sign in', 'column:id', 'text:the key']);
  assert.ok(card.width <= CARD.maxWidth, 'never wider than the maximum');
  assert.ok(card.lines.every((l, i, all) => i === 0 || l.y > all[i - 1].y), 'lines go down the card in order');
  assert.ok(card.height > card.lines[card.lines.length - 1].y, 'the card holds its last line');
});

// --- the SVG export -------------------------------------------------------

const COMMENTED = {
  tables: [
    { name: 'users', key: 'users', x: 50, y: 50, w: 200, h: 86, note: 'people who sign in',
      columns: [{ name: 'id', type: 'bigint', pk: true, note: 'the key' }, { name: 'email', type: 'text', note: '' }] },
  ],
  relations: [],
};
const commentedSVG = (commentsMode) =>
  exportSVG(COMMENTED, 'dark', [], null, 'multi', null, 'curved', null, null, null, 'physical', { commentsMode });

test('the export carries the cards only when they are always shown', () => {
  const always = commentedSVG('always');
  assert.ok(always.includes('>people who sign in<'), 'always: the table comment is in the export');
  assert.ok(always.includes('>the key<'), 'always: and the column comment');
  const widthWith = +/width="(\d+)"/.exec(always)[1];
  assert.ok(widthWith > 200 + 12 + 40, `always: the picture is wide enough for the card (${widthWith})`);

  for (const mode of ['hover', 'hidden']) {
    const svg = commentedSVG(mode);
    assert.ok(!svg.includes('>people who sign in<'), `${mode}: no card, nothing is pointed at in an export`);
    assert.ok(!svg.includes('>the key<'), `${mode}: no column card either`);
    const width = +/width="(\d+)"/.exec(svg)[1];
    assert.ok(width < widthWith, `${mode}: and no room kept for one (${width})`);
  }
});

test('the comment marks never reach an export', () => {
  for (const mode of ['always', 'hover', 'hidden']) {
    assert.strictEqual((commentedSVG(mode).match(/rx="1.6"/g) || []).length, 0, `${mode}: no mark`);
  }
});
