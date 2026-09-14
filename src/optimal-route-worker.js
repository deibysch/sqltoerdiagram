// Runs Optimal Route off the main thread (optimal-route.js), so a big diagram no
// longer freezes the page for the seconds it takes.

import { routeOnData } from './optimal-route-core.js';

// Says the worker started at all: an error before this means workers are not
// available here, and the page routes on its own thread instead.
self.postMessage({ type: 'ready' });

self.onmessage = (e) => {
  const { input, targetKeys, options } = e.data;
  try {
    self.postMessage({ type: 'done', result: routeOnData(input, targetKeys, options) });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
