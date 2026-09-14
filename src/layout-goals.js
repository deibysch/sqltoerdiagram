// What "Optimize for" arranges the tables for: a goal, and a shape for the whole
// canvas. The same numbers drive the layout (group-layout-compact.js) while it
// polishes a try and the search (compact-search-core.js) when it ranks tries.
//
// Every figure here is the cheap estimate the layout can afford to compute
// thousands of times: each line drawn straight from centre to centre, a bend
// wherever two linked tables share no row or column, and a crossing wherever two
// of those straight lines cross. The panel can measure the best few with the real
// 90 degree lines instead (Optimal Route), when the user asks for it.

// `bend` and `cross` are the px of line a bend and a crossing are worth while a try
// is polished. `rankCross` is what a crossing is worth when tries are ranked,
// which only looks at what the panel shows (lines and crossings, not the bends
// it never mentions): a tie-break for Shortest lines, and for Fewest crossings
// so much that fewer crossings always wins and the lines only settle a tie.
// Polishing with that much made the lines 25% longer for no crossing fewer
// (60 tables in 10 groups), hence the gentler 3000 there.
export const GOALS = {
  lines: { id: 'lines', label: 'Shortest lines', bend: 40, cross: 20, rankCross: 1 },
  crossings: { id: 'crossings', label: 'Fewest crossings', bend: 40, cross: 3000, rankCross: 1e7 },
  balanced: { id: 'balanced', label: 'Balanced', bend: 40, cross: 200, rankCross: 200 },
};
export const GOAL_IDS = Object.keys(GOALS);
export const DEFAULT_GOAL = 'balanced';

export const SHAPES = [
  { id: 'auto', label: 'Auto', ratio: null },
  { id: 'screen', label: 'Screen', ratio: 'screen' },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: 'a4-landscape', label: 'A4 landscape', ratio: Math.SQRT2 },
  { id: 'a4-portrait', label: 'A4 portrait', ratio: Math.SQRT1_2 },
];
export const DEFAULT_SHAPE = 'auto';

// Auto keeps the canvas readable on a screen: anything from square to 2:1 costs
// nothing extra, and past that the score is multiplied by 1 + 2 ln(how far
// past). With groups it is also pulled towards 1.6:1 at 9000 px per unit off, the
// charge "Short lines, compact" was tuned with.
export const AUTO_SHAPE = { min: 1, max: 2, strayCost: 2, groupTarget: 1.6, groupPull: 9000 };

// A chosen shape: within `tolerance` of it counts as exact, and past that the
// score is multiplied by 1 + strayCost ln(how far past).
export const CHOSEN_SHAPE = { tolerance: 1.05, strayCost: 8 };

export const goalOf = (id) => GOALS[id] || GOALS[DEFAULT_GOAL];

/** A shape id as { id, label, ratio }, with Screen worked out from `screenRatio`. */
export function resolveShape(id, screenRatio) {
  const shape = SHAPES.find(s => s.id === id) || SHAPES[0];
  if (shape.ratio !== 'screen') return { ...shape };
  const ratio = Number.isFinite(screenRatio) && screenRatio > 0 ? Math.round(screenRatio * 100) / 100 : 16 / 9;
  return { ...shape, ratio };
}

/** A ratio as people write it: "1.6 : 1", or "1 : 1.4" for a tall one. */
export function ratioText(width, height) {
  if (!(width > 0 && height > 0)) return '1 : 1';
  return width >= height ? `${(width / height).toFixed(1)} : 1` : `1 : ${(height / width).toFixed(1)}`;
}

/** The line part of the score: length, plus what the goal charges per bend and per crossing. */
export function linkCost(metrics, goalId) {
  const goal = goalOf(goalId);
  return metrics.length + goal.bend * metrics.bends + goal.cross * metrics.crossings;
}

/**
 * How far a canvas of this ratio is from the shape, as the factor the line cost is
 * multiplied by (1 is on target), plus the flat pull of Auto with groups.
 */
export function shapeCharge(ratio, shape, grouped) {
  if (!(ratio > 0)) return { factor: 1, extra: 0 };
  const target = shape && typeof shape.ratio === 'number' ? shape.ratio : null;
  if (target) {
    const stray = Math.max(ratio / target, target / ratio);
    return { factor: 1 + CHOSEN_SHAPE.strayCost * Math.log(Math.max(1, stray / CHOSEN_SHAPE.tolerance)), extra: 0 };
  }
  const stray = Math.max(1, ratio / AUTO_SHAPE.max, AUTO_SHAPE.min / ratio);
  const off = ratio > AUTO_SHAPE.groupTarget ? ratio / AUTO_SHAPE.groupTarget : AUTO_SHAPE.groupTarget / ratio;
  return {
    factor: 1 + AUTO_SHAPE.strayCost * Math.log(stray),
    extra: grouped ? (off - 1) * AUTO_SHAPE.groupPull : 0,
  };
}

/**
 * What the layout minimises while it polishes a try, for an objective
 * { goal, shape }. `metrics` is { length, bends, crossings, width, height };
 * `grouped` says whether the diagram has group boxes, which only Auto treats
 * differently.
 */
export function layoutScore(metrics, objective = {}, grouped = false) {
  const { factor, extra } = shapeCharge(metrics.width / metrics.height, objective.shape, grouped);
  return (linkCost(metrics, objective.goal) + extra) * factor;
}

/**
 * How tries are ranked against each other and against the layout on the canvas,
 * lower being better: only what the panel shows, the lines, the crossings and the
 * shape. Auto ranks any shape from square to 2:1 the same.
 */
export function rankScore(metrics, objective = {}) {
  const { factor } = shapeCharge(metrics.width / metrics.height, objective.shape, false);
  return (metrics.length + goalOf(objective.goal).rankCross * metrics.crossings) * factor;
}

/** Better or equal on line length and on crossings, and strictly better on one of them. */
export function improvesBoth(metrics, than) {
  return metrics.length <= than.length && metrics.crossings <= than.crossings
    && (metrics.length < than.length - 0.5 || metrics.crossings < than.crossings);
}

/**
 * Candidates, best first, each { score, metrics, signature }. By score, except
 * that Balanced first lists the ones that improve lines and crossings at once
 * over `current`: a layout that trades crossings for shorter lines can score
 * better and still be the one you would not pick.
 */
export function rankCandidates(goalId, current, candidates) {
  const seen = new Set(current?.signature ? [current.signature] : []);
  const unique = [];
  for (const c of candidates) {
    if (seen.has(c.signature)) continue;
    seen.add(c.signature);
    unique.push(c);
  }
  const both = (c) => (goalId === 'balanced' && current && improvesBoth(c.metrics, current.metrics) ? 0 : 1);
  return unique.sort((a, b) => both(a) - both(b) || a.score - b.score);
}

/** What Apply best puts on the canvas: the first ranked candidate that beats `current`, or null. */
export function chooseBest(goalId, current, candidates) {
  return rankCandidates(goalId, current, candidates).find(c => c.score < current.score - 0.5) || null;
}

/**
 * The layouts that no other one beats on both lines and crossings, at most `cap`
 * of them, lowest score first. Balanced needs them: a list of the best scores can
 * push out the one layout that improves both. Returns `list` itself when
 * `result` does not get in.
 */
export function keepFront(list, result, cap) {
  if (!cap || list.some(r => r.signature === result.signature)) return list;
  const same = (a, b) => a.length === b.length && a.crossings === b.crossings;
  if (list.some(r => improvesBoth(r.metrics, result.metrics) || same(r.metrics, result.metrics))) return list;
  const out = [...list.filter(r => !improvesBoth(result.metrics, r.metrics)), result]
    .sort((a, b) => a.score - b.score)
    .slice(0, cap);
  return out.includes(result) ? out : list;
}
