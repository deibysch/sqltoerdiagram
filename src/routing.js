// Connection routing and perimeter geometry helpers:
// - Perimeter anchoring on table bounding boxes
// - Routing styles: 'curved' (bezier), 'straight' (polyline), 'ortho-sharp' (90°), 'ortho-rounded' (90° with rounded corners)
// - Waypoints management and path construction for Canvas 2D and SVG

// Sizing metrics from renderer
import { columnY } from './renderer.js';

export const ROUTING_STYLES = {
  curved: { id: 'curved', label: 'Curved (Bézier)', icon: 'curved' },
  straight: { id: 'straight', label: 'Straight (Direct)', icon: 'straight' },
  'ortho-sharp': { id: 'ortho-sharp', label: 'Orthogonal 90° (Sharp)', icon: 'ortho-sharp' },
  'ortho-rounded': { id: 'ortho-rounded', label: 'Orthogonal 90° (Rounded)', icon: 'ortho-rounded' },
};

/**
 * Calculate the anchor point on the perimeter of a table.
 * If anchor is specified ({ side: 'left'|'right'|'top'|'bottom', offset: 0..1 }), uses that.
 * Otherwise, calculates optimal perimeter point facing the target point.
 */
export function getTableAnchor(table, colName, targetPoint = null, anchorConfig = null) {
  if (!table || !Number.isFinite(table.x) || !Number.isFinite(table.y)) {
    return { x: 0, y: 0, nx: 1, ny: 0, side: 'right' };
  }

  const { x, y, w, h } = table;

  if (anchorConfig && anchorConfig.side) {
    const side = anchorConfig.side;
    const offset = Number.isFinite(anchorConfig.offset) ? Math.max(0, Math.min(1, anchorConfig.offset)) : 0.5;
    if (side === 'left') return { x, y: y + offset * h, nx: -1, ny: 0, side: 'left' };
    if (side === 'right') return { x: x + w, y: y + offset * h, nx: 1, ny: 0, side: 'right' };
    if (side === 'top') return { x: x + offset * w, y, nx: 0, ny: -1, side: 'top' };
    if (side === 'bottom') return { x: x + offset * w, y: y + h, nx: 0, ny: 1, side: 'bottom' };
  }

  // If column is provided and target is horizontal, default to column row height on left/right
  const colY = colName ? y + columnY(table, colName) : y + h / 2;

  if (!targetPoint) {
    return { x: x + w, y: colY, nx: 1, ny: 0, side: 'right' };
  }

  const cx = x + w / 2;
  const cy = y + h / 2;
  const dx = targetPoint.x - cx;
  const dy = targetPoint.y - cy;

  // If mostly horizontal, attach to left or right at column height
  if (Math.abs(dx) * h >= Math.abs(dy) * w) {
    if (dx >= 0) {
      return { x: x + w, y: colY, nx: 1, ny: 0, side: 'right' };
    } else {
      return { x, y: colY, nx: -1, ny: 0, side: 'left' };
    }
  } else {
    // Mostly vertical
    const clampX = Math.max(x + 12, Math.min(x + w - 12, targetPoint.x));
    if (dy >= 0) {
      return { x: clampX, y: y + h, nx: 0, ny: 1, side: 'bottom' };
    } else {
      return { x: clampX, y, nx: 0, ny: -1, side: 'top' };
    }
  }
}

/**
 * Simplify and deduplicate orthogonal points sequence (merges collinear points and removes zero-length zigzags).
 */
export function cleanOrthogonalPoints(points) {
  if (!points || points.length <= 2) return points ? [...points] : [];

  // Step 1: Remove duplicate adjacent points
  const noDups = [];
  for (const p of points) {
    if (!noDups.length) {
      noDups.push({ x: Math.round(p.x), y: Math.round(p.y), nx: p.nx, ny: p.ny });
      continue;
    }
    const prev = noDups[noDups.length - 1];
    if (Math.hypot(p.x - prev.x, p.y - prev.y) > 0.5) {
      noDups.push({ x: Math.round(p.x), y: Math.round(p.y), nx: p.nx, ny: p.ny });
    }
  }

  // Step 2: Merge collinear segments (3 points in a row with same X or same Y)
  const merged = [];
  for (let i = 0; i < noDups.length; i++) {
    const cur = noDups[i];
    if (merged.length < 2) {
      merged.push(cur);
      continue;
    }
    const p1 = merged[merged.length - 2];
    const p2 = merged[merged.length - 1];

    const isCollinearX = Math.abs(p1.x - p2.x) < 1 && Math.abs(p2.x - cur.x) < 1;
    const isCollinearY = Math.abs(p1.y - p2.y) < 1 && Math.abs(p2.y - cur.y) < 1;

    if (isCollinearX || isCollinearY) {
      merged[merged.length - 1] = cur; // replace middle point
    } else {
      merged.push(cur);
    }
  }

  return merged;
}

/**
 * Check whether a segment between p1 and p2 intersects an obstacle box.
 */
export function segmentIntersectsBox(p1, p2, box, margin = 12) {
  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return { hit: false };
  const minX = box.x - margin;
  const maxX = box.x + box.w + margin;
  const minY = box.y - margin;
  const maxY = box.y + box.h + margin;

  const isHoriz = Math.abs(p1.y - p2.y) < 1;
  const isVert = Math.abs(p1.x - p2.x) < 1;

  if (isHoriz) {
    const y = p1.y;
    if (y >= minY && y <= maxY) {
      const segMinX = Math.min(p1.x, p2.x);
      const segMaxX = Math.max(p1.x, p2.x);
      if (segMaxX > minX && segMinX < maxX) {
        return { hit: true, axis: 'h', minX, maxX, minY, maxY, box };
      }
    }
  } else if (isVert) {
    const x = p1.x;
    if (x >= minX && x <= maxX) {
      const segMinY = Math.min(p1.y, p2.y);
      const segMaxY = Math.max(p1.y, p2.y);
      if (segMaxY > minY && segMinY < maxY) {
        return { hit: true, axis: 'v', minX, maxX, minY, maxY, box };
      }
    }
  } else {
    // Slanted or diagonal segment
    const segMinX = Math.min(p1.x, p2.x), segMaxX = Math.max(p1.x, p2.x);
    const segMinY = Math.min(p1.y, p2.y), segMaxY = Math.max(p1.y, p2.y);
    if (segMaxX > minX && segMinX < maxX && segMaxY > minY && segMinY < maxY) {
      return { hit: true, axis: 'diagonal', minX, maxX, minY, maxY, box };
    }
  }
  return { hit: false };
}

/**
 * Reroute orthogonal points sequence around obstacles via outer boundary channels.
 */
export function routeAroundObstacles(pts, obstacles = [], margin = 12) {
  if (!obstacles || !obstacles.length || !pts || pts.length < 2) return pts;

  let current = cleanOrthogonalPoints(pts);
  const MAX_PASSES = 4;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let modified = false;
    const next = [];

    for (let i = 0; i < current.length - 1; i++) {
      const a = current[i];
      const b = current[i + 1];
      if (i === 0) next.push(a);

      let firstHit = null;
      for (const obs of obstacles) {
        const hit = segmentIntersectsBox(a, b, obs, margin);
        if (hit.hit) {
          firstHit = hit;
          break;
        }
      }

      if (!firstHit) {
        next.push(b);
        continue;
      }

      modified = true;
      if (firstHit.axis === 'h') {
        // Horizontal segment intersects obstacle: route above or below
        const detourY = Math.abs(a.y - firstHit.minY) < Math.abs(a.y - firstHit.maxY)
          ? firstHit.minY - 6
          : firstHit.maxY + 6;
        const detourX1 = a.x < b.x ? firstHit.minX - 6 : firstHit.maxX + 6;
        const detourX2 = a.x < b.x ? firstHit.maxX + 6 : firstHit.minX - 6;

        next.push({ x: detourX1, y: a.y });
        next.push({ x: detourX1, y: detourY });
        next.push({ x: detourX2, y: detourY });
        next.push({ x: detourX2, y: b.y });
        next.push(b);
      } else if (firstHit.axis === 'v') {
        // Vertical segment intersects obstacle: route left or right
        const detourX = Math.abs(a.x - firstHit.minX) < Math.abs(a.x - firstHit.maxX)
          ? firstHit.minX - 6
          : firstHit.maxX + 6;
        const detourY1 = a.y < b.y ? firstHit.minY - 6 : firstHit.maxY + 6;
        const detourY2 = a.y < b.y ? firstHit.maxY + 6 : firstHit.minY - 6;

        next.push({ x: a.x, y: detourY1 });
        next.push({ x: detourX, y: detourY1 });
        next.push({ x: detourX, y: detourY2 });
        next.push({ x: b.x, y: detourY2 });
        next.push(b);
      } else {
        next.push(b);
      }
    }

    current = cleanOrthogonalPoints(next);
    if (!modified) break;
  }

  return current;
}

/**
 * Generate orthogonal 90-degree step points between two endpoints with optional waypoints and obstacle avoidance.
 */
export function buildOrthogonalPoints(p1, p2, waypoints = [], obstacles = []) {
  if (waypoints && waypoints.length) {
    // Connect p1 -> w1 -> w2 ... -> p2, ensuring each transition is 90°
    const raw = [p1, ...waypoints, p2];
    const ortho = [];

    for (let i = 0; i < raw.length - 1; i++) {
      const a = raw[i];
      const b = raw[i + 1];
      if (i === 0) ortho.push({ x: a.x, y: a.y, nx: a.nx, ny: a.ny });

      const dx = b.x - a.x;
      const dy = b.y - a.y;

      if (Math.abs(dx) < 1 || Math.abs(dy) < 1) {
        ortho.push({ x: b.x, y: b.y, nx: b.nx, ny: b.ny });
        continue;
      }

      // If transition between two waypoints is not aligned, insert intermediate 90° corner
      const isStart = i === 0;
      const isEnd = i === raw.length - 2;

      if (isStart && Math.abs(a.nx || 0) === 1) {
        ortho.push({ x: b.x, y: a.y });
      } else if (isStart && Math.abs(a.ny || 0) === 1) {
        ortho.push({ x: a.x, y: b.y });
      } else if (isEnd && Math.abs(b.nx || 0) === 1) {
        ortho.push({ x: a.x, y: b.y });
      } else if (isEnd && Math.abs(b.ny || 0) === 1) {
        ortho.push({ x: b.x, y: a.y });
      } else {
        ortho.push({ x: a.x, y: b.y });
      }
      ortho.push({ x: b.x, y: b.y, nx: b.nx, ny: b.ny });
    }
    const cleaned = cleanOrthogonalPoints(ortho);
    return cleaned;
  }

  // Default automatic S-bend or L-bend
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;

  const nxa = p1.nx ?? (dx >= 0 ? 1 : -1);
  const nya = p1.ny ?? 0;
  const nxb = p2.nx ?? (dx >= 0 ? -1 : 1);
  const nyb = p2.ny ?? 0;

  const ortho = [{ x: p1.x, y: p1.y, nx: nxa, ny: nya }];

  if (Math.abs(nxa) === 1 && Math.abs(nxb) === 1) {
    // Both exit/enter horizontally: S-bend or U-bend
    const midX = (nxa === 1 && nxb === -1 && dx > 40)
      ? p1.x + dx / 2
      : (nxa === -1 && nxb === 1 && dx < -40)
      ? p1.x + dx / 2
      : p1.x + nxa * Math.max(30, Math.abs(dx) * 0.4);

    ortho.push({ x: midX, y: p1.y });
    ortho.push({ x: midX, y: p2.y });
  } else if (Math.abs(nya) === 1 && Math.abs(nyb) === 1) {
    // Both exit/enter vertically
    const midY = p1.y + nya * Math.max(30, Math.abs(dy) * 0.4);
    ortho.push({ x: p1.x, y: midY });
    ortho.push({ x: p2.x, y: midY });
  } else if (Math.abs(nxa) === 1) {
    ortho.push({ x: p2.x, y: p1.y });
  } else {
    ortho.push({ x: p1.x, y: p2.y });
  }

  ortho.push({ x: p2.x, y: p2.y, nx: nxb, ny: nyb });
  const cleaned = cleanOrthogonalPoints(ortho);

  if (obstacles && obstacles.length > 0) {
    return routeAroundObstacles(cleaned, obstacles);
  }
  return cleaned;
}

/**
 * Extract all horizontal and vertical segments from an orthogonal route.
 */
export function getOrthogonalSegments(p1, p2, waypoints = [], obstacles = []) {
  const pts = buildOrthogonalPoints(p1, p2, waypoints, obstacles);
  const segments = [];

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const isVertical = Math.abs(a.x - b.x) <= Math.abs(a.y - b.y);
    const mid = {
      x: Math.round((a.x + b.x) / 2),
      y: Math.round((a.y + b.y) / 2),
    };
    segments.push({
      index: i,
      isVertical,
      p1: a,
      p2: b,
      mid,
      length: Math.hypot(b.x - a.x, b.y - a.y),
    });
  }
  return { points: pts, segments };
}

/**
 * Move a whole orthogonal segment along its perpendicular axis (like in dbdiagram.io):
 * - Vertical segment shifts in X
 * - Horizontal segment shifts in Y
 * Returns new list of waypoints.
 */
export function moveOrthogonalSegment(p1, p2, waypoints, segIndex, mouseX, mouseY) {
  const pts = buildOrthogonalPoints(p1, p2, waypoints);
  if (segIndex < 0 || segIndex >= pts.length - 1) return waypoints || [];

  const a = pts[segIndex];
  const b = pts[segIndex + 1];
  const isVertical = Math.abs(a.x - b.x) <= Math.abs(a.y - b.y);

  if (isVertical) {
    const targetX = Math.round(mouseX);
    if (segIndex === 0) {
      // First segment is vertical: create step from p1
      pts.splice(1, 0, { x: targetX, y: a.y }, { x: targetX, y: b.y });
    } else if (segIndex === pts.length - 2) {
      // Last segment is vertical: create step into p2
      pts.splice(segIndex + 1, 0, { x: targetX, y: a.y }, { x: targetX, y: b.y });
    } else {
      a.x = targetX;
      b.x = targetX;
    }
  } else {
    const targetY = Math.round(mouseY);
    if (segIndex === 0) {
      // First segment is horizontal: create step from p1
      pts.splice(1, 0, { x: a.x, y: targetY }, { x: b.x, y: targetY });
    } else if (segIndex === pts.length - 2) {
      // Last segment is horizontal: create step into p2
      pts.splice(segIndex + 1, 0, { x: a.x, y: targetY }, { x: b.x, y: targetY });
    } else {
      a.y = targetY;
      b.y = targetY;
    }
  }

  const cleaned = cleanOrthogonalPoints(pts);
  return cleaned.slice(1, -1);
}

/**
 * Move a corner vertex in orthogonal mode while keeping connected segments horizontal/vertical.
 */
export function moveOrthogonalCorner(p1, p2, waypoints, cornerIndex, mouseX, mouseY) {
  const pts = buildOrthogonalPoints(p1, p2, waypoints);
  const k = cornerIndex + 1; // index inside pts
  if (k < 1 || k >= pts.length - 1) return waypoints || [];

  const cur = pts[k];
  const prev = pts[k - 1];
  const next = pts[k + 1];

  const targetX = Math.round(mouseX);
  const targetY = Math.round(mouseY);

  const prevIsHoriz = Math.abs(prev.y - cur.y) <= Math.abs(prev.x - cur.x);
  if (prevIsHoriz) {
    prev.y = targetY;
  } else {
    prev.x = targetX;
  }

  const nextIsHoriz = Math.abs(next.y - cur.y) <= Math.abs(next.x - cur.x);
  if (nextIsHoriz) {
    next.y = targetY;
  } else {
    next.x = targetX;
  }

  cur.x = targetX;
  cur.y = targetY;

  const cleaned = cleanOrthogonalPoints(pts);
  return cleaned.slice(1, -1);
}

/**
 * Draw route onto Canvas 2D context based on routing style.
 */
export function drawRoutePath(ctx, style, p1, p2, waypoints = [], radius = 8, obstacles = []) {
  const pts = [p1, ...(waypoints || []), p2];

  if (style === 'straight') {
    ctx.moveTo(p1.x, p1.y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    return;
  }

  if (style === 'curved') {
    if (!waypoints || !waypoints.length) {
      const fromRight = (p1.nx === 1) || (p1.nx === undefined && p1.x <= p2.x);
      const dx = Math.max(28, Math.abs(p2.x - p1.x) * 0.4);
      const c1x = p1.x + (p1.nx !== undefined ? p1.nx * dx : (fromRight ? dx : -dx));
      const c1y = p1.y + (p1.ny !== undefined ? p1.ny * dx : 0);
      const c2x = p2.x + (p2.nx !== undefined ? p2.nx * dx : (fromRight ? -dx : dx));
      const c2y = p2.y + (p2.ny !== undefined ? p2.ny * dx : 0);
      ctx.moveTo(p1.x, p1.y);
      ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
    } else {
      // Smooth curve passing through waypoints
      ctx.moveTo(p1.x, p1.y);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        ctx.quadraticCurveTo(a.x, a.y, mx, my);
      }
      ctx.lineTo(p2.x, p2.y);
    }
    return;
  }

  // Orthogonal styles ('ortho-sharp' and 'ortho-rounded')
  const ortho = buildOrthogonalPoints(p1, p2, waypoints, obstacles);
  if (!ortho.length) return;

  ctx.moveTo(ortho[0].x, ortho[0].y);

  if (style === 'ortho-sharp' || radius <= 0) {
    for (let i = 1; i < ortho.length; i++) {
      ctx.lineTo(ortho[i].x, ortho[i].y);
    }
    return;
  }

  // 'ortho-rounded' with arcTo rounded corners
  const r = Math.max(2, Math.min(14, radius));
  for (let i = 1; i < ortho.length - 1; i++) {
    const cur = ortho[i];
    const next = ortho[i + 1];
    ctx.arcTo(cur.x, cur.y, next.x, next.y, r);
  }
  ctx.lineTo(ortho[ortho.length - 1].x, ortho[ortho.length - 1].y);
}

/**
 * Generate SVG path `d` attribute string for the given routing style.
 */
export function buildSVGPath(style, p1, p2, waypoints = [], radius = 8, obstacles = []) {
  const pts = [p1, ...(waypoints || []), p2];

  if (style === 'straight') {
    return 'M ' + pts.map(p => `${p.x} ${p.y}`).join(' L ');
  }

  if (style === 'curved') {
    if (!waypoints || !waypoints.length) {
      const fromRight = (p1.nx === 1) || (p1.nx === undefined && p1.x <= p2.x);
      const dx = Math.max(28, Math.abs(p2.x - p1.x) * 0.4);
      const c1x = p1.x + (p1.nx !== undefined ? p1.nx * dx : (fromRight ? dx : -dx));
      const c1y = p1.y + (p1.ny !== undefined ? p1.ny * dx : 0);
      const c2x = p2.x + (p2.nx !== undefined ? p2.nx * dx : (fromRight ? -dx : dx));
      const c2y = p2.y + (p2.ny !== undefined ? p2.ny * dx : 0);
      return `M ${p1.x} ${p1.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
    } else {
      let d = `M ${p1.x} ${p1.y}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        d += ` Q ${a.x} ${a.y}, ${mx} ${my}`;
      }
      d += ` L ${p2.x} ${p2.y}`;
      return d;
    }
  }

  // Orthogonal styles
  const ortho = buildOrthogonalPoints(p1, p2, waypoints, obstacles);
  if (!ortho.length) return `M ${p1.x} ${p1.y}`;

  if (style === 'ortho-sharp' || radius <= 0) {
    return 'M ' + ortho.map(p => `${p.x} ${p.y}`).join(' L ');
  }

  // Orthogonal rounded SVG
  let d = `M ${ortho[0].x} ${ortho[0].y}`;
  const r = Math.max(2, Math.min(14, radius));

  for (let i = 1; i < ortho.length - 1; i++) {
    const prev = ortho[i - 1];
    const cur = ortho[i];
    const next = ortho[i + 1];

    const d1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const d2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    const cr = Math.min(r, d1 / 2, d2 / 2);

    const v1x = (prev.x - cur.x) / (d1 || 1);
    const v1y = (prev.y - cur.y) / (d1 || 1);
    const v2x = (next.x - cur.x) / (d2 || 1);
    const v2y = (next.y - cur.y) / (d2 || 1);

    const pStart = { x: cur.x + v1x * cr, y: cur.y + v1y * cr };
    const pEnd = { x: cur.x + v2x * cr, y: cur.y + v2y * cr };

    d += ` L ${pStart.x} ${pStart.y} Q ${cur.x} ${cur.y}, ${pEnd.x} ${pEnd.y}`;
  }

  d += ` L ${ortho[ortho.length - 1].x} ${ortho[ortho.length - 1].y}`;
  return d;
}

/**
 * Find point on segment closest to mouse (for vertex insertion and hit testing)
 */
export function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
  const l2 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
  if (l2 === 0) return { dist: Math.hypot(px - x1, py - y1), x: x1, y: y1, t: 0 };
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / l2;
  t = Math.max(0, Math.min(1, t));
  const projX = x1 + t * (x2 - x1);
  const projY = y1 + t * (y2 - y1);
  return { dist: Math.hypot(px - projX, py - projY), x: projX, y: projY, t };
}

/**
 * Calculate accurate distance from point (px, py) to any routed connection path.
 * Returns { minDist, nearestPoint, insertIndex }
 */
export function distanceToRoute(px, py, style, p1, p2, waypoints = []) {
  const pts = [p1, ...(waypoints || []), p2];

  if (style === 'straight') {
    let minDist = Infinity;
    let bestPt = { x: p1.x, y: p1.y };
    let bestSegment = 0;

    for (let i = 0; i < pts.length - 1; i++) {
      const res = pointToSegmentDistance(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (res.dist < minDist) {
        minDist = res.dist;
        bestPt = { x: res.x, y: res.y };
        bestSegment = i;
      }
    }
    return { minDist, nearestPoint: bestPt, insertIndex: bestSegment + 1 };
  }

  if (style === 'curved') {
    let minDist = Infinity;
    let bestPt = { x: p1.x, y: p1.y };
    let bestSegment = 0;

    if (!waypoints || !waypoints.length) {
      const fromRight = (p1.nx === 1) || (p1.nx === undefined && p1.x <= p2.x);
      const dx = Math.max(28, Math.abs(p2.x - p1.x) * 0.4);
      const c1x = p1.x + (p1.nx !== undefined ? p1.nx * dx : (fromRight ? dx : -dx));
      const c1y = p1.y + (p1.ny !== undefined ? p1.ny * dx : 0);
      const c2x = p2.x + (p2.nx !== undefined ? p2.nx * dx : (fromRight ? -dx : dx));
      const c2y = p2.y + (p2.ny !== undefined ? p2.ny * dx : 0);

      // Sample cubic bezier
      let prevX = p1.x, prevY = p1.y;
      const steps = 24;
      for (let i = 1; i <= steps; i++) {
        const u = i / steps;
        const iu = 1 - u;
        const curX = iu * iu * iu * p1.x + 3 * iu * iu * u * c1x + 3 * iu * u * u * c2x + u * u * u * p2.x;
        const curY = iu * iu * iu * p1.y + 3 * iu * iu * u * c1y + 3 * iu * u * u * c2y + u * u * u * p2.y;
        const res = pointToSegmentDistance(px, py, prevX, prevY, curX, curY);
        if (res.dist < minDist) {
          minDist = res.dist;
          bestPt = { x: res.x, y: res.y };
          bestSegment = 0;
        }
        prevX = curX;
        prevY = curY;
      }
      return { minDist, nearestPoint: bestPt, insertIndex: 0 };
    } else {
      // Smooth curve through waypoints
      for (let s = 0; s < pts.length - 1; s++) {
        const a = pts[s];
        const b = pts[s + 1];
        let prevX = a.x, prevY = a.y;
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
          const u = i / steps;
          const curX = (1 - u) * a.x + u * b.x;
          const curY = (1 - u) * a.y + u * b.y;
          const res = pointToSegmentDistance(px, py, prevX, prevY, curX, curY);
          if (res.dist < minDist) {
            minDist = res.dist;
            bestPt = { x: res.x, y: res.y };
            bestSegment = s;
          }
          prevX = curX;
          prevY = curY;
        }
      }
      return { minDist, nearestPoint: bestPt, insertIndex: bestSegment + 1 };
    }
  }

  // Orthogonal styles
  const ortho = buildOrthogonalPoints(p1, p2, waypoints);
  let minDist = Infinity;
  let bestPt = { x: p1.x, y: p1.y };
  let bestSegment = 0;
  let isVertical = false;
  let segMid = { x: p1.x, y: p1.y };

  for (let i = 0; i < ortho.length - 1; i++) {
    const a = ortho[i];
    const b = ortho[i + 1];
    const res = pointToSegmentDistance(px, py, a.x, a.y, b.x, b.y);
    if (res.dist < minDist) {
      minDist = res.dist;
      bestPt = { x: res.x, y: res.y };
      bestSegment = i;
      isVertical = Math.abs(a.x - b.x) <= Math.abs(a.y - b.y);
      segMid = { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
    }
  }
  return {
    minDist,
    nearestPoint: bestPt,
    insertIndex: bestSegment + 1,
    segmentIndex: bestSegment,
    isVertical,
    segMid,
    totalSegments: ortho.length - 1,
  };
}
