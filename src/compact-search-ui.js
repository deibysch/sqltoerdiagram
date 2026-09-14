// Once "Short lines, compact" has run, a panel offers to look for a better
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
// What a search finds stays good while the schema, the groups and the spacing
// stay as they were (compactInputKey): tables can be moved around meanwhile,
// even while it runs. Anything else stops the search and drops what it found.

import { compactInput, compactInputKey, compactSearch, stepReport, keepBest, mergeTop, applyCompactResult } from './compact-search-core.js';
import { scoreCompactLayout, compactLayoutMetrics } from './group-layout-compact.js';
import { measureTable } from './renderer.js';
import { computeGroupBounds, resolveGroupColor } from './annotations.js';

const SEARCH_LIMIT_MS = 10 * 60 * 1000;   // a search left running stops by itself
const OPTIONS_COUNT = 3;                  // layouts shown beside the current one
const KEEP = OPTIONS_COUNT + 1;           // one of the best may be the layout on the canvas

const nf = new Intl.NumberFormat('en-US');
const count = (n, one, many) => `${nf.format(n)} ${n === 1 ? one : many}`;
const tries = (n) => count(n, 'try', 'tries');

function metricsText(m) {
  return `Lines ${nf.format(m.length)} px · ${count(m.crossings, 'crossing', 'crossings')}`;
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
 * Run a search in a worker, reporting each step and the end. A worker that fails
 * before saying a word never started (a browser without module workers, say), so
 * the same search then runs on the page, one try per task. Returns { stop }.
 */
function runSearch(input, options, on) {
  const onPage = () => {
    const search = compactSearch(input, options);
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      let step;
      try {
        step = search.step();
      } catch (err) {
        stopped = true;
        on.fail(err?.message || String(err));
        return;
      }
      on.step(stepReport(search, step));
      if (search.state.done) {
        stopped = true;
        on.done({ attempts: search.state.attempts, nextSeed: search.state.nextSeed });
      } else {
        setTimeout(tick, 0);
      }
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
    if (m.type === 'step') on.step(m);
    else if (m.type === 'done') { worker.terminate(); on.done(m); }
    else if (m.type === 'error') { worker.terminate(); on.fail(m.message); }
  };
  worker.onerror = (e) => {
    e.preventDefault();
    worker.terminate();
    if (heard) on.fail(e.message || 'The search stopped unexpectedly.');
    else fallback = onPage();
  };
  worker.postMessage({ input, options });
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
        <div class="sp-title">Short lines, compact</div>
        <div class="sp-status" aria-live="polite"></div>
        <div class="sp-note" hidden></div>
      </div>
      <button type="button" class="btn ghost icon sp-close" title="Close" aria-label="Close">✕</button>
    </div>
    <div class="sp-progress" hidden><div class="sp-bar"></div></div>
    <div class="sp-actions">
      <button type="button" class="btn primary sp-apply" hidden title="Puts the best layout found on the canvas. Ctrl+Z goes back.">Apply best</button>
      <button type="button" class="btn ghost sp-compare" hidden title="Shows the best layouts found beside the current one, to pick one by eye.">Compare</button>
      <button type="button" class="btn primary sp-search" title="Tries other starting points in the background until you stop it. The diagram does not change until you apply a layout.">Search</button>
      <button type="button" class="btn primary sp-stop" hidden>Stop</button>
    </div>`;
  host.appendChild(el);
  const q = (s) => el.querySelector(s);
  return {
    el,
    spinner: q('.sp-spinner'), status: q('.sp-status'), note: q('.sp-note'), progress: q('.sp-progress'),
    apply: q('.sp-apply'), compare: q('.sp-compare'), search: q('.sp-search'), stop: q('.sp-stop'), close: q('.sp-close'),
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
 * and the relations as straight lines centre to centre, which is how the score
 * sees them. `layout` is { positions: [[key, x, y]], groups: [group annotation] }.
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
  for (const r of [...boxes, ...groups.map(g => g.b)]) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
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
  const ratio = m.width && m.height ? Math.max(m.width / m.height, m.height / m.width) : 1;
  row(`Shape ${ratio.toFixed(1)} : 1 ${m.width >= m.height ? 'wide' : 'tall'}`, '', false);
  return wrap;
}

/**
 * The panel and what it runs. `afterApply` finishes whatever a rearrange
 * finishes (direction, fit, save); `onArranged` reports the first arrangement.
 * Returns { arrange, cancel, noteEdit, refresh }.
 */
export function createCompactSearch({ diagram, host, getSpacing, afterApply, onArranged }) {
  let job = null;       // running: the first arrangement, or a search
  let session = null;   // what the searches found: { key, top, attempts, elapsed, nextSeed }
  let note = null;      // a line on what just happened: { text, canvas }
  let ticker = null;

  const ui = buildPanel(host);
  const picker = buildPicker();

  const canvasSignature = () => diagram.model.tables.map(t => `${t.x},${t.y}`).join(';');

  // The schema as a try reads it, and the key of what the tries depend on.
  // Measured afresh: the worker gets only these sizes and cannot measure text.
  function readInput() {
    const level = diagram.diagramLevel || 'physical';
    for (const t of diagram.model.tables) {
      const m = measureTable(t, level);
      t.w = m.w; t.h = m.h; t.rowH = m.rowH; t.headerH = m.headerH;
    }
    const input = compactInput(diagram, getSpacing());
    return { input, key: compactInputKey(input) };
  }

  // the arrangement on the canvas, scored like every try
  function currentLayout() {
    return { score: scoreCompactLayout(diagram), metrics: compactLayoutMetrics(diagram), signature: canvasSignature() };
  }

  // what the searches found that is not already on the canvas, best first
  function candidates(cur) {
    return session?.attempts ? session.top.filter(r => r.signature !== cur.signature) : [];
  }

  // A note `aboutCanvas` describes the layout on the canvas, and goes once that
  // layout changes (after Ctrl+Z, say). Any other stays until the next action.
  function setNote(text, { aboutCanvas = false } = {}) {
    note = { text, canvas: aboutCanvas ? canvasSignature() : null };
  }

  function apply(result) {
    applyCompactResult(diagram, result);
    afterApply?.(result);
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

  function begin(j, input, options, on) {
    job = j;
    note = null;
    picker.el.hidden = true;
    ui.el.hidden = false;
    j.handle = runSearch(input, options, {
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
        setNote(j.kind === 'arrange' ? `Could not arrange the tables: ${message}` : `The search stopped on an error: ${message}`);
        render();
      },
    });
    ticker = setInterval(render, 250);
    render();
  }

  // The menu option itself: one try from seed 0, the arrangement it has always given.
  function arrange() {
    if (!diagram.model?.tables?.length) {
      alert('The diagram has no tables to arrange.');
      return;
    }
    halt();
    const { input, key } = readInput();
    const j = { kind: 'arrange', key, result: null };
    begin(j, input, { firstSeed: 0, maxAttempts: 1 }, {
      step(m) {
        if (m.result) j.result = m.result;
      },
      done() {
        if (!j.result) return;
        // it stays among the candidates, in case another layout is applied later
        session = { key, top: keepBest([], j.result, KEEP), attempts: 0, elapsed: 0, nextSeed: 1 };
        apply(j.result);
        onArranged?.(j.result);
      },
    });
  }

  // Search and Keep searching: the same list carries on while the schema is the same.
  function search() {
    if (job) return;
    const { input, key } = readInput();
    if (!session || session.key !== key) session = { key, top: [], attempts: 0, elapsed: 0, nextSeed: 0 };
    const s = session;
    const j = {
      kind: 'search', key, session: s, base: currentLayout(),
      firstSeed: s.nextSeed, finished: 0, before: s.attempts, startedAt: performance.now(),
    };
    begin(j, input, { firstSeed: j.firstSeed, budgetMs: SEARCH_LIMIT_MS, keepTop: KEEP }, {
      step(m) {
        j.finished = m.attempts;
        s.attempts = j.before + m.attempts;
        if (m.top) s.top = mergeTop(s.top, m.top, KEEP);
      },
      done() {
        setNote(`Stopped at the ${SEARCH_LIMIT_MS / 60000}-minute limit. Keep searching carries on.`);
      },
    });
  }

  function stop() {
    const j = halt();
    if (!j) return;
    if (j.kind === 'arrange') setNote('Stopped before the arrangement finished. Nothing moved.');
    else if (!j.finished) setNote('Stopped before a try finished.');
    render();
  }

  // What was found belongs to the schema it was found for: once that changes, a
  // running job stops and the list is dropped. Moving tables changes nothing.
  function validate() {
    if (!job && !session) return;
    const { key } = readInput();
    if (job && job.key !== key) {
      const j = halt();
      setNote(j.kind === 'arrange' ? 'Stopped: the diagram changed. Nothing moved.' : 'Search stopped: the diagram changed.');
    }
    if (session && session.key !== key) session = null;
  }

  function applyBest() {
    validate();
    const cur = currentLayout();
    const best = job ? null : candidates(cur)[0];
    if (best && best.score < cur.score - 0.5) {
      apply(best);
      setNote(`Applied: ${describeChange(cur.metrics, best.metrics)}. Ctrl+Z goes back.`, { aboutCanvas: true });
    }
    render();
  }

  function compare() {
    validate();
    const cur = currentLayout();
    const choices = job ? [] : candidates(cur).slice(0, OPTIONS_COUNT);
    if (choices.length) openPicker(cur, choices);
    else render();
  }

  function searchingText(j) {
    const s = j.session;
    const best = s.top.find(r => r.signature !== j.base.signature);
    const found = best && best.score < j.base.score - 0.5
      ? `best: ${describeChange(j.base.metrics, best.metrics)}`
      : 'nothing better yet';
    return `Searching · ${tries(s.attempts)} · ${clock(s.elapsed + performance.now() - j.startedAt)} · ${found}`;
  }

  function idleText(cur, better) {
    if (!session?.attempts) return metricsText(cur.metrics);
    const n = tries(session.attempts);
    if (better) return `Best of ${n}: ${describeChange(cur.metrics, better.metrics)}`;
    if (session.top[0]?.signature === cur.signature) return `The current layout is the best of ${n}.`;
    return `Nothing better than the current layout in ${n}.`;
  }

  function render() {
    if (ui.el.hidden) return;
    if (note?.canvas && note.canvas !== canvasSignature()) note = null;
    ui.note.hidden = !note;
    ui.note.textContent = note ? note.text : '';
    const running = !!job;
    ui.spinner.hidden = !running;
    ui.progress.hidden = !running;
    ui.stop.hidden = !running;
    if (running) {
      ui.apply.hidden = true;
      ui.compare.hidden = true;
      ui.search.hidden = true;
      ui.status.textContent = job.kind === 'arrange' ? 'Arranging…' : searchingText(job);
      return;
    }
    const cur = currentLayout();
    const found = candidates(cur);
    const better = found[0] && found[0].score < cur.score - 0.5 ? found[0] : null;
    ui.status.textContent = idleText(cur, better);
    ui.apply.hidden = !better;
    ui.compare.hidden = !found.length;
    ui.search.hidden = false;
    ui.search.textContent = session?.attempts ? 'Keep searching' : 'Search';
    // the button to press next stands out
    ui.search.classList.toggle('primary', !better);
    ui.search.classList.toggle('ghost', !!better);
  }

  function openPicker(cur, choices) {
    const placed = diagram.model.tables.filter(t => Number.isFinite(t.x));
    const cards = [
      {
        name: 'Current', result: null, metrics: cur.metrics,
        layout: { positions: placed.map(t => [t.key, t.x, t.y]), groups: (diagram.annotations || []).filter(a => a.type === 'group') },
      },
      ...choices.map((r, i) => ({
        name: `Option ${String.fromCharCode(65 + i)}`, result: r, metrics: r.metrics,
        layout: { positions: r.positions, groups: r.groupBoxes },
      })),
    ];
    picker.desc.textContent =
      `${choices.length === 1 ? 'The best layout' : `The ${choices.length} best layouts`} found in ${tries(session.attempts)}, beside the one you have. ` +
      'Lines are drawn straight, centre to centre, the way they are scored, and the numbers come from the same estimate.';
    picker.list.replaceChildren();
    const drawings = [];
    for (const c of cards) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'layout-option' + (c.result ? '' : ' current');
      const cv = document.createElement('canvas');
      const name = document.createElement('div');
      name.className = 'lo-name';
      name.textContent = c.name;
      card.append(cv, name, metricsBlock(c.metrics, c.result ? cur.metrics : null));
      card.addEventListener('click', () => {
        picker.el.hidden = true;
        if (c.result) {
          // shortcuts still reach the diagram while the picker is open
          validate();
          if (session && !job) {
            apply(c.result);
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
     * would land on top of that change, so it stops; a search never touches the
     * diagram and carries on.
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
