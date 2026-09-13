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

// Blank out // and /* */ comments with spaces, keeping every character offset
// and every line break where it was. Never inside a string: a note such as
// 'see https://example.com' used to lose its tail, and the quote left open made
// the whole table disappear.
function blankComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (src.startsWith("'''", i)) {
      const end = src.indexOf("'''", i + 3);
      const stop = end < 0 ? src.length : end + 3;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      const stop = Math.min(src.length, j + 1);
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = src.length;
      out += ' '.repeat(j - i);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? src.length : j + 2;
      out += src.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// A multi-line ''' string drops the line breaks that open and close it and the
// indentation its lines share, as dbdiagram.io does.
function dedent(raw) {
  const lines = raw.split('\n');
  if (lines.length && !lines[0].trim()) lines.shift();
  if (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indent = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^[ \t]*/)[0].length), Infinity);
  return lines.map(l => (Number.isFinite(indent) ? l.slice(indent) : l)).join('\n').trimEnd();
}

/** The string literal starting at `i` (spaces allowed before it), or null. */
function readString(src, i) {
  while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
  if (src.startsWith("'''", i)) {
    const end = src.indexOf("'''", i + 3);
    if (end < 0) return null;
    return { value: dedent(src.slice(i + 3, end)), end: end + 3 };
  }
  const q = src[i];
  if (q !== "'" && q !== '"') return null;
  let j = i + 1, value = '';
  while (j < src.length && src[j] !== q && src[j] !== '\n') {
    if (src[j] === '\\' && j + 1 < src.length) { value += src[j + 1]; j += 2; continue; }
    value += src[j];
    j++;
  }
  if (src[j] !== q) return null;
  return { value, end: j + 1 };
}

/** `note: '...'` out of a settings list such as `pk, note: 'the id'`. */
function noteFromSettings(settings) {
  const m = /\bnote\s*:/i.exec(settings || '');
  if (!m) return '';
  const s = readString(settings, m.index + m[0].length);
  return s ? s.value : '';
}

function findIdentifierSpan(str, ident, baseOffset) {
  if (!str || !ident) return [baseOffset, baseOffset + (str ? str.length : 0)];
  const idx = str.lastIndexOf(ident);
  if (idx >= 0) return [baseOffset + idx, baseOffset + idx + ident.length];
  return [baseOffset, baseOffset + str.length];
}

export function parseDBML(text) {
  // replace comments with spaces of equal length so character offsets are 100% preserved
  let t = blankComments(text || '');
  const tables = [];
  const rels = [];

  // --- Table blocks ---
  // Settings may sit between the name and the brace: Table users [note: '...'] {
  const tableRe = /\bTable\b\s+([^\s{[]+(?:\s+as\s+[^\s{[]+)?)\s*(\[[^\]]*\])?\s*\{/gi;
  let m;
  while ((m = tableRe.exec(t))) {
    const rawHead = m[1];
    const headRaw = rawHead.replace(/\s+as\s+\S+$/i, '');
    const name = bare(headRaw);
    const b = balanced(t, m.index, '{', '}');
    if (!b) continue;
    const body = t.slice(b[0], b[1]);
    const table = makeTable(name);

    // The table's comment can come in three spellings: a setting on the header,
    // `Note: '...'` (or a ''' multi-line string) and a `Note { '...' }` block.
    // Notes and index blocks are blanked out of the copy the columns are read
    // from, so none of their lines turns into a bogus column.
    table.note = noteFromSettings(m[2] ? m[2].slice(1, -1) : '');
    let scan = body;
    const blankOut = (from, to) => {
      scan = scan.slice(0, from) + scan.slice(from, to).replace(/[^\n]/g, ' ') + scan.slice(to);
    };
    const nestedRe = /(^|\n)([ \t]*)(note|indexes)\b\s*(:|\{)/gi;
    let nm;
    while ((nm = nestedRe.exec(body))) {
      const keywordAt = nm.index + nm[1].length + nm[2].length;
      const after = nm.index + nm[0].length;
      const isNote = nm[3].toLowerCase() === 'note';
      if (nm[4] === ':') {
        if (!isNote) continue;
        const str = readString(body, after);
        if (str) { table.note = str.value; blankOut(keywordAt, str.end); }
        continue;
      }
      const blk = balanced(body, after - 1, '{', '}');
      if (!blk) continue;
      if (isNote) {
        let k = blk[0];
        while (k < blk[1] && /\s/.test(body[k])) k++;
        const str = readString(body, k);
        if (str) table.note = str.value;
      }
      blankOut(keywordAt, blk[2]);
      nestedRe.lastIndex = blk[2];
    }

    // Spans for table
    const headOffset = m[0].indexOf(rawHead);
    const headStart = m.index + headOffset;
    table.nameSpan = findIdentifierSpan(headRaw, name, headStart);
    table.bodySpan = [b[0], b[1]];
    table.stmtSpan = [m.index, b[1] + 1];

    // Scan lines in body preserving offsets
    let lineStart = 0;
    while (lineStart < scan.length) {
      let lineEnd = scan.indexOf('\n', lineStart);
      if (lineEnd < 0) lineEnd = scan.length;
      const rawLine = scan.slice(lineStart, lineEnd);
      const absLineStart = b[0] + lineStart;
      const absLineEnd = b[0] + lineEnd;

      const leadSpaces = rawLine.search(/\S/);
      if (leadSpaces >= 0) {
        const trimmed = rawLine.trim();
        const contentStart = absLineStart + leadSpaces;
        const contentEnd = contentStart + trimmed.length;

        // skip nested blocks/notes or closing brace
        // Notes and index blocks were blanked above. This only catches one too
        // broken to read, and no longer swallows a column simply called `note`.
        if (!/^(note|indexes)\b\s*(:|\{)/i.test(trimmed) && trimmed !== '}' && !trimmed.startsWith('}')) {
          let settings = '';
          let settingsSpan = null;
          const br = trimmed.indexOf('[');
          let beforeBracket = trimmed;
          if (br >= 0 && trimmed.endsWith(']')) {
            settings = trimmed.slice(br + 1, -1);
            settingsSpan = [contentStart + br, contentEnd];
            beforeBracket = trimmed.slice(0, br).trim();
          }

          const parts = beforeBracket.split(/\s+/);
          if (parts.length >= 1) {
            const rawColName = parts[0];
            const colName = unq(rawColName);
            if (colName) {
              const colNameOffset = beforeBracket.indexOf(rawColName);
              const colNameSpan = findIdentifierSpan(rawColName, colName, contentStart + colNameOffset);
              const rest = beforeBracket.slice(colNameOffset + rawColName.length).trim();
              let typeSpan = null;
              let type = '';
              if (rest) {
                const typeOffset = beforeBracket.indexOf(rest, colNameOffset + rawColName.length);
                typeSpan = [contentStart + typeOffset, contentStart + typeOffset + rest.length];
                type = rest;
              }

              const lc = settings.toLowerCase();
              const col = {
                name: colName,
                type,
                pk: /\bpk\b|\bprimary key\b/.test(lc),
                nn: /\bnot null\b/.test(lc),
                unique: /\bunique\b/.test(lc),
                nameSpan: colNameSpan,
                typeSpan,
                defSpan: [absLineStart, absLineEnd],
                settingsSpan,
                note: noteFromSettings(settings),
              };
              addColumn(table, col);

              // inline ref: [ref: > other.col]
              const rm = /ref:\s*([<>-])\s*([^,\]]+)/i.exec(settings);
              if (rm) {
                const dir = rm[1];
                const rawTgt = rm[2].trim();
                const tgt = splitRef(rawTgt);
                if (tgt.length >= 2) {
                  const tt = bare(tgt[0]), tc = unq(tgt[tgt.length - 1]);
                  const refContentOffset = settingsSpan[0] + 1 + rm.index + rm[0].indexOf(rawTgt);
                  const refSpan = [refContentOffset, refContentOffset + rawTgt.length];
                  const tgtTableOffset = rawTgt.indexOf(tgt[0]);
                  const tgtTableSpan = findIdentifierSpan(tgt[0], tt, refContentOffset + tgtTableOffset);
                  const tgtColOffset = rawTgt.lastIndexOf(tgt[tgt.length - 1]);
                  const tgtColSpan = findIdentifierSpan(tgt[tgt.length - 1], tc, refContentOffset + tgtColOffset);

                  if (dir === '<') {
                    rels.push({
                      fromTable: tt, fromCols: [tc], toTable: name, toCols: [colName],
                      refSpan,
                      fromTableSpan: tgtTableSpan, fromColSpan: tgtColSpan,
                      toTableSpan: table.nameSpan, toColSpan: colNameSpan
                    });
                  } else {
                    rels.push({
                      fromTable: name, fromCols: [colName], toTable: tt, toCols: [tc],
                      refSpan,
                      fromTableSpan: table.nameSpan, fromColSpan: colNameSpan,
                      toTableSpan: tgtTableSpan, toColSpan: tgtColSpan
                    });
                  }
                }
              }
            }
          }
        }
      }

      lineStart = lineEnd + 1;
    }

    tables.push(table);
  }

  // --- standalone Ref: a.b > c.d  (optionally "Ref name:") ---
  const refRe = /\bRef\b\s*(?:\w+\s*)?:\s*([^\s]+(?:\.[^\s]+)*)\s*([<>-])\s*([^\s\n;]+)/gi;
  while ((m = refRe.exec(t))) {
    const rawA = m[1];
    const dir = m[2];
    const rawB = m[3];
    const a = splitRef(rawA);
    const b2 = splitRef(rawB);
    if (a.length < 2 || b2.length < 2) continue;
    const aT = bare(a[0]), aC = unq(a[a.length - 1]);
    const bT = bare(b2[0]), bC = unq(b2[b2.length - 1]);

    const stmtSpan = [m.index, m.index + m[0].length];
    const aStart = m.index + m[0].indexOf(rawA);
    const bStart = m.index + m[0].lastIndexOf(rawB);

    const aTableSpan = findIdentifierSpan(a[0], aT, aStart + rawA.indexOf(a[0]));
    const aColSpan = findIdentifierSpan(a[a.length - 1], aC, aStart + rawA.lastIndexOf(a[a.length - 1]));

    const bTableSpan = findIdentifierSpan(b2[0], bT, bStart + rawB.indexOf(b2[0]));
    const bColSpan = findIdentifierSpan(b2[b2.length - 1], bC, bStart + rawB.lastIndexOf(b2[b2.length - 1]));

    if (dir === '<') {
      rels.push({
        fromTable: bT, fromCols: [bC], toTable: aT, toCols: [aC],
        stmtSpan,
        fromTableSpan: bTableSpan, fromColSpan: bColSpan,
        toTableSpan: aTableSpan, toColSpan: aColSpan
      });
    } else {
      rels.push({
        fromTable: aT, fromCols: [aC], toTable: bT, toCols: [bC],
        stmtSpan,
        fromTableSpan: aTableSpan, fromColSpan: aColSpan,
        toTableSpan: bTableSpan, toColSpan: bColSpan
      });
    }
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

