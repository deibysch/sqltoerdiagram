// The helper side of Optimal Route on several cores (route-parallel.js).
//
// A helper builds its own copy of the job (line-organizer.js SpJob) from the
// tables and grid it is sent, learns routes as the run finds them, and answers
// one request at a time: the unobstructed route of an edge, a rip-up or pair
// trial, or what it has found out about which grid edges keep clear of the
// tables. A trial comes with the owner of every reservation and its route, in
// the order they were reserved, so the reservations are rebuilt exactly as the
// one-core run has them at that point before the trial runs.
//
// A route is named by the id the coordinator gave it, so a trial that settles on
// a route the run already had answers with that id: whether a line changed is a
// question of which route it has, not of what the route looks like.

import { SpJob } from './line-organizer.js';

const routeData = (route) => ({ pts: route.pts, fromPort: route.fromPort, toPort: route.toPort });

/** A helper whose answers go to `post`. Returns the function to hand each message to. */
export function createRouteHelper(post) {
  let job = null;
  let items = [];
  const routes = new Map();     // id -> route
  const ids = new WeakMap();    // route -> id

  const answer = (route) => (ids.has(route) ? { id: ids.get(route) } : { route: routeData(route) });

  // The reservations, and the routes the trial's lines have, as the message says.
  const reserve = (order) => {
    job.router.clearReservations();
    for (const [owner, id] of order) {
      const route = routes.get(id);
      job.router.reserve(route, owner);
      if (items[owner]) items[owner].route = route;
    }
  };

  return (m) => {
    switch (m.type) {
      case 'setup': {
        const edges = m.edges.map(([from, to]) => ({ from: m.tables[from], to: m.tables[to] }));
        job = new SpJob(m.tables, m.grid, edges, m.touches);
        items = [];
        routes.clear();
        break;
      }
      case 'routes':
        for (const [id, data] of m.routes) {
          const route = { pts: data.pts, fromPort: data.fromPort, toPort: data.toPort };
          routes.set(id, route);
          ids.set(route, id);
        }
        break;
      case 'items':
        items = [];
        for (const [idx, budget, baseId] of m.items) {
          items[idx] = { e: job.edges[idx], idx, budget, base: routes.get(baseId), route: null };
        }
        break;
      case 'base': {
        const route = job.base(m.edge);
        post({ route: route && routeData(route) });
        break;
      }
      case 'clearance':
        // asked for: what this helper found; sent: what the others found
        if (m.blockH) job.router.learnClearance(m.blockH, m.blockV);
        else post({ blockH: job.router.blockH, blockV: job.router.blockV });
        break;
      case 'rip': {
        reserve(m.order);
        const fresh = job.ripTrial(items[m.a]);
        post({ fresh: fresh && answer(fresh) });
        break;
      }
      case 'pair': {
        reserve(m.order);
        const best = job.pairTrial(items[m.a], items[m.b]);
        post({ A: answer(best.A), B: answer(best.B) });
        break;
      }
      default:
        throw new Error(`Unknown routing request: ${m.type}`);
    }
  };
}
