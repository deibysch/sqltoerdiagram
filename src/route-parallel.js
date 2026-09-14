// Optimal Route on several cores.
//
// Nearly all of its time goes on two phases made of trials (line-organizer.js
// spRouteSteps): rip-up takes each line out and routes it again against the
// rest, and the pair phase takes two crossing lines out and tries both orders of
// putting them back. Hardly any trial changes a line, so helper workers
// (route-helper.js) run many of them at once, each against the reservations the
// one-core run would have in place by the time it got there: every trial that
// changes nothing leaves its lines reserved again, last. The results are applied
// in the original order, and when one does change a line, the trials after it
// ran against a state that no longer holds, so they run again. The unobstructed
// route of every line is shared out as well.
//
// Helpers take a while to start and to get up to speed, so they are only started
// once a run has gone on long enough to be worth it, and nothing waits for them:
// this thread keeps routing lines, and runs the next trial itself whenever no
// helper up to speed is on it, exactly where the one-core run would. The lines
// come out exactly as on one core, which is also what runs when there are too
// few lines, too few cores, or helpers that cannot start.

import { spRouteSteps, spRunSteps } from './line-organizer.js';

const MIN_LINES = 30;                      // below this, a run is never long enough to need helpers
const START_AFTER_MS = 400;                // how long a run goes on before the helpers are started
const MAX_HELPERS = 8;
const HELPERS_MEMORY = 256 * 1024 * 1024;  // what the helpers' routers may take together
const ROUTER_BYTES_PER_NODE = 104;         // the typed arrays of one SpRouter, per grid node
const LOOKAHEAD = 2;                       // trials handed out past the next one to apply, per helper
const WARM_UP = 3;                         // answers a helper gives before it is trusted with the next trial

/** Helpers could not start or stopped: the run has to be done on one core. */
export class HelpersFailed extends Error {}

/** Can this thread coordinate helpers? A worker can, when there are cores to spare; the page must not. */
export function canRouteInParallel() {
  return typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope
    && typeof Worker !== 'undefined' && (navigator.hardwareConcurrency || 1) >= 3;
}

const spawnWorker = () => new Worker(new URL('./route-helper-worker.js', import.meta.url), { type: 'module' });

const defaultHelpers = () => Math.min(MAX_HELPERS, ((globalThis.navigator?.hardwareConcurrency) || 2) - 1);

// Let the messages that came in meanwhile be handled, without the delay a timer can add.
const yieldToMessages = () => new Promise((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    resolve();
  };
  channel.port2.postMessage(null);
});

/**
 * organizeLinesShortestPath with up to `helpers` helpers from `spawn()` (a
 * Worker, or anything with its postMessage, onmessage, onerror and terminate; a
 * helper says { type: 'ready' } once it is up), started after `startAfter` ms
 * for runs of at least `minLines` lines. `stats`, if given, counts the trials
 * handed out, those whose answer came too late to hold, and those run here.
 * Rejects with HelpersFailed when the helpers fail, having changed the diagram
 * part way: route a fresh copy on one core then.
 */
export async function organizeLinesShortestPathInParallel(diagram, targetKeys = null, options = {}, {
  spawn = spawnWorker, helpers = defaultHelpers(), startAfter = START_AFTER_MS, minLines = MIN_LINES,
  stats = { handedOut: 0, stale: 0, here: 0 },
} = {}) {
  const steps = spRouteSteps(diagram, targetKeys, options);
  let current = steps.next();
  if (current.done) return current.value;

  const { job } = current.value;
  const count = Math.min(helpers, Math.floor(HELPERS_MEMORY / (job.router.N * ROUTER_BYTES_PER_NODE)));
  if (job.edges.length < minLines || count < 2) return spRunSteps(steps, current);

  const pool = new HelperPool(job, count, spawn, startAfter, stats);
  try {
    while (!current.done) {
      const step = current.value;
      const reply = step.type === 'bases' ? await pool.bases() : await pool.trials(step);
      current = steps.next(reply);
    }
    return current.value;
  } finally {
    pool.close();
  }
}

const routeData = (route) => ({ pts: route.pts, fromPort: route.fromPort, toPort: route.toPort });
const ownersOf = (trial) => (trial.kind === 'rip' ? [trial.it.idx] : [trial.A.idx, trial.B.idx]);

class HelperPool {
  constructor(job, count, spawn, startAfter, stats) {
    this.job = job;
    this.count = count;
    this.spawn = spawn;
    this.stats = stats;
    this.startAt = performance.now() + startAfter;
    this.helpers = [];           // none until the run has gone on for a while
    this.items = null;           // the lines being routed, once they are known
    this.failure = null;
    this.wake = null;
    this.ids = new WeakMap();    // route -> id, so a helper can name a route the run already has
    this.byId = new Map();
    this.nextId = 0;
    // The lines held fixed are reserved like any other, from routes of their own.
    this.fixed = (job.fixed || []).map(f => ({ pts: f.pts }));
  }

  /** Start the helpers, once the run has gone on long enough to be worth it. */
  startIfLong() {
    if (this.helpers.length || performance.now() < this.startAt) return;
    const { job } = this;
    const setup = {
      type: 'setup',
      tables: job.tables.map(t => ({ key: t.key, x: t.x, y: t.y, w: t.w, h: t.h })),
      grid: { xs: job.grid.xs, ys: job.grid.ys },
      edges: job.edges.map(e => [job.tables.indexOf(e.from), job.tables.indexOf(e.to)]),
      touches: job.touches,
    };
    try {
      for (let k = 0; k < this.count; k++) {
        const helper = { worker: this.spawn(), known: new Set(), ready: false, busy: false, pending: null, answered: 0 };
        helper.worker.onmessage = (e) => {
          if (e.data?.type === 'ready') {
            helper.ready = true;
          } else {
            const pending = helper.pending;
            helper.pending = null;
            helper.busy = false;
            helper.answered++;
            pending?.resolve(e.data);
          }
          this.wake?.();
        };
        helper.worker.onerror = (e) => {
          e?.preventDefault?.();
          this.fail(new HelpersFailed(e?.message || 'A routing helper stopped.'));
        };
        this.helpers.push(helper);
        helper.worker.postMessage(setup);
        // what this thread has found out about clearance so far
        helper.worker.postMessage({ type: 'clearance', blockH: job.router.blockH, blockV: job.router.blockV });
        if (this.items) this.sendItems(helper);
      }
    } catch (err) {
      this.close();
      throw new HelpersFailed(err?.message || String(err));
    }
  }

  sendItems(helper) {
    this.teach(helper, this.items.map(it => it.base));
    helper.worker.postMessage({ type: 'items', items: this.items.map(it => [it.idx, it.budget, this.idOf(it.base)]) });
  }

  close() {
    for (const helper of this.helpers) helper.worker.terminate();
  }

  fail(err) {
    if (this.failure) return;
    this.failure = err;
    for (const helper of this.helpers) {
      const pending = helper.pending;
      helper.pending = null;
      pending?.reject(err);
    }
    this.wake?.();
  }

  /** The helpers that are up and have nothing to do. */
  free() {
    return this.helpers.filter(helper => helper.ready && !helper.busy);
  }

  sleep() {
    return new Promise((resolve) => { this.wake = resolve; });
  }

  request(helper, message) {
    if (this.failure) return Promise.reject(this.failure);
    helper.busy = true;
    return new Promise((resolve, reject) => {
      helper.pending = { resolve, reject };
      helper.worker.postMessage(message);
    });
  }

  idOf(route) {
    let id = this.ids.get(route);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(route, id);
      this.byId.set(id, route);
    }
    return id;
  }

  /** Send a helper whichever of `routes` it has not been sent yet. */
  teach(helper, routes) {
    const unknown = [];
    for (const route of routes) {
      const id = this.idOf(route);
      if (helper.known.has(id)) continue;
      helper.known.add(id);
      unknown.push([id, routeData(route)]);
    }
    if (unknown.length) helper.worker.postMessage({ type: 'routes', routes: unknown });
  }

  /** A route a helper answered with: one the run has, by id, or a new one. */
  route(answer) {
    return answer.id !== undefined ? this.byId.get(answer.id) : { ...answer.route };
  }

  /** The unobstructed route of every edge, in edge order: the edges go to free helpers and to this thread alike. */
  async bases() {
    const { job } = this;
    const out = new Array(job.edges.length);
    let next = 0;
    let found = 0;
    while (found < out.length) {
      if (this.failure) throw this.failure;
      this.startIfLong();
      for (const helper of this.free()) {
        if (next >= out.length) break;
        const i = next++;
        this.request(helper, { type: 'base', edge: i }).then((answer) => {
          out[i] = answer.route ? this.route(answer) : null;
          found++;
        }, () => {});
      }
      if (next < out.length) {
        const i = next++;
        out[i] = job.base(i);
        found++;
        if (this.helpers.length) await yieldToMessages();
      } else if (found < out.length) {
        await this.sleep();
      }
    }

    // Finding those routes told each router which grid edges keep clear of the
    // tables, the slowest thing to find out the first time. Pool what the helpers
    // found, for the first pass here and for every helper's trials.
    if (this.helpers.length) {
      const { router } = job;
      const up = this.helpers.filter(helper => helper.ready);
      for (const clearance of await Promise.all(up.map(helper => this.request(helper, { type: 'clearance' })))) {
        router.learnClearance(clearance.blockH, clearance.blockV);
      }
      for (const helper of this.helpers) {
        helper.worker.postMessage({ type: 'clearance', blockH: router.blockH, blockV: router.blockV });
      }
    }
    return out;
  }

  /** Run a phase of trials (a 'trials' step), with the same outcome as spRunSteps. */
  async trials(step) {
    const { job, items, trials, skip, commit } = step;
    if (!this.items) {
      this.items = items;
      for (const helper of this.helpers) this.sendItems(helper);
    }
    const byIdx = new Map(items.map(it => [it.idx, it]));
    const routeOf = (owner) => (owner < job.edges.length ? byIdx.get(owner).route : this.fixed[owner - job.edges.length]);

    const n = trials.length;
    const results = new Array(n);          // [version it ran with, answer]
    const running = new Array(n).fill(-1); // version it is running with
    const runner = new Array(n);           // ... and on which helper
    let next = 0;                          // the first trial not applied yet
    let version = 0;                       // one more for every trial applied that changed a line
    const warm = (helper) => helper.answered >= WARM_UP;

    const dispatch = (helper, j, order) => {
      const trial = trials[j];
      const routes = order.map(routeOf);
      this.teach(helper, routes);
      const message = {
        type: trial.kind,
        a: ownersOf(trial)[0],
        b: ownersOf(trial)[1],
        order: order.map((owner, k) => [owner, this.idOf(routes[k])]),
      };
      const v = version;
      running[j] = v;
      runner[j] = helper;
      this.stats.handedOut++;
      this.request(helper, message).then((answer) => {
        if (running[j] === v) running[j] = -1;
        if (v === version) results[j] = [v, answer];
        else this.stats.stale++;
      }, () => {});
    };

    for (;;) {
      if (this.failure) throw this.failure;

      // Apply, in order, every result that still holds.
      while (next < n) {
        const trial = trials[next];
        if (skip(trial)) { next++; continue; }
        const result = results[next];
        if (!result || result[0] !== version) break;
        results[next] = undefined;
        const answer = result[1];
        const outcome = trial.kind === 'rip'
          ? (answer.fresh ? this.route(answer.fresh) : null)
          : { A: this.route(answer.A), B: this.route(answer.B) };
        if (commit(trial, outcome)) version++;
        next++;
      }
      if (next >= n) return;
      this.startIfLong();

      // Hand the trials just ahead to the free helpers, each with the reservations
      // in the order the one-core run would have them when it got there. A helper
      // still warming up is slow, so the next trial only goes to one that is not;
      // the others warm up on trials further on.
      const free = this.free();
      if (free.length) {
        const order = [...job.router.res.byOwner.keys()];
        for (let j = next; j < n && j < next + this.helpers.length * LOOKAHEAD && free.length; j++) {
          const trial = trials[j];
          if (skip(trial)) continue;
          if (results[j]?.[0] !== version && running[j] !== version) {
            let k = j === next ? free.findIndex(warm) : free.findIndex(helper => !warm(helper));
            if (k < 0 && j > next) k = free.length - 1;
            if (k >= 0) dispatch(free.splice(k, 1)[0], j, order);
          }
          for (const owner of ownersOf(trial)) {
            const k = order.indexOf(owner);
            if (k >= 0) order.splice(k, 1);
            order.push(owner);
          }
        }
      }

      // Unless a helper up to speed is on it, the next trial runs here, on the
      // reservations as they are, which is where the one-core run would run it.
      if (running[next] !== version || !warm(runner[next])) {
        const trial = trials[next];
        if (commit(trial, trial.kind === 'rip' ? job.ripTrial(trial.it) : job.pairTrial(trial.A, trial.B))) version++;
        next++;
        this.stats.here++;
        if (this.helpers.length) await yieldToMessages();
        continue;
      }
      await this.sleep();
    }
  }
}
