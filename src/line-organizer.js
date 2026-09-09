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
 * Extract active group bounding boxes from diagram annotations or model groups.
 */
export function getDiagramGroups(diagram) {
  const groups = [];
  const byKey = new Map((diagram.model?.tables || []).map(t => [t.key.toLowerCase(), t]));

  // 1. From diagram.annotations (groups on canvas)
  if (Array.isArray(diagram.annotations) && diagram.annotations.length) {
    for (const a of diagram.annotations) {
      if (a.type === 'group' && Array.isArray(a.tables) && a.tables.length > 0) {
        const memberTables = a.tables
          .map(k => byKey.get(String(k).toLowerCase()))
          .filter(t => t && Number.isFinite(t.x));

        if (memberTables.length > 0) {
          const PAD = 24;
          const minX = Math.min(...memberTables.map(t => t.x)) - PAD;
          const minY = Math.min(...memberTables.map(t => t.y)) - PAD;
          const maxX = Math.max(...memberTables.map(t => t.x + t.w)) + PAD;
          const maxY = Math.max(...memberTables.map(t => t.y + t.h)) + PAD;

          groups.push({
            id: a.id || a.text,
            name: a.text || 'Group',
            tables: new Set(a.tables.map(t => String(t).toLowerCase())),
            x: minX,
            y: minY,
            w: maxX - minX,
            h: maxY - minY,
          });
        }
      }
    }
  }

  // 2. Fallback: diagram.model.groups
  if (!groups.length && Array.isArray(diagram.model?.groups) && diagram.model.groups.length) {
    for (const g of diagram.model.groups) {
      const gTables = (g.tables || []).map(t => String(t).toLowerCase());
      const memberTables = gTables
        .map(k => byKey.get(k))
        .filter(t => t && Number.isFinite(t.x));

      if (memberTables.length > 0) {
        const PAD = 24;
        const minX = Math.min(...memberTables.map(t => t.x)) - PAD;
        const minY = Math.min(...memberTables.map(t => t.y)) - PAD;
        const maxX = Math.max(...memberTables.map(t => t.x + t.w)) + PAD;
        const maxY = Math.max(...memberTables.map(t => t.y + t.h)) + PAD;

        groups.push({
          id: g.name,
          name: g.name || 'Group',
          tables: new Set(gTables),
          x: minX,
          y: minY,
          w: maxX - minX,
          h: maxY - minY,
        });
      }
    }
  }

  return groups;
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
 * ALGORITHM 4: ELK Layered Port Allocation & Manhattan Channel Router
 * Industry-standard approach from Eclipse ELK / yFiles:
 * 1. Categorizes natural approach faces between source and target boxes.
 * 2. Port Sorter Heuristic: Sorts all edge endpoints on each face (N, S, E, W)
 *    by the physical coordinate (X for top/bottom, Y for left/right) of their target node.
 *    This completely eliminates crossings at node boundaries!
 * 3. Channel Router: Routes inter-group / blocked connections through obstacle-free
 *    corridors with indexed tracks (laneOffsets) to prevent collisions and overlap.
 */
export function organizeLinesElkPorts(diagram, targetKeys = null) {
  const edges = getDiagramEdges(diagram, targetKeys);
  if (!edges.length) return 0;

  diagram.onHistorySnapshot?.(diagram.getSnapshot());

  // Step 1: Determine natural faces for each edge endpoint
  const tablePorts = new Map();
  const getTablePortList = (tableKey, side) => {
    const k = (tableKey || '').toLowerCase();
    if (!tablePorts.has(k)) {
      tablePorts.set(k, { top: [], bottom: [], left: [], right: [] });
    }
    return tablePorts.get(k)[side];
  };

  const edgeAssignments = new Map();

  for (const e of edges) {
    const from = e.from;
    const to = e.to;
    const obstacles = getObstacles(diagram, e.fk, e.tk);

    const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
    const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
    const dx = toCenter.x - fromCenter.x;
    const dy = toCenter.y - fromCenter.y;

    let fromSide, toSide;
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (dx >= 0) {
        fromSide = 'right';
        toSide = 'left';
      } else {
        fromSide = 'left';
        toSide = 'right';
      }
    } else {
      if (dy >= 0) {
        fromSide = 'bottom';
        toSide = 'top';
      } else {
        fromSide = 'top';
        toSide = 'bottom';
      }
    }

    // Test whether the natural orthogonal path intersects intermediate obstacles
    const p1Test = getTableAnchor(from, e.fc, null, { side: fromSide, offset: 0.5 }, 0, diagram.diagramLevel);
    const p2Test = getTableAnchor(to, e.tc, null, { side: toSide, offset: 0.5 }, 0, diagram.diagramLevel);
    const midX = (p1Test.x + p2Test.x) / 2;
    const testPath = [p1Test, { x: midX, y: p1Test.y }, { x: midX, y: p2Test.y }, p2Test];
    const directHits = obstacles.filter(obs => pathIntersectsObstacles(testPath, [obs], 8));

    if (directHits.length > 0) {
      // Direct orthogonal path is blocked by intermediate tables (e.g. rol -> [permiso] -> rol_permiso)
      if (Math.abs(dx) >= Math.abs(dy)) {
        const useTop = Math.min(from.y, to.y, ...directHits.map(o => o.y)) >= 40;
        fromSide = useTop ? 'top' : 'bottom';
        toSide = useTop ? 'top' : 'bottom';
      } else {
        const useLeft = Math.min(from.x, to.x, ...directHits.map(o => o.x)) >= 40;
        fromSide = useLeft ? 'left' : 'right';
        toSide = useLeft ? 'left' : 'right';
      }
    }

    edgeAssignments.set(e.key, { edge: e, fromSide, toSide, directHits });
  }

  // Register all endpoints into tablePorts for port sorting
  for (const [key, assign] of edgeAssignments.entries()) {
    const { edge, fromSide, toSide } = assign;
    getTablePortList(edge.fk, fromSide).push({
      key,
      isFrom: true,
      partnerTable: edge.to,
      edge,
    });
    getTablePortList(edge.tk, toSide).push({
      key,
      isFrom: false,
      partnerTable: edge.from,
      edge,
    });
  }

  // Step 2: Port Sorter Heuristic (ELK / yFiles)
  // For each table and each side, sort ports so lines never cross at the perimeter
  const computedAnchors = new Map();

  for (const [tableKey, sides] of tablePorts.entries()) {
    for (const [side, ports] of Object.entries(sides)) {
      if (!ports.length) continue;

      if (side === 'top' || side === 'bottom') {
        // Horizontal side: sort by partner center X
        ports.sort((a, b) => {
          const ax = a.partnerTable.x + a.partnerTable.w / 2;
          const bx = b.partnerTable.x + b.partnerTable.w / 2;
          return ax - bx;
        });
      } else {
        // Vertical side: sort by partner center Y
        ports.sort((a, b) => {
          const ay = a.partnerTable.y + a.partnerTable.h / 2;
          const by = b.partnerTable.y + b.partnerTable.h / 2;
          return ay - by;
        });
      }

      // Distribute offsets evenly
      const N = ports.length;
      for (let i = 0; i < N; i++) {
        const item = ports[i];
        const offset = N === 1 ? 0.5 : 0.15 + (i / (N - 1)) * 0.7;

        if (!computedAnchors.has(item.key)) {
          computedAnchors.set(item.key, {});
        }
        const obj = computedAnchors.get(item.key);
        if (item.isFrom) {
          obj.fromAnchor = { side, offset };
        } else {
          obj.toAnchor = { side, offset };
        }
      }
    }
  }

  // Step 3: Channel Router & Waypoint generation
  let modifiedCount = 0;
  const channelCounter = new Map();

  for (const e of edges) {
    const assign = edgeAssignments.get(e.key);
    const anchors = computedAnchors.get(e.key);
    if (!assign || !anchors?.fromAnchor || !anchors?.toAnchor) continue;

    const fromAnchor = anchors.fromAnchor;
    const toAnchor = anchors.toAnchor;
    diagram.edgeAnchors.set(e.key, { fromAnchor, toAnchor });

    const p1 = getTableAnchor(e.from, e.fc, null, fromAnchor, 0, diagram.diagramLevel);
    const p2 = getTableAnchor(e.to, e.tc, null, toAnchor, 0, diagram.diagramLevel);

    const obstacles = getObstacles(diagram, e.fk, e.tk);

    // If both anchors are on top/bottom, route via corridor channel
    if (fromAnchor.side === toAnchor.side && (fromAnchor.side === 'top' || fromAnchor.side === 'bottom')) {
      const useTop = fromAnchor.side === 'top';
      const hits = assign.directHits.length ? assign.directHits : obstacles;
      const relevant = [e.from, e.to, ...hits];
      const minY = Math.min(...relevant.map(t => t.y));
      const maxY = Math.max(...relevant.map(t => t.y + t.h));

      const chanKey = useTop ? `top_chan_${Math.round(minY / 150)}` : `bot_chan_${Math.round(maxY / 150)}`;
      const trackIdx = channelCounter.get(chanKey) || 0;
      channelCounter.set(chanKey, trackIdx + 1);

      const trackOffset = (trackIdx % 6) * 14;
      const detourY = useTop ? (minY - 26 - trackOffset) : (maxY + 26 + trackOffset);

      diagram.edgeWaypoints.set(e.key, [
        { x: p1.x, y: detourY },
        { x: p2.x, y: detourY },
      ]);
      modifiedCount++;
    } else if (fromAnchor.side === toAnchor.side && (fromAnchor.side === 'left' || fromAnchor.side === 'right')) {
      const useLeft = fromAnchor.side === 'left';
      const hits = assign.directHits.length ? assign.directHits : obstacles;
      const relevant = [e.from, e.to, ...hits];
      const minX = Math.min(...relevant.map(t => t.x));
      const maxX = Math.max(...relevant.map(t => t.x + t.w));

      const chanKey = useLeft ? `left_chan_${Math.round(minX / 150)}` : `right_chan_${Math.round(maxX / 150)}`;
      const trackIdx = channelCounter.get(chanKey) || 0;
      channelCounter.set(chanKey, trackIdx + 1);

      const trackOffset = (trackIdx % 6) * 14;
      const detourX = useLeft ? (minX - 26 - trackOffset) : (maxX + 26 + trackOffset);

      diagram.edgeWaypoints.set(e.key, [
        { x: detourX, y: p1.y },
        { x: detourX, y: p2.y },
      ]);
      modifiedCount++;
    } else {
      // Check if natural S-bend or L-bend intersects any obstacle
      const midX = (p1.x + p2.x) / 2;
      const testPath = [p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2];
      const blocked = pathIntersectsObstacles(testPath, obstacles, 8);

      if (blocked) {
        // Route via corridor channel
        const allRelevant = [e.from, e.to, ...obstacles.filter(o => segmentIntersectsBox(p1, p2, o, 10).hit)];
        const minY = Math.min(...allRelevant.map(t => t.y));
        const chanKey = `obs_detour_${Math.round(minY / 150)}`;
        const trackIdx = channelCounter.get(chanKey) || 0;
        channelCounter.set(chanKey, trackIdx + 1);

        const detourY = minY - 26 - (trackIdx % 5) * 14;
        diagram.edgeWaypoints.set(e.key, [
          { x: p1.x, y: detourY },
          { x: p2.x, y: detourY },
        ]);
        modifiedCount++;
      } else {
        // Clean direct route with sorted ports: clear any old waypoints
        if (diagram.edgeWaypoints.has(e.key)) {
          diagram.edgeWaypoints.delete(e.key);
        }
        modifiedCount++;
      }
    }
  }

  diagram.markDirty();
  diagram.onLayoutChange?.();
  return modifiedCount;
}

/**
 * ALGORITHM 5: Clustered Orthogonal Highway Router (OGDF Figure 15.14)
 * Inspired by OGDF's ClusterPlanarizationLayout:
 * 1. Clusters (Domains) form inviolable territorial boundaries.
 * 2. Intra-cluster relations (same domain) route locally with obstacle avoidance inside the group.
 * 3. Inter-cluster relations (between domains) route through inter-cluster avenues
 *    or outer perimeter express highways (North, South, East, West), completely circumnavigating
 *    foreign groups and never penetrating any obstacle table.
 * 4. Pistas separadas (laneOffset) en cada autopista para evitar solapamientos.
 */
export function organizeLinesClusterHighways(diagram, targetKeys = null) {
  const edges = getDiagramEdges(diagram, targetKeys);
  if (!edges.length) return 0;

  diagram.onHistorySnapshot?.(diagram.getSnapshot());

  const groups = getDiagramGroups(diagram);
  const allTables = diagram.model?.tables || [];

  // Map tableKey -> Group
  const tableToGroup = new Map();
  for (const g of groups) {
    for (const tk of g.tables) {
      tableToGroup.set(tk, g);
    }
  }

  // Calculate overall diagram bounds across all tables and groups
  const minDiagramX = Math.min(...allTables.map(t => t.x), ...groups.map(g => g.x), 50);
  const maxDiagramX = Math.max(...allTables.map(t => t.x + t.w), ...groups.map(g => g.x + g.w), 800);
  const minDiagramY = Math.min(...allTables.map(t => t.y), ...groups.map(g => g.y), 50);
  const maxDiagramY = Math.max(...allTables.map(t => t.y + t.h), ...groups.map(g => g.y + g.h), 600);

  let modifiedCount = 0;
  const highwayLaneCounter = new Map();

  for (const e of edges) {
    const fromGroup = tableToGroup.get(e.fk);
    const toGroup = tableToGroup.get(e.tk);
    const from = e.from;
    const to = e.to;

    const isIntraCluster = fromGroup && toGroup && fromGroup === toGroup;

    if (isIntraCluster) {
      // 1. INTRA-CLUSTER: local connection inside the same domain
      const localObstacles = getObstacles(diagram, e.fk, e.tk).filter(obs => fromGroup.tables.has(obs.key.toLowerCase()));

      const p1 = getTableAnchor(from, e.fc, to, null, 0, diagram.diagramLevel);
      const p2 = getTableAnchor(to, e.tc, from, null, 0, diagram.diagramLevel);
      const midX = (p1.x + p2.x) / 2;
      const testPath = [p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2];

      const blocked = pathIntersectsObstacles(testPath, localObstacles, 6);
      if (blocked) {
        // Detour inside the group bounds
        const useTop = Math.min(from.y, to.y) >= (fromGroup.y + 30);
        const detourY = useTop ? (fromGroup.y + 14) : (fromGroup.y + fromGroup.h - 14);
        const side = useTop ? 'top' : 'bottom';
        const fromAnchor = { side, offset: 0.5 };
        const toAnchor = { side, offset: 0.5 };

        diagram.edgeAnchors.set(e.key, { fromAnchor, toAnchor });
        diagram.edgeWaypoints.set(e.key, [
          { x: p1.x, y: detourY },
          { x: p2.x, y: detourY },
        ]);
        modifiedCount++;
      } else {
        if (diagram.edgeWaypoints.has(e.key)) {
          diagram.edgeWaypoints.delete(e.key);
        }
        modifiedCount++;
      }
    } else {
      // 2. INTER-CLUSTER: connection crossing between different groups (or ungrouped tables)
      // Foreign groups that must NOT be penetrated:
      const foreignGroups = groups.filter(g => g !== fromGroup && g !== toGroup);
      const foreignObstacles = [
        ...foreignGroups,
        ...allTables.filter(t => {
          const k = t.key.toLowerCase();
          return k !== e.fk && k !== e.tk && !fromGroup?.tables.has(k) && !toGroup?.tables.has(k);
        }),
      ];

      const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
      const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
      const dx = toCenter.x - fromCenter.x;
      const dy = toCenter.y - fromCenter.y;

      let fromSide, toSide;
      if (Math.abs(dx) >= Math.abs(dy)) {
        fromSide = dx >= 0 ? 'right' : 'left';
        toSide = dx >= 0 ? 'left' : 'right';
      } else {
        fromSide = dy >= 0 ? 'bottom' : 'top';
        toSide = dy >= 0 ? 'top' : 'bottom';
      }

      const fromAnchor = { side: fromSide, offset: 0.5 };
      const toAnchor = { side: toSide, offset: 0.5 };
      diagram.edgeAnchors.set(e.key, { fromAnchor, toAnchor });

      const p1 = getTableAnchor(from, e.fc, null, fromAnchor, 0, diagram.diagramLevel);
      const p2 = getTableAnchor(to, e.tc, null, toAnchor, 0, diagram.diagramLevel);

      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const directAvenuePath = Math.abs(dx) >= Math.abs(dy)
        ? [p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2]
        : [p1, { x: p1.x, y: midY }, { x: p2.x, y: midY }, p2];

      const directBlocked = pathIntersectsObstacles(directAvenuePath, foreignObstacles, 10);

      if (!directBlocked) {
        // Direct inter-cluster avenue is clear
        const avenueKey = Math.abs(dx) >= Math.abs(dy) ? `ave_x_${Math.round(midX / 120)}` : `ave_y_${Math.round(midY / 120)}`;
        const lane = highwayLaneCounter.get(avenueKey) || 0;
        highwayLaneCounter.set(avenueKey, lane + 1);
        const laneShift = ((lane % 5) - 2) * 12;

        if (Math.abs(dx) >= Math.abs(dy)) {
          const shiftedX = midX + laneShift;
          diagram.edgeWaypoints.set(e.key, [
            { x: shiftedX, y: p1.y },
            { x: shiftedX, y: p2.y },
          ]);
        } else {
          const shiftedY = midY + laneShift;
          diagram.edgeWaypoints.set(e.key, [
            { x: p1.x, y: shiftedY },
            { x: p2.x, y: shiftedY },
          ]);
        }
        modifiedCount++;
      } else {
        // Direct avenue is blocked by intermediate groups (like Figure 15.14 of OGDF!)
        // Circumnavigate via outer express highway (North, South, East, or West)
        const canUseTop = minDiagramY >= 30;
        const preferTop = dy <= 0 || canUseTop;
        const usePerimeterEast = dx > 0 && Math.abs(dx) > 600;

        if (usePerimeterEast) {
          // East Highway (like the blue line on the right in Fig 15.14!)
          const lane = highwayLaneCounter.get('hwy_east') || 0;
          highwayLaneCounter.set('hwy_east', lane + 1);
          const hwyX = maxDiagramX + 36 + (lane % 6) * 14;

          diagram.edgeWaypoints.set(e.key, [
            { x: hwyX, y: p1.y },
            { x: hwyX, y: p2.y },
          ]);
        } else if (preferTop) {
          // North Highway (like the red lines across the top in Fig 15.14!)
          const lane = highwayLaneCounter.get('hwy_north') || 0;
          highwayLaneCounter.set('hwy_north', lane + 1);
          const hwyY = Math.min(from.y, to.y, minDiagramY) - 36 - (lane % 6) * 14;

          diagram.edgeWaypoints.set(e.key, [
            { x: p1.x, y: hwyY },
            { x: p2.x, y: hwyY },
          ]);
        } else {
          // South Highway
          const lane = highwayLaneCounter.get('hwy_south') || 0;
          highwayLaneCounter.set('hwy_south', lane + 1);
          const hwyY = Math.max(from.y + from.h, to.y + to.h, maxDiagramY) + 36 + (lane % 6) * 14;

          diagram.edgeWaypoints.set(e.key, [
            { x: p1.x, y: hwyY },
            { x: p2.x, y: hwyY },
          ]);
        }
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

/* ------------------------------------------------------------------------ *
 * ALGORITHM 6: Shortest Orthogonal Path with Free Perimeter Ports
 * ------------------------------------------------------------------------
 * Wipes every existing vertex and anchor position, then recomputes each line
 * from scratch as the shortest 90 degree route between ANY point of the source
 * perimeter and ANY point of the target perimeter, never coming closer than
 * SP_CLEARANCE to a table that is not one of its two endpoints.
 *
 * 1. Hanan grid: candidate corridors are the lines offset SP_CLEARANCE around
 *    every nearby table, plus each table dockable span limit and centre.
 * 2. Multi-source / multi-target A* over (node, travel direction) states, so a
 *    90 degree corner has a real cost. Length dominates; SP_TURN_COST only
 *    breaks ties towards fewer vertices.
 * 3. Lane separation: segments that end up sharing a corridor are pushed apart
 *    by SP_LANE_GAP; a shifted endpoint segment simply slides its anchor along
 *    the docking face. Any shift that would break clearance is reverted.
 * Tables are never moved. Corners render 90 degrees and rounded.
 */

const SP_CLEARANCE = 16;    // minimum gap kept from every foreign table
const SP_STUB = 16;         // perpendicular stub leaving each anchor (== clearance, so it lands on the grid)
const SP_TURN_COST = 20;    // px charged per corner; shortest length still wins
const SP_LANE_GAP = 12;     // separation applied to lines sharing a corridor
const SP_SEARCH_PAD = 300;  // how far past the endpoint bbox the grid may reach
const SP_MAX_AXIS = 64;     // hard cap of grid lines per axis
const SP_PORTS_PER_SIDE = 9;
const SP_MAX_POPS = 60000;

/** Binary min-heap on `.f`, so A* does not pay a sort per pop. */
class SpHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(n) {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      const t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        const t = a[m]; a[m] = a[i]; a[i] = t;
        i = m;
      }
    }
    return top;
  }
}

/** Dockable span of a table face, matching the clamps applied by getTableAnchor. */
function spSpan(t, vertical) {
  return vertical
    ? { lo: Math.ceil(t.y + 20), hi: Math.floor(t.y + t.h - 10) }
    : { lo: Math.ceil(t.x + 16), hi: Math.floor(t.x + t.w - 16) };
}

function spSample(list, limit) {
  if (list.length <= limit) return list;
  const out = [];
  const step = (list.length - 1) / (limit - 1);
  for (let i = 0; i < limit; i++) out.push(list[Math.round(i * step)]);
  return Array.from(new Set(out));
}

/**
 * Build the routing grid for one edge: corridors around the endpoints (never
 * pruned) plus corridors around the tables near them (pruned to SP_MAX_AXIS).
 */
function spBuildGrid(from, to, tables) {
  const focusX = (from.x + from.w / 2 + to.x + to.w / 2) / 2;
  const focusY = (from.y + from.h / 2 + to.y + to.h / 2) / 2;
  const rx0 = Math.min(from.x, to.x) - SP_SEARCH_PAD;
  const rx1 = Math.max(from.x + from.w, to.x + to.w) + SP_SEARCH_PAD;
  const ry0 = Math.min(from.y, to.y) - SP_SEARCH_PAD;
  const ry1 = Math.max(from.y + from.h, to.y + to.h) + SP_SEARCH_PAD;

  const reqX = new Set(), reqY = new Set(), optX = new Set(), optY = new Set();
  const feed = (t, xSet, ySet) => {
    const hSpan = spSpan(t, false);
    const vSpan = spSpan(t, true);
    xSet.add(Math.round(t.x - SP_CLEARANCE));
    xSet.add(Math.round(t.x + t.w + SP_CLEARANCE));
    xSet.add(hSpan.lo);
    xSet.add(hSpan.hi);
    xSet.add(Math.round(t.x + t.w / 2));
    ySet.add(Math.round(t.y - SP_CLEARANCE));
    ySet.add(Math.round(t.y + t.h + SP_CLEARANCE));
    ySet.add(vSpan.lo);
    ySet.add(vSpan.hi);
    ySet.add(Math.round(t.y + t.h / 2));
  };
  feed(from, reqX, reqY);
  feed(to, reqX, reqY);

  let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity;
  for (const t of tables) {
    gx0 = Math.min(gx0, t.x); gx1 = Math.max(gx1, t.x + t.w);
    gy0 = Math.min(gy0, t.y); gy1 = Math.max(gy1, t.y + t.h);
    if (t === from || t === to) continue;
    if (t.x + t.w < rx0 || t.x > rx1 || t.y + t.h < ry0 || t.y > ry1) continue;
    feed(t, optX, optY);
  }
  // Escape corridors around the whole diagram, so a line can always get around.
  if (Number.isFinite(gx0)) {
    reqX.add(Math.round(gx0 - 48)); reqX.add(Math.round(gx1 + 48));
    reqY.add(Math.round(gy0 - 48)); reqY.add(Math.round(gy1 + 48));
  }

  const merge = (req, opt, focus) => {
    for (const v of req) opt.delete(v);
    let extra = Array.from(opt);
    const room = SP_MAX_AXIS - req.size;
    if (extra.length > room) {
      extra.sort((a, b) => Math.abs(a - focus) - Math.abs(b - focus));
      extra = extra.slice(0, Math.max(0, room));
    }
    return Array.from(new Set([...req, ...extra])).sort((a, b) => a - b);
  };

  return { xs: merge(reqX, optX, focusX), ys: merge(reqY, optY, focusY) };
}

/**
 * Candidate docking ports covering all four faces of a table. Each port carries
 * the anchor point (on the perimeter) and its stub node (a grid intersection).
 */
function spPorts(table, xs, ys) {
  const ports = [];
  const pick = (grid, span, mid) => {
    if (span.hi < span.lo) return [];
    const set = new Set([span.lo, span.hi]);
    const m = Math.round(mid);
    if (m >= span.lo && m <= span.hi) set.add(m);
    for (const v of grid) if (v >= span.lo && v <= span.hi) set.add(v);
    return spSample(Array.from(set).sort((a, b) => a - b), SP_PORTS_PER_SIDE);
  };

  const outL = Math.round(table.x - SP_CLEARANCE);
  const outR = Math.round(table.x + table.w + SP_CLEARANCE);
  const outT = Math.round(table.y - SP_CLEARANCE);
  const outB = Math.round(table.y + table.h + SP_CLEARANCE);

  for (const y of pick(ys, spSpan(table, true), table.y + table.h / 2)) {
    ports.push({ side: 'left', x: table.x, y, dir: 0, sx: outL, sy: y });
    ports.push({ side: 'right', x: table.x + table.w, y, dir: 0, sx: outR, sy: y });
  }
  for (const x of pick(xs, spSpan(table, false), table.x + table.w / 2)) {
    ports.push({ side: 'top', x, y: table.y, dir: 1, sx: x, sy: outT });
    ports.push({ side: 'bottom', x, y: table.y + table.h, dir: 1, sx: x, sy: outB });
  }
  return ports;
}

/** A segment is legal when it clears every foreign table and cuts through neither endpoint box. */
function spSegmentClear(a, b, from, to, foreign) {
  for (const o of foreign) {
    if (segmentIntersectsBox(a, b, o, SP_CLEARANCE - 0.5).hit) return false;
  }
  if (segmentIntersectsBox(a, b, from, -1).hit) return false;
  if (segmentIntersectsBox(a, b, to, -1).hit) return false;
  return true;
}

/** Multi-source / multi-target A* over (grid node, travel direction) states. */
function spRoute(from, to, foreign, xs, ys, fromPorts, toPorts) {
  const NX = xs.length, NY = ys.length;
  const N = NX * NY;
  if (!N) return null;

  const xIdx = new Map(); xs.forEach((v, i) => xIdx.set(v, i));
  const yIdx = new Map(); ys.forEach((v, i) => yIdx.set(v, i));

  const hEdge = new Uint8Array(N); // 0 unknown, 1 free, 2 blocked
  const vEdge = new Uint8Array(N);
  const hOk = (i, j) => {
    const k = j * NX + i;
    if (hEdge[k]) return hEdge[k] === 1;
    const ok = spSegmentClear({ x: xs[i], y: ys[j] }, { x: xs[i + 1], y: ys[j] }, from, to, foreign);
    hEdge[k] = ok ? 1 : 2;
    return ok;
  };
  const vOk = (i, j) => {
    const k = j * NX + i;
    if (vEdge[k]) return vEdge[k] === 1;
    const ok = spSegmentClear({ x: xs[i], y: ys[j] }, { x: xs[i], y: ys[j + 1] }, from, to, foreign);
    vEdge[k] = ok ? 1 : 2;
    return ok;
  };

  const gScore = new Float64Array(N * 2).fill(Infinity);
  const parent = new Int32Array(N * 2).fill(-1);
  const heap = new SpHeap();

  // Admissible heuristic: Manhattan distance to the target clearance box.
  const hx0 = to.x - SP_CLEARANCE, hx1 = to.x + to.w + SP_CLEARANCE;
  const hy0 = to.y - SP_CLEARANCE, hy1 = to.y + to.h + SP_CLEARANCE;
  const heur = (x, y) => {
    const dx = x < hx0 ? hx0 - x : (x > hx1 ? x - hx1 : 0);
    const dy = y < hy0 ? hy0 - y : (y > hy1 ? y - hy1 : 0);
    return dx + dy;
  };

  const stubClear = (port, partner) => {
    const a = { x: port.x, y: port.y };
    const b = { x: port.sx, y: port.sy };
    for (const o of foreign) {
      if (segmentIntersectsBox(a, b, o, SP_CLEARANCE - 0.5).hit) return false;
    }
    return !segmentIntersectsBox(a, b, partner, -1).hit;
  };

  const startPort = new Map();
  for (const p of fromPorts) {
    const i = xIdx.get(p.sx), j = yIdx.get(p.sy);
    if (i === undefined || j === undefined) continue;
    if (!stubClear(p, to)) continue;
    const s = ((j * NX + i) << 1) | p.dir;
    if (SP_STUB >= gScore[s]) continue;
    gScore[s] = SP_STUB;
    startPort.set(s, p);
    heap.push({ s, g: SP_STUB, f: SP_STUB + heur(xs[i], ys[j]) });
  }
  if (!startPort.size) return null;

  const goalAt = new Map();
  for (const p of toPorts) {
    const i = xIdx.get(p.sx), j = yIdx.get(p.sy);
    if (i === undefined || j === undefined) continue;
    if (!stubClear(p, from)) continue;
    const node = j * NX + i;
    if (!goalAt.has(node)) goalAt.set(node, []);
    goalAt.get(node).push(p);
  }
  if (!goalAt.size) return null;

  let best = Infinity, bestState = -1, bestPort = null;
  let pops = 0;

  while (heap.size && pops++ < SP_MAX_POPS) {
    const cur = heap.pop();
    if (cur.g > gScore[cur.s]) continue;
    if (cur.f >= best) break;

    const s = cur.s;
    const dir = s & 1;
    const node = s >> 1;
    const i = node % NX;
    const j = (node / NX) | 0;

    const gp = goalAt.get(node);
    if (gp) {
      for (const p of gp) {
        const tot = cur.g + SP_STUB + (p.dir === dir ? 0 : SP_TURN_COST);
        if (tot < best) { best = tot; bestState = s; bestPort = p; }
      }
    }

    const relax = (ni, nj, ndir) => {
      const ns = ((nj * NX + ni) << 1) | ndir;
      if (startPort.has(ns)) return;
      const len = ndir === 0 ? Math.abs(xs[ni] - xs[i]) : Math.abs(ys[nj] - ys[j]);
      const ng = cur.g + len + (ndir === dir ? 0 : SP_TURN_COST);
      if (ng >= gScore[ns]) return;
      gScore[ns] = ng;
      parent[ns] = s;
      heap.push({ s: ns, g: ng, f: ng + heur(xs[ni], ys[nj]) });
    };

    if (i > 0 && hOk(i - 1, j)) relax(i - 1, j, 0);
    if (i < NX - 1 && hOk(i, j)) relax(i + 1, j, 0);
    if (j > 0 && vOk(i, j - 1)) relax(i, j - 1, 1);
    if (j < NY - 1 && vOk(i, j)) relax(i, j + 1, 1);
  }

  if (bestState < 0) return null;

  const nodes = [];
  let s = bestState;
  let guard = 0;
  while (s >= 0 && guard++ < 20000) {
    const node = s >> 1;
    nodes.push({ x: xs[node % NX], y: ys[(node / NX) | 0] });
    if (startPort.has(s)) break;
    s = parent[s];
  }
  const src = s >= 0 ? startPort.get(s) : null;
  if (!src) return null;
  nodes.reverse();

  return {
    pts: [{ x: src.x, y: src.y }, ...nodes, { x: bestPort.x, y: bestPort.y }],
    fromPort: src,
    toPort: bestPort,
    cost: best,
  };
}

function spRouteValid(pts, from, to, foreign) {
  if (!pts || pts.length < 2) return false;
  const last = pts.length - 2;
  for (let i = 0; i <= last; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if ((i === 0 || i === last) && len < 8) return false;
    if (!spSegmentClear(a, b, from, to, foreign)) return false;
  }
  return true;
}

function spAssignLanes(cluster) {
  if (cluster.length < 2) return;
  cluster.sort((a, b) => a.lo - b.lo);
  const placed = [];
  for (const s of cluster) {
    const used = new Set();
    for (const p of placed) {
      if (p.lo < s.hi - 2 && s.lo < p.hi - 2) used.add(p.lane);
    }
    let lane = 0;
    while (used.has(lane)) lane++;
    s.lane = lane;
    placed.push(s);
  }
}

/**
 * Push apart segments that ended up sharing the same corridor. Shifting the
 * first or last segment slides its anchor along the docking face; a shift that
 * would break clearance (or crush a stub) reverts the whole route.
 */
function spSeparateLanes(routes) {
  const segs = [];
  for (let ri = 0; ri < routes.length; ri++) {
    const pts = routes[ri].pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const horiz = Math.abs(a.y - b.y) < 0.5;
      const vert = Math.abs(a.x - b.x) < 0.5;
      if (horiz === vert) continue;
      segs.push({
        ri, i, horiz, lane: 0,
        coord: horiz ? a.y : a.x,
        lo: horiz ? Math.min(a.x, b.x) : Math.min(a.y, b.y),
        hi: horiz ? Math.max(a.x, b.x) : Math.max(a.y, b.y),
      });
    }
  }

  for (const axis of [true, false]) {
    const list = segs.filter(s => s.horiz === axis).sort((a, b) => a.coord - b.coord);
    let start = 0;
    for (let i = 1; i <= list.length; i++) {
      if (i === list.length || list[i].coord - list[i - 1].coord > 4) {
        spAssignLanes(list.slice(start, i));
        start = i;
      }
    }
  }

  const shifts = new Map();
  for (const s of segs) {
    if (!s.lane) continue;
    const step = Math.ceil(s.lane / 2) * SP_LANE_GAP;
    const delta = (s.lane % 2 === 1) ? step : -step;
    if (!shifts.has(s.ri)) shifts.set(s.ri, []);
    shifts.get(s.ri).push({ i: s.i, horiz: s.horiz, delta });
  }

  for (const [ri, list] of shifts.entries()) {
    const r = routes[ri];
    const pts = r.pts;
    const original = pts.map(p => ({ x: p.x, y: p.y }));
    const last = pts.length - 2;
    let ok = true;

    for (const sh of list) {
      const ends = [];
      if (sh.i === 0) ends.push({ pt: pts[0], t: r.e.from });
      if (sh.i === last) ends.push({ pt: pts[pts.length - 1], t: r.e.to });
      for (const end of ends) {
        const span = spSpan(end.t, sh.horiz);
        const next = (sh.horiz ? end.pt.y : end.pt.x) + sh.delta;
        if (next < span.lo || next > span.hi) { ok = false; break; }
      }
      if (!ok) break;
      if (sh.horiz) { pts[sh.i].y += sh.delta; pts[sh.i + 1].y += sh.delta; }
      else { pts[sh.i].x += sh.delta; pts[sh.i + 1].x += sh.delta; }
    }

    if (!ok || !spRouteValid(pts, r.e.from, r.e.to, r.foreign)) {
      r.pts = original;
    }
  }
}

function spOffset(t, pt, side) {
  if (side === 'left' || side === 'right') return t.h ? (pt.y - t.y) / t.h : 0.5;
  return t.w ? (pt.x - t.x) / t.w : 0.5;
}

/**
 * Public entry point: clear every vertex and anchor, then re-route each line as
 * the shortest obstacle-free 90 degree path between the two table perimeters.
 */
export function organizeLinesShortestPath(diagram, targetKeys = null) {
  const edges = getDiagramEdges(diagram, targetKeys);
  if (!edges.length) return 0;

  diagram.onHistorySnapshot?.(diagram.getSnapshot());

  // Corners are always 90 degrees and rounded for this organizer.
  diagram.edgeRouting = 'ortho-rounded';

  const tables = (diagram.model?.tables || []).filter(
    t => Number.isFinite(t.x) && !diagram.hidden?.has((t.key || '').toLowerCase())
  );

  const routes = [];
  for (const e of edges) {
    // Drop the current vertices and anchor positions before recomputing.
    diagram.edgeWaypoints.delete(e.key);
    diagram.edgeAnchors.delete(e.key);
    diagram.edgeRoutings?.delete(e.key);

    const foreign = tables.filter(t => {
      const k = (t.key || '').toLowerCase();
      return k !== e.fk && k !== e.tk;
    });

    const grid = spBuildGrid(e.from, e.to, tables);
    const res = spRoute(
      e.from, e.to, foreign, grid.xs, grid.ys,
      spPorts(e.from, grid.xs, grid.ys),
      spPorts(e.to, grid.xs, grid.ys)
    );
    if (!res) continue;

    routes.push({
      e,
      foreign,
      pts: filterRedundantWaypoints(res.pts, 0.5),
      fromPort: res.fromPort,
      toPort: res.toPort,
    });
  }

  spSeparateLanes(routes);

  let count = 0;
  for (const r of routes) {
    const pts = r.pts;
    const fromAnchor = { side: r.fromPort.side, offset: spOffset(r.e.from, pts[0], r.fromPort.side) };
    const toAnchor = { side: r.toPort.side, offset: spOffset(r.e.to, pts[pts.length - 1], r.toPort.side) };

    const p1 = getTableAnchor(r.e.from, r.e.fc, null, fromAnchor, 0, diagram.diagramLevel);
    const p2 = getTableAnchor(r.e.to, r.e.tc, null, toAnchor, 0, diagram.diagramLevel);

    // Re-seat the endpoints on the exact points the renderer will use, keeping
    // each stub perpendicular to its docking face.
    const final = pts.map(p => ({ x: p.x, y: p.y }));
    final[0] = { x: p1.x, y: p1.y };
    final[final.length - 1] = { x: p2.x, y: p2.y };
    if (final.length > 2) {
      if (r.fromPort.dir === 0) final[1].y = p1.y; else final[1].x = p1.x;
      if (r.toPort.dir === 0) final[final.length - 2].y = p2.y; else final[final.length - 2].x = p2.x;
    }

    diagram.edgeAnchors.set(r.e.key, { fromAnchor, toAnchor });
    const interior = filterRedundantWaypoints(final, 0.5).slice(1, -1);
    if (interior.length) diagram.edgeWaypoints.set(r.e.key, interior);
    count++;
  }

  diagram.markDirty();
  diagram.onLayoutChange?.();
  return count;
}
