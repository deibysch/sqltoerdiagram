// Line jumps: where two 90° connections cross, one of them arcs over the other
// instead of the two meeting in an ambiguous plus sign — the little bridge that
// Enterprise Architect and most ER tools draw.
//
// The rule is fixed rather than drawing-order dependent: the horizontal run hops
// and the vertical one stays flat. So a crossing always gets exactly one bridge,
// no matter which line is painted first, and re-drawing a single line cannot
// change what the rest look like.
//
// Only the orthogonal styles take part. Curved and straight lines cross without
// a hop, because a bridge on a slanted or curving line reads as a kink.

import { buildOrthogonalPoints } from './routing.js';

const END_MARGIN = 10;         // no bridge this close to a corner or an endpoint
const FLAT = 0.6;              // a run is horizontal/vertical within this many px

export const isOrthogonalStyle = (style) => style === 'ortho-sharp' || style === 'ortho-rounded';

/** The horizontal and vertical runs of one drawn line. */
function runsOf(pts) {
  const horizontal = [], vertical = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (Math.abs(a.y - b.y) < FLAT && Math.abs(a.x - b.x) > FLAT) {
      horizontal.push({ y: a.y, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x) });
    } else if (Math.abs(a.x - b.x) < FLAT && Math.abs(a.y - b.y) > FLAT) {
      vertical.push({ x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) });
    }
  }
  return { horizontal, vertical };
}

/**
 * Work out every bridge in one pass over the drawn lines.
 * `segs` are what the canvas is about to draw: { key, routingStyle, p1, p2,
 * waypoints, obstacles, laneOffset }. Returns Map(key -> [{ x, y }]), the points
 * on that line's own horizontal runs where it should arc over another line.
 */
export function computeLineHops(segs) {
  const lines = [];
  for (const seg of segs || []) {
    if (!seg || !seg.key || !isOrthogonalStyle(seg.routingStyle)) continue;
    const pts = buildOrthogonalPoints(seg.p1, seg.p2, seg.waypoints || [], seg.obstacles || [], seg.laneOffset || 0);
    if (pts.length < 2) continue;
    lines.push({ key: seg.key, ...runsOf(pts) });
  }

  const hops = new Map();
  for (const line of lines) {
    const own = new Map();   // rounded "x,y" -> point, so two lines crossing at
                             // the same spot still leave a single bridge
    for (const h of line.horizontal) {
      for (const other of lines) {
        if (other === line) continue;
        for (const v of other.vertical) {
          // clear of this line's own corners...
          if (v.x <= h.x0 + END_MARGIN || v.x >= h.x1 - END_MARGIN) continue;
          // ...and of the corners of the line being crossed
          if (h.y <= v.y0 + END_MARGIN || h.y >= v.y1 - END_MARGIN) continue;
          own.set(`${Math.round(v.x)},${Math.round(h.y)}`, { x: v.x, y: h.y });
        }
      }
    }
    if (own.size) hops.set(line.key, [...own.values()]);
  }
  return hops;
}
