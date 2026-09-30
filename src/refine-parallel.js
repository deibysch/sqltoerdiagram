// Refining, the core of Improve (compact-refine.js), on several cores.
//
// Nearly all of a refine goes on judging swaps, and the swaps of a round are all
// judged against the same state, each on its own. So helper workers judge them,
// a few each, while this thread only hands them out: every helper builds the
// same context from the same input, gets each new state once, and answers every
// move with exactly what judging it here gives. The result is the one the refine
// gives on one core, which is also what runs when there are too few cores or the
// helpers cannot start.
//
// A whole layout is routed here, on one core. Quick Optimal Route has no pair
// phase, the part that helpers speed up (route-parallel.js), and spread over
// them it was slower: 17.8 s against 6.7 s on one thread, on a real schema of 39
// tables and 79 relations.

import { refineContext, evaluateMove, localJudge } from './compact-refine.js';
import { spGridSize } from './line-organizer.js';
import { HelpersFailed } from './route-parallel.js';

const MAX_HELPERS = 10;
const HELPERS_MEMORY = 512 * 1024 * 1024;  // what the helpers' routers may take together
const ROUTER_BYTES_PER_NODE = 104;         // the typed arrays of one SpRouter, per grid node

const spawnWorker = () => new Worker(new URL('./refine-helper-worker.js', import.meta.url), { type: 'module' });

const defaultHelpers = () => Math.min(MAX_HELPERS, ((globalThis.navigator?.hardwareConcurrency) || 2) - 1);

/** A helper whose answers go to `post`. Returns the function to hand each message to. */
export function createRefineHelper(post) {
  let ctx = null;
  let state = null;
  return (m) => {
    if (m.type === 'setup') ctx = refineContext(m.input);
    else if (m.type === 'state') state = m.state;
    else if (m.type === 'evaluate') post({ id: m.id, result: evaluateMove(ctx, state, m.move) });
    else throw new Error(`Unknown refine request: ${m.type}`);
  };
}

/**
 * What judges the moves of a refine on up to `helpers` helpers from `spawn()` (a
 * Worker, or anything with its postMessage, onmessage, onerror and terminate),
 * fewer on a diagram whose routers would not fit in memory. Should the helpers
 * fail, the moves are judged here instead, with the same answers.
 */
export function parallelJudge(ctx, { spawn = spawnWorker, helpers = defaultHelpers() } = {}) {
  const local = localJudge(ctx);
  const nodes = Math.max(1, spGridSize(ctx.input.tables));
  const count = Math.min(helpers, Math.floor(HELPERS_MEMORY / (nodes * ROUTER_BYTES_PER_NODE)));
  if (count < 2) return local;

  let pool = null;   // started with the first moves; false once it has failed or closed
  const fallBack = () => {
    if (pool) pool.close();
    pool = false;
  };
  return {
    size: count,
    evaluate(state, moves) {
      if (pool === null) {
        try {
          pool = new HelperPool(ctx.input, count, spawn);
        } catch {
          fallBack();
        }
      }
      if (!pool) return local.evaluate(state, moves);
      return pool.evaluate(state, moves).catch((err) => {
        if (!(err instanceof HelpersFailed)) throw err;
        fallBack();
        return local.evaluate(state, moves);
      });
    },
    route: local.route,
    close: fallBack,
  };
}

class HelperPool {
  constructor(input, count, spawn) {
    this.helpers = [];
    this.failure = null;
    this.sent = null;       // the state the helpers have
    this.nextId = 0;
    for (let k = 0; k < count; k++) {
      const helper = { worker: spawn(), pending: null };
      helper.worker.onmessage = (e) => {
        const pending = helper.pending;
        helper.pending = null;
        pending?.resolve(e.data.result);
      };
      helper.worker.onerror = (e) => {
        e?.preventDefault?.();
        this.fail(new HelpersFailed(e?.message || 'A refine helper stopped.'));
      };
      helper.worker.postMessage({ type: 'setup', input });
      this.helpers.push(helper);
    }
  }

  fail(err) {
    if (this.failure) return;
    this.failure = err;
    for (const helper of this.helpers) {
      const pending = helper.pending;
      helper.pending = null;
      pending?.reject(err);
    }
  }

  close() {
    for (const helper of this.helpers) helper.worker.terminate();
  }

  /** Every move judged against `state`, by whichever helper is free, answered in order. */
  evaluate(state, moves) {
    if (this.failure) return Promise.reject(this.failure);
    if (state !== this.sent) {
      const data = { positions: state.positions, anchors: state.anchors, waypoints: state.waypoints };
      for (const helper of this.helpers) helper.worker.postMessage({ type: 'state', state: data });
      this.sent = state;
    }
    const results = new Array(moves.length);
    let next = 0;
    let answered = 0;
    return new Promise((resolve, reject) => {
      const give = (helper) => {
        if (next >= moves.length) return;
        const i = next++;
        const id = this.nextId++;
        helper.pending = {
          resolve: (result) => {
            results[i] = result;
            if (++answered === moves.length) resolve(results);
            else give(helper);
          },
          reject,
        };
        helper.worker.postMessage({ type: 'evaluate', id, move: moves[i] });
      };
      for (const helper of this.helpers) give(helper);
    });
  }
}
