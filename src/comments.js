// Comments written on tables and columns (DBML notes, for now), shown read-only
// beside the table they belong to.
//
// Three modes, like multiplicity and relation names:
//   hidden  nothing at all;
//   hover   a small mark on every title and column that has a comment, and a
//           card with just that comment while the pointer is on it;
//   always  one card per table, listing the table's comment and then those of
//           its columns.
// An export is a picture of the diagram, not of the pointer: it carries the
// cards only in 'always', and never the marks, which are there to be pointed at.
//
// Everything is measured in diagram units, like the text inside the tables, so
// a card grows and shrinks with the zoom and an export matches the screen.

export const COMMENT_MODES = ['hidden', 'hover', 'always'];

export const CARD = {
  gap: 12,          // between the table and its card
  pad: 8,
  maxWidth: 240,
  lineHeight: 15,
  entryGap: 5,      // extra room between one column's comment and the next
  titleFont: '600 11px ui-sans-serif, system-ui, sans-serif',
  textFont: '11px ui-sans-serif, system-ui, sans-serif',
};

/** The little speech bubble drawn where a comment is waiting to be read. */
export const MARK = { w: 9, h: 6.5 };

const clean = (s) => (s == null ? '' : String(s).trim());

/**
 * The comments a table carries, restricted to the columns on show at the current
 * diagram level. Null when there are none, so callers can skip the table.
 */
export function commentsOf(table, visibleColumns) {
  const note = clean(table && table.note);
  const columns = (visibleColumns || [])
    .filter(c => clean(c.note))
    .map(c => ({ name: c.name, note: clean(c.note) }));
  return note || columns.length ? { note, columns } : null;
}

/** Just the comment under the pointer: the table's own, or one column's. */
export function commentFor(table, column) {
  if (column) {
    const note = clean(column.note);
    return note ? { note: '', columns: [{ name: column.name, note }] } : null;
  }
  const note = clean(table && table.note);
  return note ? { note, columns: [] } : null;
}

/**
 * Break text into lines no wider than `width`, keeping the line breaks it
 * already has. A single word too long for a line (a URL, say) is cut where it
 * has to be rather than left to run out of the card.
 */
export function wrapText(text, width, measure) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const word of words) {
      if (measure(word) > width) {
        if (line) { out.push(line); line = ''; }
        let chunk = '';
        for (const ch of word) {
          if (chunk && measure(chunk + ch) > width) { out.push(chunk); chunk = ch; }
          else chunk += ch;
        }
        line = chunk;
        continue;
      }
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > width) { out.push(line); line = word; }
      else line = next;
    }
    out.push(line);
  }
  return out;
}

/**
 * Lay a card out. `measure(text, font)` is the renderer's own measurement: the
 * canvas passes measureText, the SVG export an estimate. Returns the card's size
 * and its lines, each with its font, its role (the table's comment, a column
 * name or a column's comment) and the y of its middle.
 */
export function layoutCommentCard(comments, measure) {
  const inner = CARD.maxWidth - CARD.pad * 2;
  const lines = [];
  let y = CARD.pad;
  const place = (text, font, role) => {
    lines.push({ text, font, role, y: y + CARD.lineHeight / 2 });
    y += CARD.lineHeight;
  };
  const textWidth = (s) => measure(s, CARD.textFont);

  if (comments.note) {
    for (const l of wrapText(comments.note, inner, textWidth)) place(l, CARD.textFont, 'table');
  }
  for (const c of comments.columns) {
    if (lines.length) y += CARD.entryGap;
    place(c.name, CARD.titleFont, 'column');
    for (const l of wrapText(c.note, inner, textWidth)) place(l, CARD.textFont, 'text');
  }

  const widest = Math.max(0, ...lines.map(l => measure(l.text, l.font)));
  return {
    width: Math.min(CARD.maxWidth, Math.ceil(widest) + CARD.pad * 2),
    height: y + CARD.pad,
    lines,
  };
}
