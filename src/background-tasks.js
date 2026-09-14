// The plain-data side of the jobs that run in the background (background.js).
//
// A worker cannot see the diagram. So every task comes in three parts: a function
// that copies what the algorithm reads from the diagram (the *Input functions, on
// the page), the task itself, which runs the algorithm on that copy (all a worker
// does), and a function that puts what the task returns on the diagram (the
// apply* functions, on the page again). Applied to an unchanged diagram, the
// result is exactly what running the algorithm on the diagram itself does, undo
// step included. A worker cannot measure text either, so the page measures the
// tables for the tasks that size them.
//
//   lines    Optimal Route, Ports and channels, Around tables (Lines menu)
//   layout   Tables without groups: hierarchical, force, radial (Tables menu)
//   orient   Direction (Tables menu)
//   groups   Rearrange with AI: local AI, Gemini's domains, the current groups

import { layout } from './layout.js';
import { orientDiagram } from './rotate-diagram.js';
import { reorderWithLocalAI, reorderWithExistingGroups, reorderWithDomains } from './ai-layout.js';
import { organizeLinesShortestPath, organizeLinesElkPorts, organizeLinesAStar, getDiagramEdges } from './line-organizer.js';
import { organizeLinesShortestPathInParallel, canRouteInParallel, HelpersFailed } from './route-parallel.js';
import { computeGroupBounds } from './annotations.js';
import { measureTable } from './renderer.js';

const copyAnchors = (a) => ({
  ...a,
  fromAnchor: a.fromAnchor && typeof a.fromAnchor === 'object' ? { ...a.fromAnchor } : a.fromAnchor,
  toAnchor: a.toAnchor && typeof a.toAnchor === 'object' ? { ...a.toAnchor } : a.toAnchor,
});
const copyPoints = (pts) => pts.map(p => ({ x: p.x, y: p.y }));
const copyAnnotation = (a) => ({ ...a, tables: Array.isArray(a.tables) ? [...a.tables] : a.tables });

// The size layout() and the AI arrangements give a table: its physical one.
const sizeOf = (t) => {
  const { w, h, rowH, headerH } = measureTable(t);
  return { w, h, rowH, headerH };
};

/** Every table's place and size, as the task left them. */
const placements = (tables) => tables.map(t => [t.key, t.x, t.y, t.w, t.h, t.rowH, t.headerH]);

/** Put placements() on the tables of `model` with the same keys. */
function place(model, rows) {
  const byKey = new Map((model.tables || []).map(t => [t.key, t]));
  for (const [key, x, y, w, h, rowH, headerH] of rows) {
    const t = byKey.get(key);
    if (!t) continue;
    t.x = x;
    t.y = y;
    if (w !== undefined) { t.w = w; t.h = h; t.rowH = rowH; t.headerH = headerH; }
  }
}

/** Replace what a Map holds, keeping the Map. */
function refill(map, entries) {
  if (!map) return;
  map.clear();
  for (const [key, value] of entries) map.set(key, value);
}

/** What the line tools and Direction read from the diagram, as plain data. */
function diagramData(diagram) {
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

/** A diagram made of diagramData(), for the algorithms to work on. */
function standIn(data) {
  return {
    model: { tables: data.tables.map(t => ({ ...t })), relations: data.relations },
    manualLinks: data.manualLinks,
    hidden: new Set(data.hidden),
    diagramLevel: data.level,
    edgeRouting: data.edgeRouting,
    edgeAnchors: new Map(data.anchors.map(([key, a]) => [key, copyAnchors(a)])),
    edgeWaypoints: new Map(data.waypoints.map(([key, pts]) => [key, copyPoints(pts)])),
    edgeRoutings: new Map(data.routings),
    markDirty() {},
    onLayoutChange() {},
  };
}

/** Every line of a stand-in, to put back with applyLines(). */
const linesOf = (d) => ({
  anchors: [...d.edgeAnchors].map(([key, a]) => [key, copyAnchors(a)]),
  waypoints: [...d.edgeWaypoints].map(([key, pts]) => [key, copyPoints(pts)]),
  routings: [...d.edgeRoutings],
  edgeRouting: d.edgeRouting,
});

function applyLines(diagram, result) {
  diagram.edgeRouting = result.edgeRouting;
  refill(diagram.edgeAnchors, result.anchors.map(([key, a]) => [key, copyAnchors(a)]));
  refill(diagram.edgeWaypoints, result.waypoints.map(([key, pts]) => [key, copyPoints(pts)]));
  refill(diagram.edgeRoutings, result.routings);
}

// ---- lines: Optimal Route, Ports and channels, Around tables ----------------

const LINE_TOOLS = {
  optimal: (d, keys, options) => organizeLinesShortestPath(d, keys, { ...options, recordHistory: false }),
  ports: (d, keys) => organizeLinesElkPorts(d, keys),
  around: (d, keys) => organizeLinesAStar(d, keys),
};

/**
 * What a line tool reads from the diagram, and what to run: `tool` (optimal,
 * ports or around) on `targetKeys` (every line when null), with the options of
 * organizeLinesShortestPath for Optimal Route.
 */
export function routeInput(diagram, { tool = 'optimal', targetKeys = null, options = {} } = {}) {
  return { tool, targetKeys, options, ...diagramData(diagram) };
}

/**
 * Run the line tool of `input` (routeInput). Returns what the tool reports, the
 * keys of the lines it was given, and every line as it left them.
 */
export function routeOnData(input) {
  const run = LINE_TOOLS[input.tool];
  if (!run) throw new Error(`Unknown line tool: ${input.tool}`);
  const d = standIn(input);
  const keys = getDiagramEdges(d, input.targetKeys).map(e => e.key);
  const summary = run(d, input.targetKeys, input.options || {});
  return { summary, keys, ...linesOf(d) };
}

/**
 * routeOnData() for Optimal Route with helper workers on the other cores
 * (route-parallel.js): the same lines, sooner. Should the helpers fail, a fresh
 * copy is routed on this core instead.
 */
export async function routeOnDataInParallel(input, helpers = {}) {
  const d = standIn(input);
  const keys = getDiagramEdges(d, input.targetKeys).map(e => e.key);
  let summary;
  try {
    summary = await organizeLinesShortestPathInParallel(d, input.targetKeys, { ...input.options, recordHistory: false }, helpers);
  } catch (err) {
    if (err instanceof HelpersFailed) return routeOnData(input);
    throw err;
  }
  return { summary, keys, ...linesOf(d) };
}

/**
 * Put a routeOnData() result on the diagram, as the tool would have left it: one
 * undo step first, then the lines. Returns what the tool reported.
 */
export function applyRoute(diagram, result, { recordHistory = true } = {}) {
  if (!result.keys.length) return result.summary;   // no line to route: the tools change nothing either
  if (recordHistory) diagram.onHistorySnapshot?.(diagram.getSnapshot());
  applyLines(diagram, result);
  diagram.markDirty?.();
  diagram.onLayoutChange?.();
  return result.summary;
}

// ---- layout: tables without groups -------------------------------------------

/** What layout() reads, with every table measured, and the options to run it with. */
export function layoutInput(model, opts = {}, hidden = null) {
  return {
    opts: { algo: opts.algo, dir: opts.dir, spacing: opts.spacing },
    tables: (model.tables || []).map(t => ({ key: t.key, x: t.x, y: t.y, ...sizeOf(t) })),
    relations: (model.relations || []).map(r => ({ fromTable: r.fromTable, toTable: r.toTable })),
    groups: Array.isArray(model.groups)
      ? model.groups.map(g => ({ name: g.name, tables: [...(g.tables || [])] }))
      : null,
    hidden: [...(hidden || [])],
  };
}

/** Run layout() on `input` (layoutInput). Returns where it put every table. */
export function layoutOnData(input) {
  const sizes = new Map(input.tables.map(t => [t.key, t]));
  const model = { tables: input.tables.map(t => ({ ...t })), relations: input.relations, groups: input.groups };
  layout(model, { ...input.opts, measure: (t) => sizes.get(t.key) }, new Set(input.hidden));
  return { tables: placements(model.tables) };
}

/** Move and size the tables of `model` as a layoutOnData() or groupsOnData() result says. */
export function applyLayout(model, result) {
  place(model, result.tables);
}

// ---- orient: Direction ---------------------------------------------------------

/** What turning the diagram to `target` reads, the directions it remembers included. */
export function orientInput(diagram, target) {
  return {
    target,
    orientation: diagram.orientation,
    ...diagramData(diagram),
    annotations: (diagram.annotations || []).map(copyAnnotation),
    memory: diagram._orientMemory || null,
  };
}

/** Turn a copy of the diagram (orientInput). Returns everything the turn changed. */
export function orientOnData(input) {
  const d = standIn(input);
  d.orientation = input.orientation;
  d.annotations = input.annotations.map(copyAnnotation);
  d._orientMemory = input.memory ? structuredClone(input.memory) : null;
  // Diagram.fitAllGroups: the directions remembered hold the boxes it leaves.
  d.fitAllGroups = function () {
    if (!this.annotations.length || !this.model.tables.length) return;
    for (const a of this.annotations) {
      if (a.type !== 'group' || !Array.isArray(a.tables) || !a.tables.length) continue;
      const bounds = computeGroupBounds(a, this.model.tables);
      if (bounds) Object.assign(a, bounds);
    }
  };
  const res = orientDiagram(d, input.target, { recordHistory: false });
  return {
    res,
    orientation: d.orientation,
    tables: d.model.tables.map(t => [t.key, t.x, t.y]),
    annotations: d.annotations.map(a => ({ x: a.x, y: a.y, w: a.w, h: a.h })),
    ...linesOf(d),
    memory: d._orientMemory,
  };
}

/**
 * Put an orientOnData() result on the diagram, as orientDiagram would have left
 * it: one undo step first. Returns what orientDiagram reported.
 */
export function applyOrient(diagram, result, { recordHistory = true } = {}) {
  const { res } = result;
  if (!res.changed) return res;   // nothing to turn: orientDiagram leaves the diagram alone
  if (recordHistory) diagram.onHistorySnapshot?.(diagram.getSnapshot());
  place(diagram.model, result.tables);
  result.annotations.forEach((box, i) => {
    const a = diagram.annotations[i];
    if (a) Object.assign(a, box);
  });
  applyLines(diagram, result);
  diagram.orientation = result.orientation;
  diagram._orientMemory = result.memory;
  diagram.fitAllGroups?.();
  diagram.markDirty?.();
  diagram.onLayoutChange?.();
  return res;
}

// ---- groups: Rearrange with AI -------------------------------------------------

/**
 * What an AI arrangement reads. `mode` is 'local' (Local AI), 'domains' (the
 * `domains` Gemini sorted the tables into) or 'existing' (the current groups);
 * `options` are those of reorderWithLocalAI and friends.
 */
export function groupsInput(diagram, { mode, domains = null, options = {} }) {
  const model = diagram.model || {};
  return {
    mode,
    domains,
    options,
    // `w` and `h` as drawn, which decide what sits inside a group box; `size` as laid out
    tables: (model.tables || []).map(t => ({ key: t.key, name: t.name, x: t.x, y: t.y, w: t.w, h: t.h, size: sizeOf(t) })),
    relations: (model.relations || []).map(r => ({ fromTable: r.fromTable, toTable: r.toTable })),
    groups: Array.isArray(model.groups)
      ? model.groups.map(g => ({ name: g.name, color: g.color, tables: [...(g.tables || [])] }))
      : undefined,
    annotations: mode === 'existing'
      ? (diagram.annotations || []).filter(a => a.type === 'group').map(copyAnnotation)
      : [],
  };
}

/** Run the AI arrangement of `input` (groupsInput). Returns the tables' places and the group boxes. */
export function groupsOnData(input) {
  const sizes = new Map(input.tables.map(t => [t.key, t.size]));
  const model = {
    tables: input.tables.map(({ size, ...t }) => t),
    relations: input.relations,
    groups: input.groups,
  };
  const options = { ...input.options, measure: (t) => sizes.get(t.key) };
  let res;
  if (input.mode === 'local') res = reorderWithLocalAI(model, options);
  else if (input.mode === 'domains') res = reorderWithDomains(model, input.domains || [], options);
  else if (input.mode === 'existing') res = reorderWithExistingGroups(model, input.annotations, options);
  else throw new Error(`Unknown arrangement: ${input.mode}`);
  return {
    tables: placements(model.tables),
    annotations: res.annotations || [],
    implicit: !!res.implicit,
  };
}

// ---- the tasks a worker runs ---------------------------------------------------

const TASKS = {
  // Optimal Route takes most of the time there is, so a worker with cores to
  // spare shares it out; the other tools are quick enough on one.
  lines: (input) => (input.tool === 'optimal' && canRouteInParallel() ? routeOnDataInParallel(input) : routeOnData(input)),
  layout: layoutOnData,
  orient: orientOnData,
  groups: groupsOnData,
};

/** Run the task named `task` on its input. Returns the result, or a promise of it. */
export function runTask(task, input) {
  const run = TASKS[task];
  if (!run) throw new Error(`Unknown background task: ${task}`);
  return run(input);
}
