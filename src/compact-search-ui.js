// Once an "Optimize for" option has run, a panel offers one thing: Improve.
//
// The option gives the same arrangement every time, chosen by a cheap estimate
// (every line straight from centre to centre). Improve looks for a better one,
// judging every layout by the real lines, as the quick
// Optimal Route draws them (compact-refine.js): it refines the layout on the
// canvas, neighbouring tables trading places, then keeps exploring other starting
// points and refining the most promising. Every better layout it finds goes on
// the canvas at once, lines included, so the diagram improves as you watch.
//
// It stops by itself once nothing better has turned up for as long as Patience
// says (15 s to 5 min, 30 s unless changed, or unlimited), or when Stop is
// pressed. Then the best layouts it found are shown side by side to pick one; the
// one on the canvas stays unless another is picked. Ctrl+Z goes back to where
// Improve started, in one step. Improve again carries on where it stopped.
//
// It runs in a worker (compact-search-worker.js), and stops by itself when the
// schema, the groups or the settings change (compactInputKey), or when the
// diagram is edited, since the next layout it put on the canvas would undo that.

import { compactInput, compactInputKey, createJob, applyCompactResult } from './compact-search-core.js';
import { createImproveJob } from './compact-refine.js';
import { goalOf, resolveShape, rankScore, rankCandidates, ratioText } from './layout-goals.js';
import { measureTable } from './renderer.js';
import { computeGroupBounds, resolveGroupColor } from './annotations.js';

const OPTIONS_COUNT = 3;   // layouts shown beside the one on the canvas
const KEEP_FOUND = 12;     // layouts found kept to pick from, the best by score

// Patience: how long Improve goes on without putting a better layout on the
// canvas before it stops by itself. The choice is remembered in the browser.
const PATIENCE = [
  { id: '15', label: '15 s', ms: 15e3 },
  { id: '30', label: '30 s', ms: 30e3 },
  { id: '60', label: '1 min', ms: 60e3 },
  { id: '300', label: '5 min', ms: 300e3 },
  { id: 'unlimited', label: 'Unlimited', ms: Infinity },
];
const DEFAULT_PATIENCE = '30';
const PATIENCE_KEY = 'dbdiga-patience';

function storedPatience() {
  try {
    const id = localStorage.getItem(PATIENCE_KEY);
    return PATIENCE.some(p => p.id === id) ? id : DEFAULT_PATIENCE;
  } catch {
    return DEFAULT_PATIENCE;
  }
}

const nf = new Intl.NumberFormat('en-US');
const count = (n, one, many) => `${nf.format(n)} ${n === 1 ? one : many}`;

function metricsText(m) {
  return `Lines ${nf.format(m.length)} px · ${count(m.crossings, 'crossing', 'crossings')} · ${ratioText(m.width, m.height)}`;
}

/** "lines −12%, crossings 69 → 58": what changed between two arrangements. */
function describeChange(from, to) {
  const pct = from.length ? ((to.length - from.length) / from.length) * 100 : 0;
  const lines = Math.abs(pct) < 0.5
    ? 'lines about the same'
    : `lines ${pct < 0 ? '−' : '+'}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%`;
  const crossings = to.crossings === from.crossings
    ? count(to.crossings, 'crossing', 'crossings')
    : `crossings ${from.crossings} → ${to.crossings}`;
  return `${lines}, ${crossings}`;
}

/** "42 s", then "3 min 07 s". */
function clock(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/**
 * Run a job (createJob, or createImproveJob) in a worker, reporting each step and
 * the end. A worker that fails before saying a word never started (a browser
 * without module workers, say), so the same job then runs on the page, one step
 * per task. Returns { stop }.
 */
function runJob(message, on) {
  const onPage = () => {
    const job = message.kind === 'improve' ? createImproveJob(message) : createJob(message);
    let stopped = false;
    const failed = (err) => {
      stopped = true;
      job.close?.();
      on.fail(err?.message || String(err));
    };
    const tick = async () => {
      if (stopped) return;
      try {
        if (job.done()) {
          stopped = true;
          on.done(job.finish());
          return;
        }
        const report = await job.step();
        if (stopped) return;
        on.step(report);
      } catch (err) {
        failed(err);
        return;
      }
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    return { stop() { stopped = true; job.close?.(); } };
  };

  let worker;
  try {
    worker = new Worker(new URL('./compact-search-worker.js', import.meta.url), { type: 'module' });
  } catch {
    return onPage();
  }
  let heard = false;
  let fallback = null;
  worker.onmessage = (e) => {
    heard = true;
    const m = e.data;
    if (m.type === 'done') { worker.terminate(); on.done(m); }
    else if (m.type === 'error') { worker.terminate(); on.fail(m.message); }
    else on.step(m);
  };
  worker.onerror = (e) => {
    e.preventDefault();
    worker.terminate();
    if (heard) on.fail(e.message || 'It stopped unexpectedly.');
    else fallback = onPage();
  };
  worker.postMessage(message);
  return { stop() { worker.terminate(); fallback?.stop(); } };
}

function buildPanel(host) {
  const el = document.createElement('div');
  el.className = 'search-panel';
  el.hidden = true;
  el.innerHTML = `
    <div class="sp-head">
      <span class="spinner sp-spinner" hidden></span>
      <div class="sp-text">
        <div class="sp-title"></div>
        <div class="sp-status" aria-live="polite"></div>
        <div class="sp-note" hidden></div>
      </div>
      <button type="button" class="btn ghost icon sp-close" title="Close" aria-label="Close">✕</button>
    </div>
    <div class="sp-progress" hidden><div class="sp-bar"></div></div>
    <div class="sp-actions">
      <button type="button" class="btn primary sp-improve" title="Looks for a better layout, judging each one by the real 90° lines, until nothing better turns up for as long as Patience says, or you press Stop. Every better layout goes on the canvas as soon as it is found; then pick among the best. Ctrl+Z goes back to where it started.">Improve</button>
      <button type="button" class="btn ghost sp-options" hidden title="The best layouts found, side by side, to pick one by eye.">See options</button>
      <button type="button" class="btn primary sp-stop" hidden>Stop</button>
      <label class="sp-patience" title="How long Improve keeps looking without finding a better layout before it stops by itself. Unlimited: until you press Stop.">Patience
        <select class="sp-patience-select">${PATIENCE.map(p => `<option value="${p.id}">${p.label}</option>`).join('')}</select>
      </label>
    </div>`;
  host.appendChild(el);
  const q = (s) => el.querySelector(s);
  return {
    el,
    spinner: q('.sp-spinner'), title: q('.sp-title'), status: q('.sp-status'), note: q('.sp-note'),
    progress: q('.sp-progress'), improve: q('.sp-improve'), options: q('.sp-options'), stop: q('.sp-stop'),
    patience: q('.sp-patience-select'), close: q('.sp-close'),
  };
}

function buildPicker() {
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.hidden = true;
  el.innerHTML = `
    <div class="modal-card options-card" role="dialog" aria-modal="true" aria-labelledby="layout-options-title">
      <div class="modal-header">
        <div class="modal-title" id="layout-options-title">Pick a layout</div>
        <button type="button" class="btn ghost icon lo-close" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <p class="modal-desc lo-desc"></p>
        <div class="layout-options"></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn ghost lo-keep">Keep current</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  const q = (s) => el.querySelector(s);
  return { el, desc: q('.lo-desc'), list: q('.layout-options'), close: q('.lo-close'), keep: q('.lo-keep') };
}

/**
 * A small picture of a layout: the group boxes, each table with its header band,
 * and its lines as measured. `layout` is { positions: [[key, x, y]], groups:
 * [group annotation], routes: [[[x, y]]] }.
 */
function drawThumbnail(canvas, layout, diagram) {
  const theme = diagram.theme;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 220, H = canvas.clientHeight || 138;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, W, H);

  const sized = new Map(diagram.model.tables.map(t => [t.key, t]));
  const boxes = [];
  for (const [key, x, y] of layout.positions) {
    const t = sized.get(key);
    if (t && Number.isFinite(x) && Number.isFinite(y)) boxes.push({ key, x, y, w: t.w, h: t.h });
  }
  if (!boxes.length) return;
  const groups = (layout.groups || [])
    .map(g => ({ color: resolveGroupColor(g.color), b: computeGroupBounds(g, boxes) }))
    .filter(g => g.b);

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (x, y, w = 0, h = 0) => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  };
  for (const r of [...boxes, ...groups.map(g => g.b)]) take(r.x, r.y, r.w, r.h);
  for (const pts of layout.routes || []) for (const [x, y] of pts) take(x, y);
  const pad = 8;
  const s = Math.min((W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0));
  const ox = (W - (x1 - x0) * s) / 2 - x0 * s;
  const oy = (H - (y1 - y0) * s) / 2 - y0 * s;
  ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
  const px = 1 / s;   // one screen pixel, in diagram units
  const box = (x, y, w, h, r) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  };

  for (const g of groups) {
    box(g.b.x, g.b.y, g.b.w, g.b.h, 12);
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = g.color;
    ctx.fill();
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = g.color;
    ctx.lineWidth = px;
    ctx.stroke();
  }

  ctx.globalAlpha = 0.75;
  ctx.strokeStyle = theme.edge;
  ctx.lineWidth = px;
  ctx.beginPath();
  for (const pts of layout.routes || []) {
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  }
  ctx.stroke();

  ctx.globalAlpha = 1;
  for (const b of boxes) {
    box(b.x, b.y, b.w, b.h, 6);
    ctx.fillStyle = theme.tableBg;
    ctx.fill();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = theme.header;
    ctx.fillRect(b.x, b.y, b.w, Math.min(b.h, 34));
    ctx.restore();
    box(b.x, b.y, b.w, b.h, 6);
    ctx.strokeStyle = theme.tableBorder;
    ctx.lineWidth = px;
    ctx.stroke();
  }
}

/** The numbers under a thumbnail, with what changed against `base` when given. */
function metricsBlock(m, base) {
  const wrap = document.createElement('div');
  wrap.className = 'lo-metrics';
  const row = (label, delta, better) => {
    const line = document.createElement('div');
    line.textContent = label;
    if (delta) {
      const d = document.createElement('b');
      d.className = better ? 'better' : 'worse';
      d.textContent = ` ${delta}`;
      line.appendChild(d);
    }
    wrap.appendChild(line);
  };
  const pct = base && base.length ? ((m.length - base.length) / base.length) * 100 : 0;
  row(`Lines ${nf.format(m.length)} px`,
    base && Math.abs(pct) >= 0.5 ? `${pct < 0 ? '−' : '+'}${Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%` : '',
    pct < 0);
  const dc = base ? m.crossings - base.crossings : 0;
  row(`${count(m.crossings, 'crossing', 'crossings')}`, dc ? `${dc < 0 ? '−' : '+'}${Math.abs(dc)}` : '', dc < 0);
  row(`Shape ${ratioText(m.width, m.height)}`, '', false);
  return wrap;
}

/**
 * The panel and what it runs. `getSpacing` and `getShape` read the Tables menu;
 * `afterApply(entry, { live })` finishes whatever a rearrange finishes (direction,
 * fit, save), `live` for a layout Improve puts on the canvas as it goes, where the
 * view should stay put; `onArranged` reports the first arrangement.
 * Returns { arrange, cancel, noteEdit, refresh }.
 */
export function createCompactSearch({ diagram, host, getSpacing, getShape, afterApply, onArranged }) {
  let settings = null;    // the last arrangement's { spacing, goal, shape }
  let job = null;         // running: the first arrangement, or Improve
  let session = null;     // what Improve found for those settings (newSession)
  let note = null;        // a line on what just happened: { text, canvas }
  let ticker = null;
  let applying = false;   // the panel itself is changing the diagram: not an edit to stop for

  const ui = buildPanel(host);
  const picker = buildPicker();
  ui.patience.value = storedPatience();
  const patience = () => PATIENCE.find(p => p.id === ui.patience.value) || PATIENCE.find(p => p.id === DEFAULT_PATIENCE);

  const newSession = (key) => ({
    key,
    nextSeed: 1,           // the starting point exploring carries on from
    tries: 0,              // starting points explored, all runs together
    elapsed: 0,            // ms Improve has run, all runs together
    found: new Map(),      // signature -> a layout found, with its measurement
    settled: new Set(),    // layouts refined to the end, and where they ended
    baseline: null,        // the layout Improve first started from, as found
    drawn: null,           // the layout found whose lines are on the canvas
  });

  const canvasSignature = () => diagram.model.tables.map(t => `${t.x},${t.y}`).join(';');

  // The schema as a try reads it, and the key of what the tries depend on.
  // Measured afresh: the worker gets only these sizes and cannot measure text.
  function readInput() {
    const level = diagram.diagramLevel || 'physical';
    for (const t of diagram.model.tables) {
      const m = measureTable(t, level);
      t.w = m.w; t.h = m.h; t.rowH = m.rowH; t.headerH = m.headerH;
    }
    const input = compactInput(diagram, settings);
    return { input, key: compactInputKey(input) };
  }

  // A note `aboutCanvas` describes the layout on the canvas, and goes once that
  // layout changes (after Ctrl+Z, say). Any other stays until the next action.
  function setNote(text, { aboutCanvas = false } = {}) {
    note = { text, canvas: aboutCanvas ? canvasSignature() : null };
  }

  // a layout found, as the goal ranks it: by what its real lines measure
  const ranked = (entry) => ({ ...entry, metrics: entry.measurement.metrics, score: rankScore(entry.measurement.metrics, settings) });

  // Keep a layout found: the best KEEP_FOUND by score, and always the one on the canvas.
  function keep(s, entry) {
    s.found.set(entry.signature, entry);
    if (s.found.size <= KEEP_FOUND) return;
    const onCanvas = canvasSignature();
    const worst = [...s.found.values()]
      .filter(e => e.signature !== onCanvas && e.signature !== entry.signature)
      .sort((a, b) => ranked(b).score - ranked(a).score)[0];
    if (worst) s.found.delete(worst.signature);
  }

  // the layout on the canvas as found, and the best others to pick from
  function options() {
    const current = session?.found.get(canvasSignature());
    if (!current) return { current: null, choices: [] };
    const others = [...session.found.values()].map(ranked);
    return { current: ranked(current), choices: rankCandidates(settings.goal, ranked(current), others).slice(0, OPTIONS_COUNT) };
  }

  // Put a layout on the canvas, with its measured lines when it has them.
  function apply(entry, { live = false, recordHistory = true } = {}) {
    applying = true;
    try {
      applyCompactResult(diagram, entry, { lines: entry.measurement?.lines || null, recordHistory });
    } finally {
      applying = false;
    }
    afterApply?.(entry, { live });
  }

  function end(j) {
    if (job === j) job = null;
    clearInterval(ticker);
    ticker = null;
    if (j.kind === 'improve') j.session.elapsed += performance.now() - j.startedAt;
  }

  // stop what is running, keeping whatever it found
  function halt() {
    const j = job;
    if (!j) return null;
    j.handle.stop();
    end(j);
    return j;
  }

  function begin(j, message, on) {
    job = j;
    j.startedAt = performance.now();
    note = null;
    picker.el.hidden = true;
    ui.el.hidden = false;
    j.handle = runJob(message, {
      step(m) {
        if (job === j) on.step(m);
      },
      done() {
        if (job !== j) return;
        end(j);
        on.done();
        render();
      },
      fail(message) {
        if (job !== j) return;
        end(j);
        setNote(j.kind === 'arrange' ? `Could not arrange the tables: ${message}` : `Improve stopped on an error: ${message}`);
        render();
      },
    });
    ticker = setInterval(tick, 250);
    render();
  }

  // Four times a second: Improve stops once nothing better has turned up for as
  // long as Patience says, counted from the last layout it put on the canvas.
  function tick() {
    const j = job;
    if (j?.kind === 'improve' && j.betterAt != null && performance.now() - j.betterAt >= patience().ms) {
      stop({ gaveUp: true });
      return;
    }
    render();
  }

  // The menu option itself: one try from seed 0 of the goal picked, with the
  // spacing and the shape set in the Tables menu.
  function arrange(goalId) {
    if (!diagram.model?.tables?.length) {
      alert('The diagram has no tables to arrange.');
      return;
    }
    halt();
    settings = {
      spacing: getSpacing(),
      goal: goalOf(goalId).id,
      shape: resolveShape(getShape(), diagram.viewW / diagram.viewH),
    };
    session = null;
    const { input, key } = readInput();
    const j = { kind: 'arrange', key, result: null };
    begin(j, { kind: 'search', input, options: { firstSeed: 0, maxAttempts: 1 } }, {
      step(m) {
        if (m.result) j.result = m.result;
      },
      done() {
        if (!j.result) return;
        session = newSession(key);
        apply(j.result);
        onArranged?.(j.result);
      },
    });
  }

  // Improve, and Improve again: it carries on from where the last run stopped.
  function improve() {
    if (job || !settings) return;
    const { input, key } = readInput();
    if (!session || session.key !== key) session = newSession(key);
    const s = session;
    const signature = canvasSignature();
    const start = {
      positions: diagram.model.tables.map(t => [t.key, t.x, t.y]),
      groupBoxes: (diagram.annotations || []).filter(a => a.type === 'group').map(b => ({ ...b, tables: [...(b.tables || [])] })),
      orientation: diagram.orientation || 'LR',
      // found already: those lines, which can be better than routing it from scratch
      measurement: s.found.get(signature)?.measurement || null,
      settled: s.settled.has(signature),
    };
    const j = {
      kind: 'improve', key, session: s,
      phase: 'measuring', round: 0, evaluated: 0, total: 0, triesBefore: s.tries,
      onCanvas: signature,  // what Improve last put on the canvas
      recorded: false,      // the undo step back to where it started is taken
      chains: new Map(),    // chain -> the layout it reported last
      betterAt: null,       // when it last put a better layout on the canvas
    };
    begin(j, { kind: 'improve', input, start, options: { firstSeed: s.nextSeed } }, {
      step(m) {
        if (m.type === 'best') {
          j.betterAt = performance.now();
          track(j, m);
          if (!s.baseline) s.baseline = m.result;
          show(j, m.result);
        } else if (m.type === 'candidate') {
          track(j, m);
        } else if (m.type === 'settled') {
          for (const sig of m.signatures) s.settled.add(sig);
          track(j, m);
        } else if (m.type === 'progress') {
          Object.assign(j, { phase: m.phase, round: m.round, evaluated: m.evaluated, total: m.total });
          s.nextSeed = m.seed;
          s.tries = j.triesBefore + m.tries;
        }
      },
      done() {},
    });
  }

  // Each layout refined is a chain of better and better layouts: the last one
  // reported replaces the one before it, so what is kept to pick from is where
  // each chain stands, or ended.
  function track(j, m) {
    const s = j.session;
    const before = j.chains.get(m.chain);
    if (before && before !== m.result.signature) s.found.delete(before);
    j.chains.set(m.chain, m.result.signature);
    keep(s, m.result);
  }

  // A better layout goes on the canvas as soon as it is found, lines included,
  // without moving the view. The first one takes the undo step that goes back to
  // where Improve started; the ones after it replace it.
  function show(j, entry) {
    if (canvasSignature() !== j.onCanvas) {
      // moved meanwhile, by something that did not say so
      halt();
      setNote('Stopped: the diagram changed.');
      render();
      return;
    }
    // Improve again starts from what it left there, lines and all
    if (entry.signature === j.session.drawn) return;
    apply(entry, { live: true, recordHistory: !j.recorded });
    j.recorded = true;
    j.onCanvas = entry.signature;
    j.session.drawn = entry.signature;
  }

  // Stop, pressed or, with `gaveUp`, once Patience ran out.
  function stop({ gaveUp = false } = {}) {
    const j = halt();
    if (!j) return;
    if (j.kind === 'arrange') {
      setNote('Stopped before the arrangement finished. Nothing moved.');
      render();
      return;
    }
    const s = j.session;
    const { current, choices } = options();
    const since = s.baseline && current && s.baseline.signature !== current.signature
      ? describeChange(s.baseline.measurement.metrics, current.metrics)
      : null;
    const tried = count(s.tries, 'layout', 'layouts');
    const waited = `Stopped after ${patience().label} with nothing better`;
    setNote(since
      ? `${gaveUp ? `${waited}, ${tried} tried` : `Stopped after ${tried} tried`}: ${since}. Ctrl+Z goes back to where it started.`
      : `${gaveUp ? `${waited} than this layout` : 'Stopped: nothing better than this layout yet'}. Improve carries on from here.`,
    { aboutCanvas: true });
    render();
    if (current && choices.length) openPicker(current, choices);
  }

  // What was found belongs to the schema it was found for: once that changes, a
  // running job stops and what was found is dropped.
  function validate() {
    if ((!job && !session) || !settings) return;
    const { key } = readInput();
    if (job && job.key !== key) {
      const j = halt();
      setNote(j.kind === 'arrange' ? 'Stopped: the diagram changed. Nothing moved.' : 'Stopped: the diagram changed.');
    }
    if (session && session.key !== key) session = null;
  }

  function workingText(j) {
    if (j.kind === 'arrange') return 'Arranging…';
    const s = j.session;
    const time = clock(s.elapsed + performance.now() - j.startedAt);
    const current = s.found.get(j.onCanvas);
    const gain = s.baseline && current && s.baseline.signature !== current.signature
      ? describeChange(s.baseline.measurement.metrics, current.measurement.metrics)
      : 'nothing better yet';
    const doing = j.phase === 'exploring' ? `trying other layouts (${nf.format(s.tries)} so far)`
      : j.phase === 'measuring' ? 'drawing the real lines of a layout'
      : `swapping neighbouring tables, round ${j.round + 1}: ${nf.format(j.evaluated)} of ${nf.format(j.total)}`;
    // the last ten seconds of patience are counted down
    const left = j.betterAt == null ? Infinity : patience().ms - (performance.now() - j.betterAt);
    const ending = left <= 10e3 ? ` · stopping in ${Math.max(1, Math.ceil(left / 1000))} s unless it finds better` : '';
    return `Improving · ${time} · ${gain} · ${doing}${ending}`;
  }

  function render() {
    if (ui.el.hidden) return;
    if (settings) ui.title.textContent = `${goalOf(settings.goal).label} · ${settings.shape.label}`;
    if (note?.canvas && note.canvas !== canvasSignature()) note = null;
    ui.note.hidden = !note;
    ui.note.textContent = note ? note.text : '';
    const running = !!job;
    ui.spinner.hidden = !running;
    ui.progress.hidden = !running;
    ui.stop.hidden = !running;
    ui.improve.hidden = running;
    if (running) {
      ui.options.hidden = true;
      ui.status.textContent = workingText(job);
      return;
    }
    if (!settings) return;
    const { current, choices } = options();
    ui.status.textContent = current
      ? `Real lines · ${metricsText(current.metrics)}`
      : patience().ms === Infinity
        ? 'Improve looks for better layouts, drawn with the real 90° lines, until you stop it.'
        : `Improve looks for better layouts, drawn with the real 90° lines, and stops after ${patience().label} without finding one.`;
    ui.options.hidden = !choices.length;
  }

  function openPicker(current, choices) {
    const cards = [
      {
        name: 'Current', entry: null, metrics: current.metrics,
        layout: {
          positions: current.positions,
          groups: (diagram.annotations || []).filter(a => a.type === 'group'),
          routes: current.measurement.routes,
        },
      },
      ...choices.map((c, i) => ({
        name: `Option ${String.fromCharCode(65 + i)}`, entry: c, metrics: c.metrics,
        layout: { positions: c.positions, groups: c.groupBoxes, routes: c.measurement.routes },
      })),
    ];
    const which = choices.length === 1 ? 'The best other layout' : `The ${choices.length} best other layouts`;
    picker.desc.textContent = `${which} found, beside the one on the canvas. ` +
      'Lines are drawn and counted as the quick Optimal Route draws them; Lines > Optimal Route can polish them further.';
    picker.list.replaceChildren();
    const drawings = [];
    for (const c of cards) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'layout-option' + (c.entry ? '' : ' current');
      const cv = document.createElement('canvas');
      const name = document.createElement('div');
      name.className = 'lo-name';
      name.textContent = c.name;
      card.append(cv, name, metricsBlock(c.metrics, c.entry ? current.metrics : null));
      card.addEventListener('click', () => {
        picker.el.hidden = true;
        if (c.entry) {
          // shortcuts still reach the diagram while the picker is open
          validate();
          if (session && !job) {
            apply(c.entry);
            session.drawn = c.entry.signature;
            setNote(`${c.name} applied: ${describeChange(current.metrics, c.metrics)}. Ctrl+Z goes back.`, { aboutCanvas: true });
          }
        }
        render();
      });
      picker.list.appendChild(card);
      drawings.push([cv, c.layout]);
    }
    picker.el.hidden = false;
    // drawn once the cards are laid out, so each canvas knows its size
    requestAnimationFrame(() => { for (const [cv, layout] of drawings) drawThumbnail(cv, layout, diagram); });
    picker.keep.focus();
  }

  function seeOptions() {
    validate();
    if (job) return render();
    const { current, choices } = options();
    if (current && choices.length) openPicker(current, choices);
    else render();
  }

  /** Stop whatever runs and close the picker; `hide` puts the panel away too. */
  function cancel({ hide = false } = {}) {
    halt();
    picker.el.hidden = true;
    if (hide) {
      ui.el.hidden = true;
      note = null;
    } else {
      render();
    }
  }

  ui.improve.addEventListener('click', improve);
  ui.options.addEventListener('click', seeOptions);
  ui.stop.addEventListener('click', () => stop());
  ui.patience.addEventListener('change', () => {
    try { localStorage.setItem(PATIENCE_KEY, ui.patience.value); } catch { /* private mode */ }
    render();
  });
  ui.close.addEventListener('click', () => cancel({ hide: true }));
  const closePicker = () => { picker.el.hidden = true; render(); };
  picker.close.addEventListener('click', closePicker);
  picker.keep.addEventListener('click', closePicker);
  picker.el.addEventListener('click', (e) => { if (e.target === picker.el) closePicker(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !picker.el.hidden) closePicker();
  });

  return {
    arrange,
    cancel,
    /**
     * Something is about to change the diagram. Whatever runs stops: a first
     * arrangement would land on top of that change, and Improve would undo it
     * with the next layout it puts on the canvas.
     */
    noteEdit() {
      if (applying || !job) return;
      const j = halt();
      setNote(j.kind === 'arrange'
        ? 'Stopped: the diagram changed. Nothing moved.'
        : 'Stopped: you changed the diagram. Improve carries on from here.');
      render();
    },
    /** The diagram has changed: check what was found still applies, and redraw the panel. */
    refresh() {
      if (ui.el.hidden) return;
      validate();
      render();
    },
  };
}
