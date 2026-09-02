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
 * Generate orthogonal 90-degree step points between two endpoints with optional waypoints.
 */
export function buildOrthogonalPoints(p1, p2, waypoints = []) {
  const pts = [p1, ...(waypoints || []), p2];
  const ortho = [];

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];

    if (i === 0) ortho.push({ x: a.x, y: a.y });

    const dx = b.x - a.x;
    const dy = b.y - a.y;

    if (Math.abs(dx) < 1 || Math.abs(dy) < 1) {
      ortho.push({ x: b.x, y: b.y });
      continue;
    }

    const nxa = a.nx ?? (dx >= 0 ? 1 : -1);
    const nya = a.ny ?? 0;
    const nxb = b.nx ?? (dx >= 0 ? -1 : 1);
    const nyb = b.ny ?? 0;

    // Step routing heuristic
    if (Math.abs(nxa) === 1 && Math.abs(nxb) === 1) {
      // Both exit/enter horizontally: S-bend or U-bend
      const midX = (a.nx === 1 && b.nx === -1 && dx > 40)
        ? a.x + dx / 2
        : (a.nx === -1 && b.nx === 1 && dx < -40)
        ? a.x + dx / 2
        : a.x + (a.nx || 1) * Math.max(24, Math.abs(dx) * 0.4);

      ortho.push({ x: midX, y: a.y });
      ortho.push({ x: midX, y: b.y });
    } else if (Math.abs(nya) === 1 && Math.abs(nyb) === 1) {
      // Both exit/enter vertically
      const midY = a.y + (a.ny || 1) * Math.max(24, Math.abs(dy) * 0.4);
      ortho.push({ x: a.x, y: midY });
      ortho.push({ x: b.x, y: midY });
    } else if (Math.abs(nxa) === 1) {
      // a is horizontal, b is vertical
      ortho.push({ x: b.x, y: a.y });
    } else {
      // a is vertical, b is horizontal
      ortho.push({ x: a.x, y: b.y });
    }

    ortho.push({ x: b.x, y: b.y });
  }

  // Deduplicate adjacent identical points
  const clean = [];
  for (const p of ortho) {
    if (!clean.length) {
      clean.push(p);
      continue;
    }
    const prev = clean[clean.length - 1];
    if (Math.hypot(p.x - prev.x, p.y - prev.y) > 0.5) {
      clean.push(p);
    }
  }
  return clean;
}

/**
 * Draw route onto Canvas 2D context based on routing style.
 */
export function drawRoutePath(ctx, style, p1, p2, waypoints = [], radius = 8) {
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
  const ortho = buildOrthogonalPoints(p1, p2, waypoints);
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
export function buildSVGPath(style, p1, p2, waypoints = [], radius = 8) {
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
  const ortho = buildOrthogonalPoints(p1, p2, waypoints);
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

  for (let i = 0; i < ortho.length - 1; i++) {
    const res = pointToSegmentDistance(px, py, ortho[i].x, ortho[i].y, ortho[i + 1].x, ortho[i + 1].y);
    if (res.dist < minDist) {
      minDist = res.dist;
      bestPt = { x: res.x, y: res.y };
      bestSegment = Math.min(waypoints ? waypoints.length : 0, Math.floor((i / Math.max(1, ortho.length - 1)) * (pts.length - 1)));
    }
  }
  return { minDist, nearestPoint: bestPt, insertIndex: bestSegment + 1 };
}
