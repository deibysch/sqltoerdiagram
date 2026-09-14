// Optimal Route from the Lines menu, in the background.
//
// The router takes seconds on a big diagram (the 100-table one took 35 s before
// it was optimised), and on the page's own thread that froze everything. Here it
// runs in a worker (optimal-route-worker.js) on a copy of the diagram, and its
// lines are applied only if the diagram is still the one it routed: moved tables,
// an undo or another line tool in the meantime would make them wrong, so they
// are dropped and the caller is told. Where workers are not available it runs on
// the page, as before.

import { routeInput, routeOnData, applyRoute } from './optimal-route-core.js';

/**
 * Route `targetKeys` (all lines when null) of `diagram`. Calls `onDone(summary)`
 * once the lines are on the diagram, `onStale()` when the diagram changed before
 * they could be, and `onFail(message)` on an error. Returns { cancel }.
 */
export function startOptimalRoute(diagram, targetKeys, { options = {}, onDone, onStale, onFail } = {}) {
  const input = routeInput(diagram);
  const sent = JSON.stringify(input);
  let finished = false;

  const finish = (result) => {
    if (finished) return;
    finished = true;
    if (JSON.stringify(routeInput(diagram)) !== sent) {
      onStale?.();
      return;
    }
    applyRoute(diagram, result);
    onDone?.(result.summary);
  };
  const fail = (message) => {
    if (finished) return;
    finished = true;
    onFail?.(message);
  };

  // On the page: a task away, so whatever the caller shows first gets painted.
  const onPage = () => {
    const timer = setTimeout(() => {
      try {
        finish(routeOnData(input, targetKeys, options));
      } catch (err) {
        fail(err?.message || String(err));
      }
    }, 0);
    return { cancel() { clearTimeout(timer); finished = true; } };
  };

  let worker;
  try {
    worker = new Worker(new URL('./optimal-route-worker.js', import.meta.url), { type: 'module' });
  } catch {
    return onPage();
  }
  let started = false;
  let fallback = null;
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') { started = true; return; }
    worker.terminate();
    if (m.type === 'done') finish(m.result);
    else fail(m.message);
  };
  worker.onerror = (e) => {
    e.preventDefault();
    worker.terminate();
    if (started) fail(e.message || 'Routing stopped unexpectedly.');
    else fallback = onPage();
  };
  worker.postMessage({ input, targetKeys, options });
  return {
    cancel() {
      worker.terminate();
      fallback?.cancel();
      finished = true;
    },
  };
}
