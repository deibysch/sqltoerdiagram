// Runs the "Optimize for" tries, the measurements with the real lines, and
// Refine, off the main thread: one try or one measurement can take seconds on a
// big schema, and the page has to stay usable meanwhile.
//
// Every step is reported as it finishes, so stopping never loses anything: the
// page stops a job by terminating this worker, which ends its helpers too.

import { createJob } from './compact-search-core.js';
import { createRefineJob } from './compact-refine.js';
import { parallelJudge } from './refine-parallel.js';
import { canRouteInParallel } from './route-parallel.js';

self.onmessage = async (e) => {
  let job = null;
  try {
    job = e.data.kind === 'refine'
      ? createRefineJob(e.data, canRouteInParallel() ? parallelJudge : undefined)
      : createJob(e.data);
    while (!job.done()) self.postMessage(await job.step());
    self.postMessage(job.finish());
  } catch (err) {
    job?.close?.();
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
