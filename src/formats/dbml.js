// DBML (dbdiagram.io) importer — view-only. Produces the normalized model.
import { makeTable, addColumn, finalize, balanced } from './util.js';

const unq = (s) => {
  s = (s || '').trim();
  if ((s[0] === '"' && s.endsWith('"')) || (s[0] === '`' && s.endsWith('`')) || (s[0] === "'" && s.endsWith("'")))
    return s.slice(1, -1);
  return s;
};
// strip an optional schema qualifier:  public.users -> users
const bare = (s) => {
  s = unq(s);
  const dot = s.lastIndexOf('.');
  return dot >= 0 ? unq(s.slice(dot + 1)) : s;
};
// "a"."b"  ->  ['a','b'] ; a.b -> ['a','b']
function splitRef(ref) {
  const parts = [];
  let cur = '', q = null;
  for (let i = 0; i < ref.length; i++) {
    const c = ref[i];
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === '`') { q = c; continue; }
    if (c === '.') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) parts.push(cur);
  return parts.map((p) => p.trim());
}

export function parseDBML(text) {
  // drop comments
  let t = (text || '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  const tables = [];
  const rels = [];

  // --- Table blocks ---
  const tableRe = /\bTable\b\s+([^\s{]+(?:\s+as\s+\S+)?)\s*\{/gi;
  let m;
  while ((m = tableRe.exec(t))) {
    const headRaw = m[1].replace(/\s+as\s+\S+$/i, '');
    const name = bare(headRaw);
    const b = balanced(t, m.index, '{', '}');
    if (!b) continue;
    const body = t.slice(b[0], b[1]);
    const table = makeTable(name);

    for (let line of body.split('\n')) {
      line = line.trim();
      if (!line) continue;
      // skip nested blocks/notes
      if (/^(Note|indexes|note)\b/i.test(line)) continue;
      if (line === '}' || line.startsWith('}')) continue;
      // settings bracket
      let settings = '';
      const br = line.indexOf('[');
      if (br >= 0 && line.endsWith(']')) { settings = line.slice(br + 1, -1); line = line.slice(0, br).trim(); }
      const parts = line.split(/\s+/);
      if (parts.length < 1) continue;
      const colName = unq(parts[0]);
      if (!colName) continue;
      const type = parts.slice(1).join(' ');
      const lc = settings.toLowerCase();
      const col = {
        name: colName,
        type,
        pk: /\bpk\b|\bprimary key\b/.test(lc),
        nn: /\bnot null\b/.test(lc),
        unique: /\bunique\b/.test(lc),
      };
      addColumn(table, col);
      // inline ref: [ref: > other.col]
      const rm = /ref:\s*([<>-])\s*([^,\]]+)/i.exec(settings);
      if (rm) {
        const dir = rm[1];
        const tgt = splitRef(rm[2].trim());
        if (tgt.length >= 2) {
          const tt = bare(tgt[0]), tc = unq(tgt[tgt.length - 1]);
          if (dir === '<') rels.push({ fromTable: tt, fromCols: [tc], toTable: name, toCols: [colName] });
          else rels.push({ fromTable: name, fromCols: [colName], toTable: tt, toCols: [tc] });
        }
      }
    }
    tables.push(table);
  }

  // --- standalone Ref: a.b > c.d  (optionally "Ref name:") ---
  const refRe = /\bRef\b\s*(?:\w+\s*)?:\s*([^\s]+(?:\.[^\s]+)*)\s*([<>-])\s*([^\s\n;]+)/gi;
  while ((m = refRe.exec(t))) {
    const a = splitRef(m[1]); const dir = m[2]; const b2 = splitRef(m[3]);
    if (a.length < 2 || b2.length < 2) continue;
    const aT = bare(a[0]), aC = unq(a[a.length - 1]);
    const bT = bare(b2[0]), bC = unq(b2[b2.length - 1]);
    if (dir === '<') rels.push({ fromTable: bT, fromCols: [bC], toTable: aT, toCols: [aC] });
    else rels.push({ fromTable: aT, fromCols: [aC], toTable: bT, toCols: [bC] });
  }

  // --- TableGroup blocks: TableGroup name [color: #hex, note: '...'] { table1 table2 } ---
  const groups = [];
  const groupRe = /\bTableGroup\b\s+((?:[^\s{\[]+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`))(?:\s*\[([^\]]*)\])?\s*\{/gi;
  while ((m = groupRe.exec(t))) {
    const rawName = m[1];
    const settingsStr = m[2] || '';
    const name = unq(rawName);
    const b = balanced(t, m.index, '{', '}');
    if (!b) continue;
    const body = t.slice(b[0], b[1]);

    let color = 'blue';
    const colorMatch = /color:\s*['"]?(#[0-9a-fA-F]{3,8}|[a-zA-Z0-9_-]+)['"]?/i.exec(settingsStr);
    if (colorMatch) {
      color = colorMatch[1];
    }
    let note = '';
    const noteMatch = /note:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`|([^,\]]+))/i.exec(settingsStr);
    if (noteMatch) {
      note = (noteMatch[1] || noteMatch[2] || noteMatch[3] || noteMatch[4] || '').trim();
    }

    const memberTables = [];
    for (let line of body.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('//') || line.startsWith('/*')) continue;
      if (/^Note\b/i.test(line)) {
        const nm = /^Note(?:\s*:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)|(?:\s*\{([\s\S]*?)\}))?/i.exec(line);
        if (nm && !note) {
          note = (nm[1] || nm[2] || nm[3] || nm[4] || '').trim();
        }
        continue;
      }
      if (line === '}' || line.startsWith('}')) continue;
      const firstToken = line.split(/\s+/)[0];
      if (firstToken) {
        const tName = bare(firstToken);
        if (tName) memberTables.push(tName);
      }
    }

    groups.push({
      name,
      color,
      note,
      tables: memberTables,
    });
  }

  return finalize(tables, rels, groups);
}

