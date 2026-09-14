// Runs one background job for the page (background.js) off its main thread, so a
// big diagram no longer freezes the page for the seconds an algorithm can take.

import { runTask } from './background-tasks.js';

// Says the worker started at all: an error before this means workers are not
// available here, and the page runs its jobs on its own thread instead.
self.postMessage({ type: 'ready' });

self.onmessage = async (e) => {
  const { task, input } = e.data;
  try {
    self.postMessage({ type: 'done', result: await runTask(task, input) });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
