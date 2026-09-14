// The algorithms that can take long enough to freeze the page run in the
// background: Optimal Route and the other line tools, the tables-without-groups
// layouts, Direction and Rearrange with AI.
//
// Each job runs in a worker (background-worker.js) on a plain-data copy of what
// its algorithm reads (background-tasks.js), and its result is put on the diagram
// only if the diagram still is what the job read: moved tables, an undo or another
// tool in the meantime would make it wrong, so it is dropped and the caller told.
// Where workers are not available, the job runs on the page instead, a task away.

import { runTask } from './background-tasks.js';

// Cleared by the first worker that fails before it starts: from then on every
// job runs on the page.
let workersWork = true;

// A worker takes a moment to load its modules, so the moment a job takes one, the
// next one starts loading. Each job gets a worker of its own, ended with the job,
// which is also how a job is cancelled.
let spare = null;

function spawn() {
  if (!workersWork) return null;
  let worker;
  try {
    worker = new Worker(new URL('./background-worker.js', import.meta.url), { type: 'module' });
  } catch {
    workersWork = false;
    return null;
  }
  const w = { worker, started: false, failed: false, job: null };
  worker.onmessage = (e) => {
    if (e.data?.type === 'ready') w.started = true;
    else w.job?.message(e.data);
  };
  worker.onerror = (e) => {
    e.preventDefault();
    if (!w.started) workersWork = false;
    w.failed = true;
    if (w.job) w.job.error(e);
    else worker.terminate();
  };
  return w;
}

/** Run `task` on `input`, then call done(result) or fail(message). Returns a cancel function. */
function run(task, input, done, fail) {
  const onPage = () => {
    const timer = setTimeout(() => {
      let result;
      try {
        // on a copy, as a worker would: a task must never reach the live diagram
        result = runTask(task, structuredClone(input));
      } catch (err) {
        fail(err?.message || String(err));
        return;
      }
      done(result);
    }, 0);
    return () => clearTimeout(timer);
  };

  const w = spare && !spare.failed ? spare : spawn();
  spare = null;
  if (!w) return onPage();
  spare = spawn();

  let fallback = null;
  w.job = {
    message(m) {
      w.worker.terminate();
      if (m.type === 'done') done(m.result);
      else fail(m.message);
    },
    error(e) {
      w.worker.terminate();
      if (w.started) fail(e.message || 'It stopped unexpectedly.');
      else fallback = onPage();
    },
  };
  w.worker.postMessage({ task, input });
  return () => {
    w.worker.terminate();
    fallback?.();
  };
}

// JSON with the contents of Maps and Sets spelled out, so they count too.
const fingerprint = (value) => JSON.stringify(value, (_, v) => (v instanceof Map || v instanceof Set ? [...v] : v));

/**
 * Run `task` (background-tasks.js) on what `read()` returns. When the result is
 * back, `read()` is asked again: if the diagram still gives the same input,
 * `apply(result)` runs, and otherwise `onStale()`. `onFail(message)` on an error.
 * Returns { cancel }.
 */
export function startJob(task, read, { apply, onStale, onFail } = {}) {
  const input = read();
  const sent = fingerprint(input);
  let finished = false;
  const stop = run(task, input,
    (result) => {
      if (finished) return;
      finished = true;
      if (fingerprint(read()) === sent) apply?.(result);
      else onStale?.();
    },
    (message) => {
      if (finished) return;
      finished = true;
      onFail?.(message);
    });
  return {
    cancel() {
      finished = true;
      stop();
    },
  };
}
