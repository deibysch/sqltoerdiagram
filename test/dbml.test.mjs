// Tests for DBML format parsing (TableGroup / boundaries), serialization, and SVG export.
// Run: node test/dbml.test.mjs
import { parseSchema, detectFormat } from '../src/parse.js';
import { parseDBML } from '../src/formats/dbml.js';
import { toDBML } from '../src/formats/serialize.js';
import { computeGroupBounds, sanitizeAnnotations, resolveGroupColor } from '../src/annotations.js';
import { exportSVG } from '../src/svg-export.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error('  ✗ ' + msg);
  }
};

// --- Format Detection ---
{
  ok(detectFormat('TableGroup Auth { users }') === 'dbml', 'detectFormat: TableGroup recognized as dbml');
  ok(detectFormat('Table users { id int }') === 'dbml', 'detectFormat: Table recognized as dbml');
}

// --- DBML Parsing with TableGroups ---
{
  const dbmlCode = `
Table users {
  id integer [pk]
  username varchar [not null, unique]
  created_at timestamp
}

Table orders {
  id integer [pk]
  user_id integer [ref: > users.id]
  total decimal
}

Table products {
  id integer [pk]
  name varchar
  price decimal
}

Table order_items {
  id integer [pk]
  order_id integer [ref: > orders.id]
  product_id integer [ref: > products.id]
}

TableGroup "User Management" [color: #5aa7ff, note: "User and auth tables"] {
  users
}

TableGroup Ecommerce [color: #27ae60] {
  orders
  order_items
  products
  Note: 'Store tables'
}
`;

  const parsed = parseDBML(dbmlCode);
  ok(parsed.tables.length === 4, `parseDBML: 4 tables parsed (got ${parsed.tables.length})`);
  ok(parsed.relations.length === 3, `parseDBML: 3 relations parsed (got ${parsed.relations.length})`);
  ok(Array.isArray(parsed.groups) && parsed.groups.length === 2, `parseDBML: 2 groups parsed (got ${parsed.groups?.length})`);

  const g1 = parsed.groups[0];
  ok(g1.name === 'User Management', 'Group 1 name is "User Management"');
  ok(g1.color === '#5aa7ff', 'Group 1 color is #5aa7ff');
  ok(g1.note === 'User and auth tables', 'Group 1 note is "User and auth tables"');
  ok(g1.tables.length === 1 && g1.tables[0] === 'users', 'Group 1 contains users table');

  const g2 = parsed.groups[1];
  ok(g2.name === 'Ecommerce', 'Group 2 name is "Ecommerce"');
  ok(g2.color === '#27ae60', 'Group 2 color is #27ae60');
  ok(g2.tables.length === 3 && g2.tables.includes('orders') && g2.tables.includes('products'), 'Group 2 contains ecommerce tables');
}

// --- Group Bounds Calculation ---
{
  const mockTables = [
    { key: 'users', name: 'users', x: 100, y: 100, w: 200, h: 150 },
    { key: 'profiles', name: 'profiles', x: 350, y: 120, w: 180, h: 100 },
    { key: 'orders', name: 'orders', x: 100, y: 400, w: 200, h: 150 },
  ];

  const bounds = computeGroupBounds({ tables: ['users', 'profiles'] }, mockTables, { x: 20, top: 30, bottom: 20 });
  ok(bounds !== null, 'computeGroupBounds returned bounds');
  ok(bounds.x === 80, `bounds.x is 80 (got ${bounds.x})`);
  ok(bounds.y === 70, `bounds.y is 70 (got ${bounds.y})`);
  ok(bounds.w === (530 - 100) + 40, `bounds.w is 470 (got ${bounds.w})`);
  ok(bounds.h === (250 - 100) + 50, `bounds.h is 200 (got ${bounds.h})`);
}

// --- Serialization to DBML with TableGroups ---
{
  const model = {
    tables: [
      { name: 'users', key: 'users', columns: [{ name: 'id', type: 'int', pk: true }] },
      { name: 'orders', key: 'orders', columns: [{ name: 'id', type: 'int', pk: true }, { name: 'user_id', type: 'int', fk: true }] },
    ],
    relations: [
      { fromTable: 'orders', fromCols: ['user_id'], toTable: 'users', toCols: ['id'] },
    ],
    groups: [
      { name: 'Core', color: '#5aa7ff', tables: ['users', 'orders'] },
    ],
  };

  const serialized = toDBML(model);
  ok(serialized.includes('Table "users"'), 'toDBML includes Table "users"');
  ok(serialized.includes('Table "orders"'), 'toDBML includes Table "orders"');
  ok(serialized.includes('Ref: "orders"."user_id" > "users"."id"'), 'toDBML includes Ref');
  ok(serialized.includes('TableGroup "Core"'), 'toDBML includes TableGroup "Core"');
  ok(serialized.includes('"users"') && serialized.includes('"orders"'), 'toDBML includes member tables');
}

// --- Color Resolution and SVG Export ---
{
  ok(resolveGroupColor('blue') === '#5aa7ff', 'resolveGroupColor preset');
  ok(resolveGroupColor('#27ae60') === '#27ae60', 'resolveGroupColor custom hex');

  const model = {
    tables: [{ name: 'users', key: 'users', x: 50, y: 50, w: 100, h: 80, columns: [] }],
    relations: [],
  };
  const annotations = [
    { id: 'g1', type: 'group', x: 30, y: 20, w: 140, h: 130, text: 'Auth Group', color: '#27ae60' },
  ];

  const svg = exportSVG(model, 'dark', annotations);
  ok(svg.includes('<svg'), 'exportSVG produces SVG root');
  ok(svg.includes('Auth Group'), 'exportSVG includes group label');
  ok(svg.includes('#27ae60') || svg.includes('rgba(39,174,96'), 'exportSVG includes custom group color');
}

console.log(`\nDBML tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
