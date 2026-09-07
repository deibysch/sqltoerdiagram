// Advanced Line Organization Engines for ER Diagrams
// Reorganizes orthogonal connection routes without moving tables:
// 1. Smart Faces & Avoid (Changes anchor faces to top/bottom to bypass intermediate tables cleanly)
// 2. Perimeter Bus (Routes cross-table connections through outer boundary channels)
// 3. A* Grid Router (Computes shortest collision-free orthogonal path on a grid)
// 4. Reset Lines (Reverts to direct automatic S-bends / L-bends)

import { getTableAnchor, segmentIntersectsBox, cleanOrthogonalPoints, filterRedundantWaypoints } from './routing.js';

/**
 * Extract active edges from diagram model.
 */
export function getDiagramEdges(diagram, targetKeys = null) {
  if (!diagram || !diagram.model) return [];
  const byKey = new Map((diagram.model.tables || []).map(t => [t.key.toLowerCase(), t]));
  const edges = [];
  const filterSet = targetKeys && targetKeys.length ? new Set(targetKeys.map(k => k.toLowerCase())) : null;

  for (const r of (diagram.model.relations || [])) {
    const fk = (r.fromTable || '').toLowerCase();
    const tk = (r.toTable || '').toLowerCase();
    const fc = r.fromCols?.[0] || '';
    const tc = r.toCols?.[0] || '';
    const key = `${fk}.${fc.toLowerCase()}->${tk}.${tc.toLowerCase()}`;
    if (filterSet && !filterSet.has(key)) continue;

    const from = byKey.get(fk);
    const to = byKey.get(tk);
    if (!from || !to || !Number.isFinite(from.x) || !Number.isFinite(to.x)) continue;
    if (diagram.hidden?.has(fk) || diagram.hidden?.has(tk)) continue;

    edges.push({ key, fk, tk, fc, tc, from, to, manual: false });
  }

  for (const l of (diagram.manualLinks || [])) {
    const fk = (l.from?.table || '').toLowerCase();
    const tk = (l.to?.table || '').toLowerCase();
    const fc = l.from?.col || '';
    const tc = l.to?.col || '';
    const key = `${fk}.${fc.toLowerCase()}->${tk}.${tc.toLowerCase()}`;
    if (filterSet && !filterSet.has(key)) continue;

    const from = byKey.get(fk);
    const to = byKey.get(tk);
    if (!from || !to || !Number.isFinite(from.x) || !Number.isFinite(to.x)) continue;
    if (diagram.hidden?.has(fk) || diagram.hidden?.has(tk)) continue;

    edges.push({ key, fk, tk, fc, tc, from, to, manual: true });
  }

  return edges;
}

/**
 * Get obstacle tables for a specific relation.
 */
export function getObstacles(diagram, fromKey, toKey) {
  const obstacles = [];
  const fk = (fromKey || '').toLowerCase();
  const tk = (toKey || '').toLowerCase();
  for (const t of (diagram.model?.tables || [])) {
    const k = (t.key || '').toLowerCase();
    if (k !== fk && k !== tk && Number.isFinite(t.x) && !diagram.hidden?.has(k)) {
      obstacles.push(t);
    }
  }
  return obstacles;
}

/**
 * Test whether any segment in a sequence of points intersects an obstacle.
 */
function pathIntersectsObstacles(pts, obstacles, margin = 8) {
  if (!pts || pts.length < 2 || !obstacles.length) return false;
  for (let i = 0; i < pts.length - 1; i++) {
    for (const obs of obstacles) {
      if (segmentIntersectsBox(pts[i], pts[i + 1], obs, margin).hit) {
        return true;
      }
    }
  }
  return false;
}

/**
 * ALGORITHM 1: Smart Faces & Avoid
 * Switches anchor faces (e.g. from lateral to top/bottom) when direct path intersects an intermediate table.
 * Perfect for cases like: rol -> [permiso] -> rol_permiso.
 */
export function organizeLinesSmartFaces(diagram, targetKeys = null) {
  const edges = getDiagramEdges(diagram, targetKeys);
  if (!edges.length) return 0;

  diagram.onHistorySnapshot?.(diagram.getSnapshot());
  let modifiedCount = 0;
  const laneCounter = new Map();

  for (const e of edges) {
    const obstacles = getObstacles(diagram, e.fk, e.tk);
    const from = e.from;
    const to = e.to;

    // Test direct automatic connection
    const p1Default = getTableAnchor(from, e.fc, to, null, 0, diagram.diagramLevel);
    const p2Default = getTableAnchor(to, e.tc, from, null, 0, diagram.diagramLevel);

    const midX = (p1Default.x + p2Default.x) / 2;
    const directPath = [p1Default, { x: midX, y: p1Default.y }, { x: midX, y: p2Default.y }, p2Default];

    const hits = obstacles.filter(obs => {
      for (let i = 0; i < directPath.length - 1; i++) {
        if (segmentIntersectsBox(directPath[i], directPath[i + 1], obs, 10).hit) return true;
      }
      return false;
    });

    if (!hits.length) {
      // Direct path is already clean! Don't add unnecessary bends.
      continue;
    }

    // Path is blocked! Determine alignment
    const isMostlyHorizontal = Math.abs(from.x - to.x) >= Math.abs(from.y - to.y);

    if (isMostlyHorizontal) {
      // Tables are in a horizontal row/flow: detour above or below
      const minObsY = Math.min(from.y, to.y, ...hits.map(o => o.y));
      const maxObsY = Math.max(from.y + from.h, to.y + to.h, ...hits.map(o => o.y + o.h));

      // Prefer top corridor if space permits, otherwise bottom
      const useTop = minObsY >= 40;
      const corridorKey = useTop ? 'top_h' : 'bottom_h';
      const laneIdx = laneCounter.get(corridorKey) || 0;
      laneCounter.set(corridorKey, laneIdx + 1);

      const laneOffset = (laneIdx % 5) * 12;
      const detourY = useTop ? (minObsY - 26 - laneOffset) : (maxObsY + 26 + laneOffset);
      const side = useTop ? 'top' : 'bottom';

      const fromAnchor = { side, offset: 0.5 };
      const toAnchor = { side, offset: 0.5 };

      const p1New = getTableAnchor(from, e.fc, null, fromAnchor, 0, diagram.diagramLevel);
      const p2New = getTableAnchor(to, e.tc, null, toAnchor, 0, diagram.diagramLevel);

      const waypoints = [
        { x: p1New.x, y: detourY },
        { x: p2New.x, y: detourY },
      ];

      diagram.edgeAnchors.set(e.key, { fromAnchor, toAnchor });
      diagram.edgeWaypoints.set(e.key, waypoints);
      modifiedCount++;
    } else {
      // Tables are in a vertical column: detour left or right
      const minObsX = Math.min(from.x, to.x, ...hits.map(o => o.x));
      const maxObsX = Math.max(from.x + from.w, to.x + to.w, ...hits.map(o => o.x + o.w));

      const useLeft = minObsX >= 40;
      const corridorKey = useLeft ? 'left_v' : 'right_v';
      const laneIdx = laneCounter.get(corridorKey) || 0;
      laneCounter.set(corridorKey, laneIdx + 1);

      const laneOffset = (laneIdx % 5) * 12;
      const detourX = useLeft ? (minObsX - 26 - laneOffset) : (maxObsX + 26 + laneOffset);
      const side = useLeft ? 'left' : 'right';

      const fromAnchor = { side, offset: 0.5 };
      const toAnchor = { side, offset: 0.5 };

      const p1New = getTableAnchor(from, e.fc, null, fromAnchor, 0, diagram.diagramLevel);
      const p2New = getTableAnchor(to, e.tc, null, toAnchor, 0, diagram.diagramLevel);

      const waypoints = [
        { x: detourX, y: p1New.y },
        { x: detourX, y: p2New.y },
      ];

      diagram.edgeAnchors.set(e.key, { fromAnchor, toAnchor });
      diagram.edgeWaypoints.set(e.key, waypoints);
      modifiedCount++;
    }
  }

  diagram.markDirty();
  diagram.onLayoutChange?.();
  return modifiedCount;
}

/**
 * ALGORITHM 2: Perimeter Bus Channels
 * Routes connections that cross between groups or across long distances via outer perimeter channels.
 */
export function organizeLinesPerimeterBus(diagram, targetKeys = null) {
  const edges = getDiagramEdges(diagram, targetKeys);
  if (!edges.length) return 0;

  diagram.onHistorySnapshot?.(diagram.getSnapshot());
  let modifiedCount = 0;
  const laneCounter = new Map();

  for (const e of edges) {
    const obstacles = getObstacles(diagram, e.fk, e.tk);
    const from = e.from;
    const to = e.to;

    // Check if direct line hits obstacles
    const p1Default = getTableAnchor(from, e.fc, to, null, 0, diagram.diagramLevel);
    const p2Default = getTableAnchor(to, e.tc, from, null, 0, diagram.diagramLevel);
    const midX = (p1Default.x + p2Default.x) / 2;
    const directPath = [p1Default, { x: midX, y: p1Default.y }, { x: midX, y: p2Default.y }, p2Default];

    const hits = obstacles.filter(obs => pathIntersectsObstacles(directPath, [obs], 8));

    // Also route long distance relations (> 400px) through perimeter bus
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (!hits.length && dist < 450) {
      continue;
    }

    // Determine outer bus channel bounds
    const relevantTables = [from, to, ...hits];
    const topY = Math.min(...relevantTables.map(t => t.y));
    const bottomY = Math.max(...relevantTables.map(t => t.y + t.h));

    // Choose top or bottom bus channel
    const useTop = topY >= 60;
    const laneKey = useTop ? 'bus_top' : 'bus_bottom';
    const lane = laneCounter.get(laneKey) || 0;
    laneCounter.set(laneKey, lane + 1);

    const busY = useTop ? (topY - 36 - (lane % 6) * 14) : (bottomY + 36 + (lane % 6) * 14);
    const side = useTop ? 'top' : 'bottom';

    const fromAnchor = { side, offset: 0.5 };
    const toAnchor = { side, offset: 0.5 };

    const p1 = getTableAnchor(from, e.fc, null, fromAnchor, 0, diagram.diagramLevel);
    const p2 = getTableAnchor(to, e.tc, null, toAnchor, 0, diagram.diagramLevel);

    const waypoints = [
      { x: p1.x, y: busY },
      { x: p2.x, y: busY },
    ];

    diagram.edgeAnchors.set(e.key, { fromAnchor, toAnchor });
    diagram.edgeWaypoints.set(e.key, waypoints);
    modifiedCount++;
  }

  diagram.markDirty();
  diagram.onLayoutChange?.();
  return modifiedCount;
}

/**
 * ALGORITHM 3: A* Grid Collision-Free Router
 * Builds a visibility grid and executes A* with turn penalties to find the shortest collision-free orthogonal path.
 */
export function organizeLinesAStar(diagram, targetKeys = null) {
  const edges = getDiagramEdges(diagram, targetKeys);
  if (!edges.length) return 0;

  diagram.onHistorySnapshot?.(diagram.getSnapshot());
  let modifiedCount = 0;

  for (const e of edges) {
    const obstacles = getObstacles(diagram, e.fk, e.tk);
    const from = e.from;
    const to = e.to;

    const p1 = getTableAnchor(from, e.fc, to, null, 0, diagram.diagramLevel);
    const p2 = getTableAnchor(to, e.tc, from, null, 0, diagram.diagramLevel);

    // If direct route does NOT hit obstacles, leave it direct
    const midX = (p1.x + p2.x) / 2;
    const testPath = [p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2];
    if (!pathIntersectsObstacles(testPath, obstacles, 10)) {
      continue;
    }

    // Build grid coordinates
    const MARGIN = 20;
    const xs = new Set([Math.round(p1.x), Math.round(p2.x)]);
    const ys = new Set([Math.round(p1.y), Math.round(p2.y)]);

    for (const t of [from, to, ...obstacles]) {
      xs.add(Math.round(t.x - MARGIN));
      xs.add(Math.round(t.x + t.w + MARGIN));
      ys.add(Math.round(t.y - MARGIN));
      ys.add(Math.round(t.y + t.h + MARGIN));
    }

    const gridX = Array.from(xs).sort((a, b) => a - b);
    const gridY = Array.from(ys).sort((a, b) => a - b);

    // A* search on gridX x gridY
    const startNode = { x: Math.round(p1.x), y: Math.round(p1.y) };
    const goalNode = { x: Math.round(p2.x), y: Math.round(p2.y) };

    const keyOf = (x, y, dir) => `${x},${y},${dir || ''}`;
    const openSet = [{ x: startNode.x, y: startNode.y, dir: null, g: 0, f: Math.hypot(startNode.x - goalNode.x, startNode.y - goalNode.y), path: [] }];
    const visited = new Map();
    let bestPath = null;
    let iterations = 0;
    const MAX_ITER = 600;

    while (openSet.length > 0 && iterations++ < MAX_ITER) {
      // Pop lowest f
      openSet.sort((a, b) => a.f - b.f);
      const cur = openSet.shift();

      if (Math.hypot(cur.x - goalNode.x, cur.y - goalNode.y) < 2) {
        bestPath = [...cur.path, { x: goalNode.x, y: goalNode.y }];
        break;
      }

      const stateKey = keyOf(cur.x, cur.y, cur.dir);
      if (visited.has(stateKey) && visited.get(stateKey) <= cur.g) continue;
      visited.set(stateKey, cur.g);

      // Find index in gridX, gridY
      const xi = gridX.indexOf(cur.x);
      const yi = gridY.indexOf(cur.y);

      // 4 orthogonal neighbors along adjacent grid lines
      const neighbors = [];
      if (xi > 0) neighbors.push({ x: gridX[xi - 1], y: cur.y, dir: 'h' });
      if (xi < gridX.length - 1) neighbors.push({ x: gridX[xi + 1], y: cur.y, dir: 'h' });
      if (yi > 0) neighbors.push({ x: cur.x, y: gridY[yi - 1], dir: 'v' });
      if (yi < gridY.length - 1) neighbors.push({ x: cur.x, y: gridY[yi + 1], dir: 'v' });

      for (const n of neighbors) {
        // Check if segment from cur to n intersects any obstacle table
        let blocked = false;
        for (const obs of obstacles) {
          if (segmentIntersectsBox(cur, n, obs, 8).hit) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;

        const dist = Math.hypot(n.x - cur.x, n.y - cur.y);
        // Turn penalty of 40px to prefer straight paths and prevent staircase zig-zags
        const turnPenalty = (cur.dir && cur.dir !== n.dir) ? 40 : 0;
        const g = cur.g + dist + turnPenalty;
        const h = Math.abs(n.x - goalNode.x) + Math.abs(n.y - goalNode.y);

        openSet.push({
          x: n.x,
          y: n.y,
          dir: n.dir,
          g,
          f: g + h,
          path: [...cur.path, { x: cur.x, y: cur.y }],
        });
      }
    }

    if (bestPath && bestPath.length > 2) {
      // Clean and remove redundant collinear waypoints
      const cleaned = filterRedundantWaypoints(bestPath, 3);
      // Remove start and end anchors from waypoints list
      const waypoints = cleaned.slice(1, cleaned.length - 1);
      if (waypoints.length) {
        diagram.edgeWaypoints.set(e.key, waypoints);
        modifiedCount++;
      }
    }
  }

  diagram.markDirty();
  diagram.onLayoutChange?.();
  return modifiedCount;
}

/**
 * Reset lines back to clean automatic direct S-bends / L-bends.
 */
export function resetLines(diagram, targetKeys = null) {
  const edges = getDiagramEdges(diagram, targetKeys);
  if (!edges.length) return 0;

  diagram.onHistorySnapshot?.(diagram.getSnapshot());
  let resetCount = 0;

  for (const e of edges) {
    let had = false;
    if (diagram.edgeAnchors.has(e.key)) {
      diagram.edgeAnchors.delete(e.key);
      had = true;
    }
    if (diagram.edgeWaypoints.has(e.key)) {
      diagram.edgeWaypoints.delete(e.key);
      had = true;
    }
    if (had) resetCount++;
  }

  diagram.markDirty();
  diagram.onLayoutChange?.();
  return resetCount;
}
