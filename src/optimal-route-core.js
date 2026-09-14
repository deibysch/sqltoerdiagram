// Optimal Route (organizeLinesShortestPath) on plain data, so it can run in a
// worker: routeInput() copies what the router reads from the diagram,
// routeOnData() routes that copy, and applyRoute() puts the lines it drew on the
// diagram. Applied to an unchanged diagram, the result is exactly what routing
// the diagram in place does, history snapshot and line style included.

import { organizeLinesShortestPath, getDiagramEdges } from './line-organizer.js';

const copyAnchors = (a) => ({
  ...a,
  fromAnchor: a.fromAnchor && typeof a.fromAnchor === 'object' ? { ...a.fromAnchor } : a.fromAnchor,
  toAnchor: a.toAnchor && typeof a.toAnchor === 'object' ? { ...a.toAnchor } : a.toAnchor,
});
const copyPoints = (pts) => pts.map(p => ({ x: p.x, y: p.y }));

/** Everything Optimal Route reads from the diagram, as plain data. */
export function routeInput(diagram) {
  const model = diagram.model || {};
  return {
    level: diagram.diagramLevel || 'physical',
    edgeRouting: diagram.edgeRouting,
    tables: (model.tables || []).map(t => ({
      key: t.key, name: t.name, x: t.x, y: t.y, w: t.w, h: t.h, rowH: t.rowH, headerH: t.headerH,
      columns: t.columns || [],
    })),
    relations: (model.relations || []).map(r => ({
      fromTable: r.fromTable, toTable: r.toTable, fromCols: r.fromCols || [], toCols: r.toCols || [],
    })),
    manualLinks: (diagram.manualLinks || []).map(l => ({
      from: { table: l.from?.table, col: l.from?.col }, to: { table: l.to?.table, col: l.to?.col },
    })),
    hidden: [...(diagram.hidden || [])],
    // the lines as they are: the ones not re-routed stay put, and a repair routes around them
    anchors: [...(diagram.edgeAnchors || [])].map(([key, a]) => [key, copyAnchors(a)]),
    waypoints: [...(diagram.edgeWaypoints || [])].map(([key, pts]) => [key, copyPoints(pts)]),
    routings: [...(diagram.edgeRoutings || [])],
  };
}

/**
 * Route `input` (routeInput) with organizeLinesShortestPath's `targetKeys` and
 * `options`. Returns the summary it reports, the keys of the lines it re-routed,
 * their new anchors and vertices (null where it found none), and the line style
 * the diagram ends up with.
 */
export function routeOnData(input, targetKeys = null, options = {}) {
  const d = {
    model: { tables: input.tables.map(t => ({ ...t })), relations: input.relations },
    manualLinks: input.manualLinks,
    hidden: new Set(input.hidden),
    diagramLevel: input.level,
    edgeRouting: input.edgeRouting,
    edgeAnchors: new Map(input.anchors.map(([key, a]) => [key, copyAnchors(a)])),
    edgeWaypoints: new Map(input.waypoints.map(([key, pts]) => [key, copyPoints(pts)])),
    edgeRoutings: new Map(input.routings),
    markDirty() {},
    onLayoutChange() {},
  };
  const keys = getDiagramEdges(d, targetKeys).map(e => e.key);
  const summary = organizeLinesShortestPath(d, targetKeys, { ...options, recordHistory: false });
  return {
    summary,
    keys,
    anchors: keys.map(key => [key, d.edgeAnchors.has(key) ? copyAnchors(d.edgeAnchors.get(key)) : null]),
    waypoints: keys.map(key => [key, d.edgeWaypoints.has(key) ? copyPoints(d.edgeWaypoints.get(key)) : null]),
    edgeRouting: d.edgeRouting,
  };
}

/**
 * Put a routeOnData() result on the diagram, as organizeLinesShortestPath would
 * have left it: one undo step first, then every re-routed line replaced.
 */
export function applyRoute(diagram, result, { recordHistory = true } = {}) {
  if (!result.keys.length) return;   // no line to route: the router changes nothing either
  if (recordHistory) diagram.onHistorySnapshot?.(diagram.getSnapshot());
  diagram.edgeRouting = result.edgeRouting;
  for (const [key, anchors] of result.anchors) {
    diagram.edgeWaypoints.delete(key);
    diagram.edgeAnchors.delete(key);
    diagram.edgeRoutings?.delete(key);
    if (anchors) diagram.edgeAnchors.set(key, copyAnchors(anchors));
  }
  for (const [key, pts] of result.waypoints) {
    if (pts) diagram.edgeWaypoints.set(key, copyPoints(pts));
  }
  diagram.markDirty?.();
  diagram.onLayoutChange?.();
}
