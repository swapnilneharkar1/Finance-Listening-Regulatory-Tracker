/* ── Treasury Peer Benchmarking dashboards (injected by the Streamlit app) ──
   Data: window.__TREASURY__ (data/treasury/benchmark.json, built weekly by scraper/treasury.js).
   Adds a "Treasury Peer Benchmarking" card with dashboard sub-tabs. Charts are plain SVG. */
(function () {
  const T = window.__TREASURY__;
  if (!T || typeof REGULATORS === 'undefined') return;
  T.companies = T.companies || [];
  T.years = T.years || [];
  const AUTO = T.method === 'auto';
  const CAN_EDIT = !!window.__TPB_CAN_EDIT__;

  const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
  const companies = T.companies.map((c, i) => Object.assign(c, { color: COLORS[i % COLORS.length] }));
  const base = companies.find(c => /bajaj/i.test(c.name)) || companies[0];
  const peers = companies.filter(c => c !== base);
  const studies = T.studies || [];

  const TABS = !companies.length ? [{ label: 'Overview', kind: 'empty' }] : [
    { label: 'Overview', kind: 'overview' },
    { label: 'Borrowing Mix', kind: 'mix', part: 'borrowing' },
    { label: 'Investment Mix', kind: 'mix', part: 'investments' },
    { label: 'Cost & KPIs', kind: 'kpi' },
    ...companies.map(c => ({ label: c.name, kind: 'company', company: c })),
    ...(studies.length ? [{ label: 'Insights', kind: 'insights' }] : []),
  ];

  REGULATORS.TREASURY = {
    name: 'Treasury Peer Benchmarking',
    color: '#0f2d52',
    tabs: TABS.map(t => ({ label: t.label, cat: 'Benchmarking', src: '' })),
  };

  // Card in the regulator grid
  const grid = document.getElementById('regulatorGrid');
  if (grid && !grid.querySelector('[data-reg="TREASURY"]')) {
    grid.insertAdjacentHTML('beforeend',
      `<button class="reg-btn reg-treasury" data-reg="TREASURY" onclick="selectReg('TREASURY')">
         <span class="reg-name">Treasury Peer Benchmarking</span>
         <span class="reg-full">NBFC Borrowing &amp; Investment Mix</span>
         <span class="reg-count reg-count-label" id="count-TREASURY">${companies.length ? `${companies.length} NBFCs · ${T.default_year || ''}` : 'Awaiting first run'}</span>
       </button>`);
  }

  // Dashboard container next to the news table
  const panel = document.querySelector('.content-panel');
  const tableWrap = panel && panel.querySelector('.table-wrap');
  const controls = panel && panel.querySelector('.controls-bar');
  const view = document.createElement('div');
  view.className = 'tpb'; view.id = 'tpbView'; view.hidden = true;
  if (tableWrap) tableWrap.after(view);
  const tip = document.createElement('div');
  tip.className = 'tpb-tip'; tip.hidden = true;
  document.body.appendChild(tip);

  const state = { year: T.default_year, unit: 'share', companyYear: {} };

  // ── Hook into the portal's tab loading ──
  const origLoadTab = loadTab;
  loadTab = async function (force) {
    if (currentReg === 'TREASURY') {
      if (controls) controls.style.display = 'none';
      if (tableWrap) tableWrap.style.display = 'none';
      view.hidden = false;
      const title = document.querySelector('#subtabBar .panel-title');
      if (title && title.firstChild) title.firstChild.textContent = 'Treasury Peer Benchmarking ';
      const pc = document.getElementById('panelCount'); if (pc) pc.textContent = companies.length;
      const fi = document.getElementById('footerInfo'); if (fi) fi.textContent = `Source: ${T.source}`;
      const ft = document.getElementById('footerTime'); if (ft) ft.textContent = companies.length ? `${companies.length} NBFCs · ${T.years[0]}–${T.years[T.years.length - 1]}` : 'Not collected yet';
      render();
      return;
    }
    if (controls) controls.style.display = '';
    if (tableWrap) tableWrap.style.display = '';
    view.hidden = true;
    return origLoadTab(force);
  };
  const origCounts = populateAllCounts;
  populateAllCounts = function () {
    origCounts();
    const el = document.getElementById('count-TREASURY');
    if (el) { el.textContent = companies.length ? `${companies.length} NBFCs · ${T.default_year || ''}` : 'Awaiting first run'; el.classList.remove('reg-count-zero'); }
  };
  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (currentReg === 'TREASURY') render(); }, 150); });

  // ── Formatting ──
  const pct = (v, d = 1) => v == null || isNaN(v) ? '—' : (v * 100).toFixed(d) + '%';
  const pp = v => v == null || isNaN(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(1) + ' pp';
  const bps = v => v == null || isNaN(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.round(Math.abs(v * 10000)) + ' bps';
  const cr = v => v == null || isNaN(v) ? '—' : '₹' + Math.round(v).toLocaleString('en-IN') + ' cr';
  const crAxis = v => {
    const a = Math.abs(v);
    if (a >= 1e5) return +(v / 1e5).toFixed(2) + 'L';
    if (a >= 1e3) return +(v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v));
  };
  const fy = y => y;

  // ── DOM helpers ──
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v; else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  }
  const NS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
    for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  }
  function card(title, sub, ...body) {
    return h('div', { class: 'tpb-card' }, h('h3', { text: title }), sub ? h('div', { class: 'sub', text: sub }) : null, ...body);
  }
  function tile(k, v, d) {
    const dd = h('div', { class: 'd' });
    if (Array.isArray(d)) d.forEach(x => dd.append(typeof x === 'string' ? document.createTextNode(x) : x)); else if (d) dd.textContent = d;
    return h('div', { class: 'tpb-tile' }, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }), d ? dd : null);
  }
  function legend(items) {
    return h('div', { class: 'tpb-legend' }, items.map(it =>
      h('span', {}, h('i', { class: it.kind || '', style: `background:${it.color}` }), it.label)));
  }
  function table(cols, rows, opts = {}) {
    const thead = h('thead', {}, h('tr', {}, cols.map(c => h('th', { class: c.num ? 'n' : '', text: c.label }))));
    const tbody = h('tbody', {}, rows.map(r => h('tr', { class: r._class || '' },
      cols.map(c => { const v = c.get(r); const td = h('td', { class: (c.num ? 'n ' : '') + (c.cls ? c.cls(r) : ''), text: v }); return td; }))));
    const t = h('div', { class: 'tpb-table-wrap' }, h('table', {}, thead, tbody));
    if (opts.open) return t;
    return h('details', {}, h('summary', { text: opts.summary || 'Show table' }), t);
  }

  // ── Tooltip ──
  function showTip(evt, title, rows) {
    tip.replaceChildren(h('div', { class: 't', text: title }),
      ...rows.map(r => h('div', { class: 'r' }, h('i', { style: `background:${r.color || '#898781'}` }), h('b', { text: r.value }), h('span', { text: r.label }))));
    tip.hidden = false;
    const pad = 14, w = tip.offsetWidth, hh = tip.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
    if (y + hh > window.innerHeight - 8) y = evt.clientY - hh - pad;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  // Round tick steps (1, 2, 5 × 10^k) so axes read 0 / 10% / 20%, 0 / 1L / 2L.
  function niceStep(range, target = 4) {
    if (!(range > 0)) return 1;
    const raw = range / target, p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }
  function niceMax(v) { const st = niceStep(v); return Math.ceil(v / st - 1e-9) * st; }
  function ticks(max) { const st = niceStep(max), out = []; for (let t = 0; t <= max + st / 2; t += st) out.push(+t.toFixed(10)); return out; }
  function hbarPath(x0, x1, y, hgt, r = 4) {
    const w = x1 - x0; if (Math.abs(w) < 0.5) return '';
    r = Math.min(r, hgt / 2, Math.abs(w));
    if (w > 0) return `M${x0},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y + hgt - r}Q${x1},${y + hgt} ${x1 - r},${y + hgt}H${x0}Z`;
    return `M${x0},${y}H${x1 + r}Q${x1},${y} ${x1},${y + r}V${y + hgt - r}Q${x1},${y + hgt} ${x1 + r},${y + hgt}H${x0}Z`;
  }
  const width = el => Math.max(320, (el.clientWidth || view.clientWidth - 40));

  // ── Chart: grouped horizontal bars (categories × series) + optional peer-average tick ──
  function groupedBars(holder, { categories, series, fmt, axisFmt, avg, labelSeries }) {
    const W = width(holder), labelW = Math.min(170, W * 0.32), right = 56;
    const barH = 7, gap = 2, groupPad = 14;
    const groupH = series.length * (barH + gap) - gap;
    const H = categories.length * (groupH + groupPad) + 26;
    const max = niceMax(1.08 * Math.max(0.0001, ...categories.flatMap(c => series.map(sr => sr.values[c] || 0)), ...(avg ? categories.map(c => avg[c] || 0) : [])));
    const x = v => labelW + (W - labelW - right) * (v / max);
    const svg = s('svg', { width: W, height: H, role: 'img' });
    ticks(max).forEach(t => {
      svg.append(s('line', { x1: x(t), x2: x(t), y1: 0, y2: H - 22, stroke: t === 0 ? '#c3c2b7' : '#e1e0d9', 'stroke-width': 1 }));
      svg.append(s('text', { x: x(t), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: '#898781' }, axisFmt(t)));
    });
    categories.forEach((c, gi) => {
      const y0 = gi * (groupH + groupPad) + 4;
      const g = s('g', {});
      g.append(s('text', { x: labelW - 10, y: y0 + groupH / 2 + 4, 'text-anchor': 'end', 'font-size': 12, fill: '#1a2030' }, c));
      series.forEach((sr, si) => {
        const v = sr.values[c]; if (v == null) return;
        const y = y0 + si * (barH + gap);
        g.append(s('path', { class: 'bar', d: hbarPath(x(0), x(v), y, barH), fill: sr.color }));
        const lbl = fmt(v);
        if (labelSeries && sr === labelSeries && v > 0 && !/^0(\.0+)?%$/.test(lbl)) {
          let lx = x(v) + 5; const tw = lbl.length * 6.2;
          const ax = avg && avg[c] != null ? x(avg[c]) : null;
          if (ax != null && ax > lx - 8 && ax < lx + tw + 4) lx = ax + 6;   // step past the peer-average tick
          g.append(s('text', { x: lx, y: y + barH, 'font-size': 10.5, fill: '#5a6474' }, lbl));
        }
      });
      if (avg && avg[c] != null)
        g.append(s('line', { x1: x(avg[c]), x2: x(avg[c]), y1: y0 - 3, y2: y0 + groupH + 3, stroke: '#52514e', 'stroke-width': 2, 'stroke-linecap': 'round' }));
      const hit = s('rect', { class: 'hit', x: 0, y: y0 - groupPad / 2, width: W, height: groupH + groupPad });
      const rows = () => [...series.map(sr => ({ color: sr.color, label: sr.name, value: fmt(sr.values[c]) })),
        ...(avg && avg[c] != null ? [{ color: '#52514e', label: 'Peer average', value: fmt(avg[c]) }] : [])];
      hit.addEventListener('pointermove', e => { g.classList.add('hl'); showTip(e, c, rows()); });
      hit.addEventListener('pointerleave', () => { g.classList.remove('hl'); hideTip(); });
      g.append(hit);
      svg.append(g);
    });
    holder.replaceChildren(svg);
  }

  // ── Chart: diverging bars (gap vs peer average) ──
  function divergingBars(holder, rows) {
    const W = width(holder), labelW = Math.min(170, W * 0.34), barH = 14, rowH = 30;
    const H = rows.length * rowH + 26;
    const m = niceMax(1.3 * Math.max(0.001, ...rows.map(r => Math.abs(r.gap || 0))));
    const mid = labelW + (W - labelW) / 2, half = (W - labelW) / 2 - 52;
    const x = v => mid + half * (v / m);
    const svg = s('svg', { width: W, height: H, role: 'img' });
    ticks(m).flatMap(t => t ? [-t, t] : [0]).forEach(t => {
      svg.append(s('line', { x1: x(t), x2: x(t), y1: 0, y2: H - 22, stroke: t === 0 ? '#c3c2b7' : '#e1e0d9', 'stroke-width': 1 }));
      svg.append(s('text', { x: x(t), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: '#898781' }, t === 0 ? '0' : pp(t).replace(' pp', '')));
    });
    rows.forEach((r, i) => {
      const y = i * rowH + 6, g = s('g', {});
      g.append(s('text', { x: labelW - 10, y: y + barH / 2 + 4, 'text-anchor': 'end', 'font-size': 12, fill: '#1a2030' }, r.metric));
      const v = r.gap || 0;
      g.append(s('path', { class: 'bar', d: hbarPath(x(0), x(v), y, barH), fill: v >= 0 ? '#2a78d6' : '#e34948' }));
      g.append(s('text', { x: v >= 0 ? x(v) + 6 : x(v) - 6, y: y + barH / 2 + 4, 'text-anchor': v >= 0 ? 'start' : 'end', 'font-size': 11, fill: '#5a6474' }, pp(v)));
      const hit = s('rect', { class: 'hit', x: 0, y: y - 6, width: W, height: rowH });
      hit.addEventListener('pointermove', e => { g.classList.add('hl'); showTip(e, r.metric, [
        { color: base.color, label: base.short, value: pct(r.bfl) },
        { color: '#52514e', label: 'Peer average', value: pct(r.peer) },
        { color: v >= 0 ? '#2a78d6' : '#e34948', label: 'Gap', value: pp(v) }]); });
      hit.addEventListener('pointerleave', () => { g.classList.remove('hl'); hideTip(); });
      g.append(hit); svg.append(g);
    });
    holder.replaceChildren(svg);
  }

  // ── Chart: line chart by FY with crosshair ──
  function lineChart(holder, { years, series, fmt, axisFmt, minZero = true, height = 240 }) {
    const W = width(holder), H = height, L = 52, R = 16, Tp = 10, B = 26;
    const vals = series.flatMap(sr => years.map(y => sr.values[y]).filter(v => v != null));
    if (!vals.length) { holder.replaceChildren(h('div', { class: 'tpb-empty', text: 'No data in the Excel for this chart.' })); return; }
    let lo = minZero ? 0 : Math.min(...vals), hi = Math.max(...vals);
    if (!minZero) { const pad = (hi - lo) * 0.25 || hi * 0.05; lo = Math.max(0, lo - pad); hi = hi + pad; }
    const st = niceStep(hi - lo);
    lo = Math.floor(lo / st + 1e-9) * st; hi = Math.ceil(hi / st - 1e-9) * st;
    const xs = i => L + (W - L - R) * (years.length === 1 ? 0.5 : i / (years.length - 1));
    const y = v => Tp + (H - Tp - B) * (1 - (v - lo) / (hi - lo || 1));
    const svg = s('svg', { width: W, height: H, role: 'img' });
    for (let t = lo; t <= hi + st / 2; t += st) {
      svg.append(s('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), stroke: Math.abs(t) < 1e-12 ? '#c3c2b7' : '#e1e0d9', 'stroke-width': 1 }));
      svg.append(s('text', { x: L - 8, y: y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#898781' }, axisFmt(t)));
    }
    years.forEach((yr, i) => svg.append(s('text', { x: xs(i), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: '#898781' }, fy(yr))));
    series.forEach(sr => {
      let d = '', pen = false;
      years.forEach((yr, i) => { const v = sr.values[yr]; if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + xs(i) + ',' + y(v); pen = true; });
      svg.append(s('path', { d, fill: 'none', stroke: sr.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      years.forEach((yr, i) => { const v = sr.values[yr]; if (v != null) svg.append(s('circle', { cx: xs(i), cy: y(v), r: 4, fill: sr.color, stroke: '#fff', 'stroke-width': 2 })); });
    });
    const cross = s('line', { y1: Tp, y2: H - B, stroke: '#898781', 'stroke-width': 1, visibility: 'hidden' });
    svg.append(cross);
    const hit = s('rect', { class: 'hit', x: L, y: 0, width: W - L - R, height: H - B });
    hit.addEventListener('pointermove', e => {
      const rect = svg.getBoundingClientRect(), px = e.clientX - rect.left;
      let bi = 0, bd = 1e9; years.forEach((_, i) => { const dd = Math.abs(xs(i) - px); if (dd < bd) { bd = dd; bi = i; } });
      cross.setAttribute('x1', xs(bi)); cross.setAttribute('x2', xs(bi)); cross.setAttribute('visibility', 'visible');
      const yr = years[bi];
      showTip(e, yr, series.map(sr => ({ color: sr.color, label: sr.name, value: fmt(sr.values[yr]) }))
        .sort((a, b) => (parseFloat(String(b.value).replace(/[^\d.-]/g, '')) || -1e9) - (parseFloat(String(a.value).replace(/[^\d.-]/g, '')) || -1e9)));
    });
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
    svg.append(hit);
    holder.replaceChildren(svg);
  }

  // ── Data helpers ──
  const partOf = (c, part) => part === 'borrowing' ? c.borrowing : c.investments;
  function yearsFor(part) {
    const set = new Set(); companies.forEach(c => (partOf(c, part)?.years || []).forEach(y => set.add(y)));
    return [...set].sort((a, b) => +a.slice(2) - +b.slice(2));
  }
  function mixValues(c, part, year, unit) {
    const p = partOf(c, part); if (!p || !p.years.includes(year)) return null;
    const out = {}; const src = unit === 'amount' ? p.mix.amounts : p.mix.shares;
    for (const cat of p.mix.categories) out[cat] = src[cat][year];
    return out;
  }
  function peerAvg(cats, part, year, unit) {
    const out = {};
    cats.forEach(cat => {
      const vs = peers.map(c => mixValues(c, part, year, unit)).filter(Boolean).map(m => m[cat] || 0);
      out[cat] = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
    });
    return out;
  }

  function filters(...kids) { return h('div', { class: 'tpb-filters' }, ...kids); }
  function yearSelect(years, value, onchange, label = 'Financial year') {
    const sel = h('select', { 'aria-label': label, onchange: e => onchange(e.target.value) }, years.map(y => h('option', { value: y, text: y })));
    sel.value = years.includes(value) ? value : years[years.length - 1];
    return [h('label', { text: label }), sel];
  }
  function seg(options, value, onchange) {
    return h('div', { class: 'tpb-seg', role: 'group' }, options.map(o =>
      h('button', { type: 'button', 'aria-pressed': String(o.value === value), onclick: () => onchange(o.value), text: o.label })));
  }

  // ── Views ──
  function render() {
    hideTip();
    const tab = TABS[currentTabIdx] || TABS[0];
    view.replaceChildren();
    try {
      ({ overview: renderOverview, mix: renderMix, kpi: renderKpi, company: renderCompany, insights: renderInsights, empty: renderEmpty })[tab.kind](tab);
    } catch (e) {
      console.error(e);
      view.replaceChildren(h('div', { class: 'tpb-empty', text: 'Could not draw this dashboard: ' + e.message }));
    }
  }

  function renderOverview() {
    const bt = T.summary.find(t => t.kind === 'borrowing'), it = T.summary.find(t => t.kind === 'investment');
    const yr = (bt && bt.fy) || T.default_year;
    const costRow = bt && bt.rows.find(r => /cost/i.test(r.metric));
    const b = base.borrowing, inv = base.investments;
    const tiles = h('div', { class: 'tpb-tiles' },
      costRow ? tile(`Average borrowing cost, ${yr}`, pct(costRow.bfl, 2), [`Peer avg ${pct(costRow.peer, 2)} · `, h('b', { text: bps(costRow.gap) }), ' vs peers']) : null,
      tile(`${base.short} total borrowings, ${yr}`, cr(b.total[yr]), b.total[prevYear(b.years, yr)] ? [h('b', { text: growth(b.total[yr], b.total[prevYear(b.years, yr)]) }), ` vs ${prevYear(b.years, yr)}`] : null),
      inv ? tile(`${base.short} investment book, ${yr}`, cr(inv.total[yr]), inv.total[prevYear(inv.years, yr)] ? [h('b', { text: growth(inv.total[yr], inv.total[prevYear(inv.years, yr)]) }), ` vs ${prevYear(inv.years, yr)}`] : null) : null,
      tile('Peers benchmarked', String(peers.length), peers.map(p => p.short).join(', ')));
    view.append(tiles);
    const missing = Object.entries(T.missing || {}).filter(([, v]) => v && v.length);
    const top = filters(
      h('span', { class: 'tpb-note', style: 'margin-left:0', text: AUTO ? `Auto-extracted from annual reports (standalone) · updated ${String(T.generated_at || '').slice(0, 10)}` : `Source: ${T.source}` }),
      editButton());
    view.prepend(top);
    if (missing.length) {
      const names = Object.fromEntries((T.companies || []).map(c => [c.key, c.short]));
      view.append(h('details', { class: 'tpb-card', style: 'padding:10px 16px' },
        h('summary', { text: `Data not yet available for some NBFCs / years (${missing.length})` }),
        h('ul', { class: 'tpb-obs' }, missing.map(([k, v]) => h('li', {}, h('b', { text: names[k] || k }), h('div', { text: v.join(', ') })))),
        h('div', { class: 'foot', text: 'Years are filled in automatically when the report is found. For anything not on NSE/BSE, a direct PDF link can be added in scraper/treasury-sources.js.' })));
    }

    if (T.overview_summary && T.overview_summary.text) {
      const o = T.overview_summary;
      view.append(card('Summary', o.edited ? `Edited by ${o.edited.by}.` : 'Drafted by AI from the extracted figures; every number is checked against the data.',
        h('div', { class: 'tpb-summary' }, String(o.text).split(/\n+/).map(p => h('p', { text: p }))), edited(o)));
    }

    const grid2 = h('div', { class: 'tpb-grid2' });
    [[bt, 'Borrowing mix'], [it, 'Investment mix']].forEach(([t, name]) => {
      if (!t) return;
      const rows = t.rows.filter(r => !/cost/i.test(r.metric) && r.gap != null);
      const chart = h('div', { class: 'tpb-chart' });
      const c = card(`${name}: ${base.short} vs peer average, ${t.fy || yr}`,
        `Gap in percentage points of the total book. Blue = ${base.short} higher than peers, red = lower.`,
        legend([{ color: '#2a78d6', label: `${base.short} above peer avg` }, { color: '#e34948', label: `${base.short} below peer avg` }]),
        chart,
        h('ul', { class: 'tpb-obs' }, t.rows.filter(r => r.remark).map(r => h('li', {}, h('b', { text: r.metric }), h('span', { class: 'chip', text: /cost/i.test(r.metric) ? bps(r.gap) : pp(r.gap) }), edited(r), h('div', { text: r.remark })))),
        table([{ label: 'Metric', get: r => r.metric }, { label: base.short, num: 1, get: r => pct(r.bfl) },
               { label: 'Peer avg', num: 1, get: r => pct(r.peer) }, { label: 'Gap', num: 1, get: r => pp(r.gap), cls: r => r.gap >= 0 ? 'pos' : 'neg' }], t.rows),
        h('div', { class: 'foot', text: AUTO ? `Peer average = simple average of ${peers.map(p => p.short).join(', ')} for ${t.fy}. Remarks are drafted from the numbers${CAN_EDIT ? ' and can be edited' : ''}.` : `Source: "${t.title}" table in ${T.source}. Peer average as calculated in the Excel.` }));
      grid2.append(c);
      requestAnimationFrame(() => divergingBars(chart, rows));
    });
    view.append(grid2);
    if (!bt && !it) view.append(h('div', { class: 'tpb-empty', text: 'No BFL-vs-peer summary table found in the Excel.' }));
  }

  function renderMix(tab) {
    const part = tab.part, years = yearsFor(part);
    if (!years.length) { view.append(h('div', { class: 'tpb-empty', text: 'No data in the Excel for this view.' })); return; }
    const year = years.includes(state.year) ? state.year : years[years.length - 1];
    const unit = state.unit;
    const fmt = unit === 'amount' ? cr : pct;
    const axisFmt = unit === 'amount' ? crAxis : (v => +(v * 100).toFixed(1) + '%');
    const present = companies.filter(c => mixValues(c, part, year, unit));
    const masterCats = part === 'borrowing' ? T.borrowing_categories : T.investment_categories;
    const cats = masterCats.filter(cat => present.some(c => (mixValues(c, part, year, unit) || {})[cat] > 0));
    const series = present.map(c => ({ name: c.short, color: c.color, values: mixValues(c, part, year, unit) || {} }));
    const avg = peerAvg(cats, part, year, unit);
    const missing = companies.filter(c => !present.includes(c));
    const bs = series.find(x => x.name === base.short);

    view.append(filters(...yearSelect(years, year, v => { state.year = v; render(); }),
      seg([{ value: 'share', label: '% of total' }, { value: 'amount', label: '₹ crore' }], unit, v => { state.unit = v; render(); }),
      h('span', { class: 'tpb-note', text: missing.length ? `No ${year} data for: ${missing.map(c => c.short).join(', ')}` : '' })));

    const chart = h('div', { class: 'tpb-chart' });
    const what = part === 'borrowing' ? 'Borrowing mix' : 'Investment mix';
    view.append(card(`${what} by instrument, ${year}`,
      unit === 'share' ? `Share of each company's total ${part === 'borrowing' ? 'borrowings' : 'investments'}. Hover a row for exact values.` : 'Outstanding amount, ₹ crore. Hover a row for exact values.',
      legend([...series.map(sr => ({ color: sr.color, label: sr.name })), ...(peers.length ? [{ color: '#52514e', label: 'Peer average (excl. ' + base.short + ')', kind: 'tick' }] : [])]),
      chart,
      table([{ label: 'Instrument', get: r => r.cat }, ...series.map(sr => ({ label: sr.name, num: 1, get: r => fmt(sr.values[r.cat]) })),
             { label: 'Peer avg', num: 1, get: r => fmt(avg[r.cat]) },
             ...(bs && unit === 'share' ? [{ label: `${base.short} vs peers`, num: 1, get: r => pp((bs.values[r.cat] || 0) - (avg[r.cat] || 0)), cls: r => ((bs.values[r.cat] || 0) - (avg[r.cat] || 0)) >= 0 ? 'pos' : 'neg' }] : [])],
            cats.map(cat => ({ cat }))),
      h('div', { class: 'foot', text: (part === 'borrowing'
        ? `Instruments grouped from the ${AUTO ? 'borrowing notes of each annual report' : 'company sheets'}: Secured NCDs = public issue + private placement; Bank term loans exclude cash credit/WCDL (shown separately); Deposits = public, corporate and inter-corporate deposits. "(not split)" = a note whose breakdown could not be read, shown at its balance-sheet total. `
        : `Instruments grouped from the ${AUTO ? 'investments note of each annual report' : 'company sheets'}: Subsidiaries, associates & JVs = strategic holdings; Other = InvITs, security receipts, VCF and similar. `)
        + `Shares are of each company's own total. Source: ${AUTO ? 'annual reports (standalone)' : T.source}.` })));
    requestAnimationFrame(() => groupedBars(chart, { categories: cats, series, fmt, axisFmt, avg: peers.length ? avg : null, labelSeries: bs }));
  }

  function renderKpi() {
    const years = T.years;
    const mk = (get) => companies.map(c => ({ name: c.short, color: c.color, values: Object.fromEntries(years.map(y => [y, get(c, y)])) }));
    const costSeries = mk((c, y) => c.borrowing.avg_cost[y] ?? null);
    const totSeries = mk((c, y) => c.borrowing.total[y] ?? null);
    const fcSeries = mk((c, y) => c.borrowing.finance_cost[y] ?? null);
    const invSeries = mk((c, y) => c.investments ? (c.investments.total[y] ?? null) : null);
    const latest = c => { if (c.borrowing.avg_cost[T.default_year] != null) return T.default_year; const ys = c.borrowing.years.filter(y => c.borrowing.avg_cost[y] != null); return ys[ys.length - 1]; };

    view.append(h('div', { class: 'tpb-tiles' }, companies.map(c => {
      const y = latest(c); const pv = prevYear(c.borrowing.years, y);
      const v = c.borrowing.avg_cost[y], p = c.borrowing.avg_cost[pv];
      return tile(`${c.short} · borrowing cost ${y || ''}`, pct(v, 2), p != null ? [h('b', { text: bps(v - p) }), ` vs ${pv}`] : null);
    })));

    const lg = legend(companies.map(c => ({ color: c.color, label: c.short, kind: 'line' })));
    const charts = [
      ['Average borrowing cost', AUTO ? 'Finance cost ÷ average of opening and closing borrowings.' : 'Finance cost ÷ average borrowings, as calculated in each sheet.', costSeries, v => pct(v, 2), v => +(v * 100).toFixed(1) + '%', false],
      ['Total borrowings', 'Outstanding borrowings at year end, ₹ crore.', totSeries, cr, crAxis, true],
      ['Finance cost', 'Interest and finance cost for the year, ₹ crore.', fcSeries, cr, crAxis, true],
      ['Investment book', 'Total (gross) investments at year end, ₹ crore.', invSeries, cr, crAxis, true],
    ];
    const grid2 = h('div', { class: 'tpb-grid2 tpb-wide' });
    charts.forEach(([title, sub, series, fmt, axisFmt, zero]) => {
      const holder = h('div', { class: 'tpb-chart' });
      grid2.append(card(title, sub, lg.cloneNode(true), holder,
        table([{ label: 'Company', get: r => r.name }, ...years.map(y => ({ label: y, num: 1, get: r => fmt(r.values[y]) }))], series)));
      requestAnimationFrame(() => lineChart(holder, { years, series, fmt, axisFmt, minZero: zero }));
    });
    view.append(grid2);
    view.append(h('div', { class: 'foot', style: 'font-size:11.5px;color:#898781', text:
      AUTO ? 'CRAR, Tier I / Tier II capital and LCR (BRD KPIs) are not extracted yet.' : 'BRD KPIs not yet in the Excel: CRAR, Tier I / Tier II capital, LCR and other regulatory ratios.' }));
  }

  function renderCompany(tab) {
    const c = tab.company, b = c.borrowing, inv = c.investments;
    const years = b.years;
    const year = years.includes(state.companyYear[c.name]) ? state.companyYear[c.name] : (years.includes(T.default_year) ? T.default_year : years[years.length - 1]);
    const pv = prevYear(years, year);
    view.append(filters(...yearSelect(years, year, v => { state.companyYear[c.name] = v; render(); })));

    const shares = b.mix.shares;
    const topCat = b.mix.categories.slice().sort((a, z) => (shares[z][year] || 0) - (shares[a][year] || 0))[0];
    const cost = b.avg_cost[year], pcost = b.avg_cost[pv];
    view.append(h('div', { class: 'tpb-tiles' },
      tile(`Total borrowings, ${year}`, cr(b.total[year]), b.total[pv] ? [h('b', { text: growth(b.total[year], b.total[pv]) }), ` vs ${pv}`] : null),
      tile(`Average borrowing cost, ${year}`, pct(cost, 2), pcost != null && cost != null ? [h('b', { text: bps(cost - pcost) }), ` vs ${pv}`] : null),
      topCat ? tile(`Largest funding source, ${year}`, topCat, `${pct(shares[topCat][year])} of borrowings`) : null,
      inv ? tile(`Investment book, ${year}`, cr(inv.total[year]), inv.total[pv] ? [h('b', { text: growth(inv.total[year], inv.total[pv]) }), ` vs ${pv}`] : null) : null));

    const grid2 = h('div', { class: 'tpb-grid2' });
    const one = (part, label) => {
      const p = partOf(c, part); if (!p || !p.years.includes(year)) return;
      const cats = p.mix.categories.filter(cat => (p.mix.shares[cat][year] || 0) >= 0.0005);
      const holder = h('div', { class: 'tpb-chart' });
      grid2.append(card(`${label}, ${year}`, `Share of total ${part === 'borrowing' ? 'borrowings' : 'investments'} by instrument.`, holder,
        table([{ label: 'Instrument', get: r => r }, { label: 'Share', num: 1, get: r => pct(p.mix.shares[r][year]) }, { label: '₹ crore', num: 1, get: r => cr(p.mix.amounts[r][year]) }], cats)));
      const only = { name: c.short, color: c.color, values: Object.fromEntries(cats.map(cat => [cat, p.mix.shares[cat][year]])) };
      requestAnimationFrame(() => groupedBars(holder, { categories: cats, series: [only], fmt: pct, axisFmt: v => Math.round(v * 100) + '%', labelSeries: only }));
    };
    one('borrowing', 'Borrowing mix'); one('investments', 'Investment mix');
    view.append(grid2);

    if (c.readouts && c.readouts.length) {
      view.append(card('Key readouts', AUTO ? `Drafted from ${c.short}'s figures${CAN_EDIT ? '; Treasury can edit them' : ''}.` : `From the ${c.sheet} sheet.`,
        h('ul', { class: 'tpb-obs' }, c.readouts.map(r => h('li', {}, h('b', { text: r.area }), edited(r), h('div', { text: r.text })))),
        editButton()));
    }
    if (c.sources && Object.keys(c.sources).length) {
      const PG = { debt_securities: 'Debt securities', borrowings: 'Borrowings', deposits: 'Deposits', subordinated: 'Subordinated', investments: 'Investments', finance_cost: 'Finance costs' };
      const ys = Object.keys(c.sources).sort((a, b) => +a.slice(2) - +b.slice(2));
      const rows = ys.map(y => Object.assign({ fy: y }, c.sources[y]));
      const tbl = h('div', { class: 'tpb-table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Year', 'Annual report', 'Column used', 'Pages (standalone statements)', 'Unit'].map(t => h('th', { text: t })))),
        h('tbody', {}, rows.map(r => h('tr', {},
          h('td', { text: r.fy }),
          h('td', {}, r.url && /^https?:/.test(r.url) ? h('a', { href: r.url, target: '_blank', rel: 'noopener', text: `${r.report} report (${r.via})` }) : `${r.report} report (${r.via})`),
          h('td', { text: r.column }),
          h('td', { text: Object.entries(r.pages || {}).map(([k, p]) => `${PG[k] || k} p.${p}`).join(' · ') }),
          h('td', { text: r.unit || '' }))))));
      view.append(card('Sources', 'Every figure on this page comes from the standalone financial statements in these annual reports.', tbl,
        (c.warnings || []).length ? h('ul', { class: 'tpb-obs' }, c.warnings.map(w => h('li', { text: w }))) : null));
    }
    const detail = (p, title) => {
      if (!p) return null;
      const rows = p.rows.map(r => Object.assign({}, r));
      rows.push({ label: 'Total', values: p.total, _class: 'tot' });
      return card(title, AUTO ? '₹ crore, line items as reported in the annual-report notes.' : `₹ crore, as reported in the ${c.sheet} sheet.`,
        table([{ label: 'Instrument', get: r => r.label }, { label: 'Group', get: r => r.category || '' },
               ...p.years.map(y => ({ label: y, num: 1, get: r => r.values[y] == null ? '—' : Math.round(r.values[y]).toLocaleString('en-IN') }))],
              rows, { summary: 'Show detailed table' }));
    };
    view.append(detail(b, 'Detailed borrowings') || '', detail(inv, 'Detailed investments') || '');
  }

  function renderEmpty() {
    view.append(card('No benchmark data yet', '',
      h('div', { class: 'tpb-empty', text: 'The annual reports have not been collected yet. In GitHub, open Actions → "Treasury Peer Benchmarking" → Run workflow. The dashboards appear here once it finishes.' })));
  }

  // Edit commentary (Treasury users): opens the portal's edit screen
  function editButton() {
    if (!CAN_EDIT) return null;
    return h('button', { type: 'button', class: 'tpb-edit', onclick: () => {
      try { const b = window.parent.document.querySelector('.st-key-tpbedit button'); if (b) b.click(); } catch (e) {}
    }, text: '✎ Edit commentary' });
  }
  const edited = r => !r ? null
    : r.edited ? h('span', { class: 'chip', title: `Edited by ${r.edited.by} on ${String(r.edited.at || '').slice(0, 10)}`, text: 'edited' })
    : r.ai ? h('span', { class: 'chip tpb-ai', title: 'Drafted by AI from the extracted figures', text: 'AI draft' }) : null;

  function renderInsights() {
    studies.forEach(st => {
      view.append(card(st.title, st.questions.length ? 'Questions covered: ' + st.questions.join(' · ') : '',
        table(st.columns.map((col, i) => ({ label: col, get: r => r[i] || '' })), st.rows, { open: true })));
    });
  }

  function prevYear(years, y) { const i = years.indexOf(y); return i > 0 ? years[i - 1] : null; }
  function growth(a, b) { if (a == null || !b) return ''; const g = a / b - 1; return (g >= 0 ? '+' : '−') + Math.abs(g * 100).toFixed(1) + '%'; }
})();
