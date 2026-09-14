// Once an "Optimize for" option has run, a panel offers to look for a better
// arrangement.
//
// The option gives the same arrangement every time, and more polish rounds find
// nothing more; what does find better ones is starting somewhere else
// (compact-search-core.js). So Search tries other starting points in a worker
// (compact-search-worker.js) for as long as you let it, without touching the
// diagram, and the panel counts the tries and says what the best of them would
// change. Stop it, and then:
//
//   Apply best       puts the best layout found on the canvas;
//   Compare          shows the best few beside the current one as thumbnails,
//                    to pick by eye: the score is an estimate, and the layout
//                    that scores best is not always the one that reads best;
//   Keep searching   carries on from the next starting point, with everything
//                    found so far still in the running.
//
// Those numbers are an estimate, lines straight from centre to centre, and on
// crossings it can be well off (it saw 6 where the drawn lines had 1). So once
// there is something to compare, the panel asks whether to measure with the real
// 90 degree lines instead, which takes a second or more per layout. Said yes, the
// layout on the canvas and the best few are measured before they are compared or
// applied, and an applied layout brings its measured lines along when the diagram
// draws 90 degree lines.
//
// What a search finds stays good while the schema, the groups and the settings
// stay as they were (compactInputKey): tables can be moved around meanwhile,
// even while it runs. Anything else stops the search and drops what it found.

import { compactInput, compactInputKey, createJob, keepBest, mergeTop, applyCompactResult } from './compact-search-core.js';
import { compactLayoutMetrics } from './group-layout-compact.js';
import { goalOf, resolveShape, rankScore, rankCandidates, chooseBest, ratioText } from './layout-goals.js';
import { measureTable } from './renderer.js';
import { computeGroupBounds, resolveGroupColor } from './annotations.js';

const SEARCH_LIMIT_MS = 10 * 60 * 1000;   // a search left running stops by itself
const OPTIONS_COUNT = 3;                  // layouts shown beside the current one, and measured
const KEEP = OPTIONS_COUNT + 1;           // one of the best may be the layout on the canvas
const FRONT = 8;                          // layouts kept for improving lines and crossings at once

const nf = new Intl.NumberFormat('en-US');
const count = (n, one, many) => `${nf.format(n)} ${n === 1 ? one : many}`;
const tries = (n) => count(n, 'try', 'tries');

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
 * Run a job (createJob) in a worker, reporting each step and the end. A worker
 * that fails before saying a word never started (a browser without module
 * workers, say), so the same job then runs on the page, one step per task.
 * Returns { stop }.
 */
function runJob(message, on) {
  const onPage = () => {
    const job = createJob(message);
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      try {
        if (job.done()) {
          stopped = true;
          on.done(job.finish());
          return;
        }
        on.step(job.step());
      } catch (err) {
        stopped = true;
        on.fail(err?.message || String(err));
        return;
      }
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    return { stop() { stopped = true; } };
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
    <div class="sp-ask" hidden>
      <div>These lines and crossings are estimated with straight lines. Measure the best layouts with the real 90° lines instead? It takes a few seconds per layout.</div>
      <div class="sp-ask-actions">
        <button type="button" class="btn primary sp-ask-yes">Measure real lines</button>
        <button type="button" class="btn ghost sp-ask-no">Keep the estimate</button>
      </div>
    </div>
    <div class="sp-actions">
      <button type="button" class="btn primary sp-apply" hidden title="Puts the best layout found on the canvas. Ctrl+Z goes back.">Apply best</button>
      <button type="button" class="btn ghost sp-compare" hidden title="Shows the best layouts found beside the current one, to pick one by eye.">Compare</button>
      <button type="button" class="btn primary sp-search" title="Tries other starting points in the background until you stop it. The diagram does not change until you apply a layout.">Search</button>
      <button type="button" class="btn ghost sp-lines" hidden></button>
      <button type="button" class="btn primary sp-stop" hidden>Stop</button>
    </div>`;
  host.appendChild(el);
  const q = (s) => el.querySelector(s);
  return {
    el,
    spinner: q('.sp-spinner'), title: q('.sp-title'), status: q('.sp-status'), note: q('.sp-note'),
    progress: q('.sp-progress'), ask: q('.sp-ask'), askYes: q('.sp-ask-yes'), askNo: q('.sp-ask-no'),
    apply: q('.sp-apply'), compare: q('.sp-compare'), search: q('.sp-search'), lines: q('.sp-lines'),
    stop: q('.sp-stop'), close: q('.sp-close'),
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
 * and the lines, as measured when `layout.routes` has them and otherwise straight
 * from centre to centre, the way the estimate sees them. `layout` is
 * { positions: [[key, x, y]], groups: [group annotation], routes?: [[[x, y]]] }.
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
  const byKey = new Map(boxes.map(b => [b.key.toLowerCase(), b]));
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
  if (layout.routes) {
    for (const pts of layout.routes) {
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    }
  } else {
    const links = [
      ...(diagram.model.relations || []).map(r => [r.fromTable, r.toTable]),
      ...(diagram.manualLinks || []).map(l => [l.from?.table, l.to?.table]),
    ];
    for (const [from, to] of links) {
      const a = byKey.get(String(from || '').toLowerCase()), b = byKey.get(String(to || '').toLowerCase());
      if (!a || !b || a === b) continue;
      ctx.moveTo(a.x + a.w / 2, a.y + a.h / 2);
      ctx.lineTo(b.x + b.w / 2, b.y + b.h / 2);
    }
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
 * `afterApply` finishes whatever a rearrange finishes (direction, fit, save);
 * `onArranged` reports the first arrangement.
 * Returns { arrange, cancel, noteEdit, refresh }.
 */
export function createCompactSearch({ diagram, host, getSpacing, getShape, afterApply, onArranged }) {
  let settings = null;  // the last arrangement's { spacing, goal, shape }
  let job = null;       // running: the first arrangement, a search, or a measurement
  let session = null;   // what was found for those settings (newSession)
  let note = null;      // a line on what just happened: { text, canvas }
  let ticker = null;

  const ui = buildPanel(host);
  const picker = buildPicker();

  const newSession = (key) => ({
    key,
    top: [], front: [],             // the best layouts, and the ones improving lines and crossings at once
    attempts: 0, elapsed: 0, nextSeed: 0,
    lines: 'estimate', asked: false, // compared by the estimate or by the real lines, once asked
    real: new Map(),                // layout signature -> its measurement with the real lines
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

  // the arrangement on the canvas, measured and scored like every try
  function canvasEntry() {
    const metrics = compactLayoutMetrics(diagram);
    return {
      signature: canvasSignature(),
      positions: diagram.model.tables.map(t => [t.key, t.x, t.y]),
      metrics,
      score: rankScore(metrics, settings),
    };
  }

  // everything the searches kept, once; nothing before the first search
  function pool() {
    if (!session?.attempts) return [];
    const seen = new Set();
    return [...session.top, ...session.front].filter(r => !seen.has(r.signature) && seen.add(r.signature));
  }

  // the same layout with its real-line metrics, when it has been measured
  function withReal(entry) {
    const m = session?.real.get(entry.signature);
    return m ? { ...entry, metrics: m.metrics, score: rankScore(m.metrics, settings), measurement: m } : entry;
  }

  // Where things stand: the layout on the canvas and the candidates, ranked. With
  // real lines asked for, only the layouts measured so far, once the one on the
  // canvas has been measured too: an estimate is no match for a measurement.
  function standing() {
    const cur = canvasEntry();
    const found = pool();
    if (session?.lines === 'real' && session.real.has(cur.signature)) {
      const current = withReal(cur);
      const measured = found.filter(c => session.real.has(c.signature)).map(withReal);
      return { real: true, current, ranked: rankCandidates(settings.goal, current, measured) };
    }
    return { real: false, current: cur, ranked: rankCandidates(settings.goal, cur, found) };
  }

  // with real lines asked for: the layout on the canvas and the best few by the estimate, not measured yet
  function unmeasured() {
    if (session?.lines !== 'real' || !session.attempts) return [];
    const cur = canvasEntry();
    return [cur, ...rankCandidates(settings.goal, cur, pool()).slice(0, OPTIONS_COUNT)]
      .filter(e => !session.real.has(e.signature));
  }

  // A note `aboutCanvas` describes the layout on the canvas, and goes once that
  // layout changes (after Ctrl+Z, say). Any other stays until the next action.
  function setNote(text, { aboutCanvas = false } = {}) {
    note = { text, canvas: aboutCanvas ? canvasSignature() : null };
  }

  function apply(entry) {
    const measurement = session?.lines === 'real' ? session.real.get(entry.signature) : null;
    const drawsRightAngles = diagram.edgeRouting === 'ortho-rounded' || diagram.edgeRouting === 'ortho-sharp';
    applyCompactResult(diagram, entry, { lines: measurement && drawsRightAngles ? measurement.lines : null });
    afterApply?.(entry);
  }

  // Only the tries that finished count: an interrupted one is tried again next time.
  function end(j) {
    if (job === j) job = null;
    clearInterval(ticker);
    ticker = null;
    if (j.kind === 'search') {
      j.session.nextSeed = j.firstSeed + j.finished;
      j.session.elapsed += performance.now() - j.startedAt;
    }
  }

  // stop what is running, keeping whatever it found
  function halt() {
    const j = job;
    if (!j) return null;
    j.handle.stop();
    end(j);
    return j;
  }

  function begin(j, message, on, { keepNote = false } = {}) {
    job = j;
    j.startedAt = j.startedAt || performance.now();
    if (!keepNote) note = null;
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
        if (j.kind === 'measure') j.session.lines = 'estimate';
        setNote(j.kind === 'arrange' ? `Could not arrange the tables: ${message}`
          : j.kind === 'measure' ? `Could not measure the real lines: ${message}`
          : `The search stopped on an error: ${message}`);
        render();
      },
    });
    ticker = setInterval(render, 250);
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
        // it stays among the candidates, in case another layout is applied later
        session = newSession(key);
        session.top = keepBest([], j.result, KEEP);
        session.nextSeed = 1;
        apply(j.result);
        onArranged?.(j.result);
      },
    });
  }

  // Search and Keep searching: the same lists carry on while the schema is the same.
  function search() {
    if (job || !settings) return;
    const { input, key } = readInput();
    if (!session || session.key !== key) session = newSession(key);
    const s = session;
    const j = {
      kind: 'search', key, session: s, base: canvasEntry(),
      firstSeed: s.nextSeed, finished: 0, before: s.attempts, startedAt: performance.now(),
    };
    begin(j, { kind: 'search', input, options: { firstSeed: j.firstSeed, budgetMs: SEARCH_LIMIT_MS, keepTop: KEEP } }, {
      step(m) {
        j.finished = m.attempts;
        s.attempts = j.before + m.attempts;
        if (m.top) s.top = mergeTop(s.top, m.top, KEEP);
        if (m.front) s.front = mergeTop(s.front, m.front, FRONT, { front: true });
      },
      done() {
        setNote(`Stopped at the ${SEARCH_LIMIT_MS / 60000}-minute limit. Keep searching carries on.`);
      },
    });
  }

  // measure `layouts` with the real lines, keeping every measurement as it comes
  function measure(layouts) {
    const { input, key } = readInput();
    if (!session || session.key !== key) return;
    const s = session;
    const j = { kind: 'measure', key, session: s, total: layouts.length, measured: 0 };
    begin(j, { kind: 'measure', input, layouts: layouts.map(e => ({ signature: e.signature, positions: e.positions })) }, {
      step(m) {
        if (m.type !== 'measured') return;
        s.real.set(m.signature, m.measurement);
        j.measured++;
      },
      done() {},
    }, { keepNote: true });
  }

  function stop() {
    const j = halt();
    if (!j) return;
    if (j.kind === 'arrange') setNote('Stopped before the arrangement finished. Nothing moved.');
    else if (j.kind === 'measure') {
      j.session.lines = 'estimate';
      setNote('Stopped measuring: back to the estimate.');
    } else if (!j.finished) setNote('Stopped before a try finished.');
    render();
  }

  // What was found belongs to the schema it was found for: once that changes, a
  // running job stops and the lists are dropped. Moving tables changes nothing.
  function validate() {
    if ((!job && !session) || !settings) return;
    const { key } = readInput();
    if (job && job.key !== key) {
      const j = halt();
      setNote(j.kind === 'arrange' ? 'Stopped: the diagram changed. Nothing moved.'
        : j.kind === 'measure' ? 'Stopped measuring: the diagram changed.'
        : 'Search stopped: the diagram changed.');
    }
    if (session && session.key !== key) session = null;
  }

  function applyBest() {
    validate();
    if (job || !session) return render();
    const st = standing();
    const best = chooseBest(settings.goal, st.current, st.ranked);
    if (best) {
      apply(best);
      setNote(`Applied: ${describeChange(st.current.metrics, best.metrics)}${st.real ? ', with the real lines' : ''}. Ctrl+Z goes back.`, { aboutCanvas: true });
    }
    render();
  }

  function compare() {
    validate();
    if (job || !session) return render();
    const st = standing();
    const choices = st.ranked.slice(0, OPTIONS_COUNT);
    if (choices.length) openPicker(st, choices);
    else render();
  }

  function answer(measureReal) {
    if (!session) return;
    session.asked = true;
    session.lines = measureReal ? 'real' : 'estimate';
    render();
  }

  function workingText(j) {
    const s = j.session;
    if (j.kind === 'arrange') return 'Arranging…';
    if (j.kind === 'measure') {
      return `Measuring real lines · ${j.measured} of ${j.total} · ${clock(performance.now() - j.startedAt)}`;
    }
    const best = s.top.find(r => r.signature !== j.base.signature);
    const found = best && best.score < j.base.score - 0.5
      ? `best: ${describeChange(j.base.metrics, best.metrics)}`
      : 'nothing better yet';
    return `Searching · ${tries(s.attempts)} · ${clock(s.elapsed + performance.now() - j.startedAt)} · ${found}`;
  }

  function idleText(st, best) {
    const prefix = st.real ? 'Real lines · ' : '';
    if (!session?.attempts) return prefix + metricsText(st.current.metrics);
    if (best) return `${prefix}Best of ${tries(session.attempts)}: ${describeChange(st.current.metrics, best.metrics)}`;
    return st.real
      ? `Real lines · the current layout is the best of the ${count(st.ranked.length + 1, 'layout', 'layouts')} measured.`
      : `The current layout is the best of ${tries(session.attempts)}.`;
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
    if (running) {
      for (const b of [ui.apply, ui.compare, ui.search, ui.lines, ui.ask]) b.hidden = true;
      ui.status.textContent = workingText(job);
      return;
    }
    if (!settings) return;
    const st = standing();
    const best = chooseBest(settings.goal, st.current, st.ranked);
    const searched = !!session?.attempts;
    const hasOptions = searched && pool().length > 0;
    ui.status.textContent = idleText(st, best);
    ui.apply.hidden = !best;
    ui.compare.hidden = !st.ranked.length;
    ui.search.hidden = false;
    ui.search.textContent = searched ? 'Keep searching' : 'Search';
    // the button to press next stands out
    ui.search.classList.toggle('primary', !best);
    ui.search.classList.toggle('ghost', !!best);
    // once there is something to compare, ask once; after that, a button switches
    const asking = hasOptions && !session.asked;
    ui.ask.hidden = !asking;
    ui.lines.hidden = !hasOptions || asking;
    ui.lines.textContent = session?.lines === 'real' ? 'Use the estimate' : 'Measure real lines';
    // with real lines asked for, what gets compared is measured first
    if (!asking && picker.el.hidden) {
      const todo = unmeasured();
      if (todo.length) measure(todo);
    }
  }

  function openPicker(st, choices) {
    const cur = st.current;
    const cards = [
      {
        name: 'Current', entry: null, metrics: cur.metrics,
        layout: {
          positions: cur.positions,
          groups: (diagram.annotations || []).filter(a => a.type === 'group'),
          routes: st.real ? cur.measurement?.routes : null,
        },
      },
      ...choices.map((c, i) => ({
        name: `Option ${String.fromCharCode(65 + i)}`, entry: c, metrics: c.metrics,
        layout: { positions: c.positions, groups: c.groupBoxes, routes: st.real ? c.measurement?.routes : null },
      })),
    ];
    const which = choices.length === 1 ? 'The best layout' : `The ${choices.length} best layouts`;
    picker.desc.textContent = st.real
      ? `${which} measured, beside the one you have. Lines are drawn and counted as Optimal Route draws them.`
      : `${which} found in ${tries(session.attempts)}, beside the one you have. ` +
        'Lines are drawn straight, centre to centre, the way they are estimated, and the numbers come from the same estimate.';
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
      card.append(cv, name, metricsBlock(c.metrics, c.entry ? cur.metrics : null));
      card.addEventListener('click', () => {
        picker.el.hidden = true;
        if (c.entry) {
          // shortcuts still reach the diagram while the picker is open
          validate();
          if (session && !job) {
            apply(c.entry);
            setNote(`${c.name} applied: ${describeChange(cur.metrics, c.metrics)}. Ctrl+Z goes back.`, { aboutCanvas: true });
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

  ui.apply.addEventListener('click', applyBest);
  ui.compare.addEventListener('click', compare);
  ui.search.addEventListener('click', search);
  ui.stop.addEventListener('click', stop);
  ui.askYes.addEventListener('click', () => answer(true));
  ui.askNo.addEventListener('click', () => answer(false));
  ui.lines.addEventListener('click', () => answer(session?.lines !== 'real'));
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
     * Something is about to change the diagram. A first arrangement still running
     * would land on top of that change, so it stops; a search or a measurement
     * never touches the diagram and carries on.
     */
    noteEdit() {
      if (job?.kind !== 'arrange') return;
      halt();
      setNote('Stopped: the diagram changed. Nothing moved.');
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
