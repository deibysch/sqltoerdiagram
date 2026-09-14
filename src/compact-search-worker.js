// Runs the "Optimize for" tries, and the measurements with the real lines, off the
// main thread: one try or one measurement can take seconds on a big schema, and
// the page has to stay usable meanwhile.
//
// Every step is reported as it finishes, so stopping never loses anything: the
// page stops a job by terminating this worker.

import { createJob } from './compact-search-core.js';

self.onmessage = (e) => {
  try {
    const job = createJob(e.data);
    while (!job.done()) self.postMessage(job.step());
    self.postMessage(job.finish());
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
