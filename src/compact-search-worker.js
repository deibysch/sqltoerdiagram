// Runs the "Short lines, compact" search off the main thread: one try can take
// seconds on a big schema, and the page has to stay usable meanwhile.
//
// Every try is reported as it finishes, with its layout whenever it is the best
// so far, so stopping never loses anything: the page stops the search by
// terminating this worker.

import { compactSearch, stepReport } from './compact-search-core.js';

self.onmessage = (e) => {
  const { input, options } = e.data;
  try {
    const search = compactSearch(input, options);
    while (!search.state.done) {
      self.postMessage(stepReport(search, search.step()));
    }
    self.postMessage({ type: 'done', attempts: search.state.attempts, nextSeed: search.state.nextSeed });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
