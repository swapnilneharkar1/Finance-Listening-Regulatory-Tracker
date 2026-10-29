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
  const base = companies.find(c => c.base) || companies.find(c => /bajaj/i.test(c.name));
  const NO_BASE = companies.length > 0 && !base;   // peers collected, Bajaj Finance not read yet
  const peers = companies.filter(c => c !== base);
  const studies = T.studies || [];

  const TABS = (!companies.length || NO_BASE) ? [{ label: 'Overview', kind: 'empty' }] : [
    { label: 'Overview', kind: 'overview' },
    { label: 'Borrowing Mix', kind: 'mix', part: 'borrowing' },
    { label: 'Investment Mix', kind: 'mix', part: 'investments' },
    { label: 'Cost & KPIs', kind: 'kpi' },
    ...(peers.length ? [{ label: `${base.short} vs Peers`, kind: 'compare' }] : []),
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
      ({ overview: renderOverview, mix: renderMix, kpi: renderKpi, compare: renderCompare, company: renderCompany, insights: renderInsights, empty: renderEmpty })[tab.kind](tab);
    } catch (e) {
      console.error(e);
      view.replaceChildren(h('div', { class: 'tpb-empty', text: 'Could not draw this dashboard: ' + e.message }));
    }
  }


  // ── Design pieces: hero band, sparkline, funding-mix stack, league table ──
  const MIX_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'];
  const OTHER_COLOR = '#b4b2a9';
  const inkOn = c => (c === '#eda100' ? '#0b0b0b' : '#ffffff');
  const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th');
  // rank of `who` among companies with a value (1 = highest, or lowest when asc)
  function rankOf(who, get, asc) {
    const vals = companies.map(c => ({ c, v: get(c) })).filter(x => x.v != null && !isNaN(x.v));
    vals.sort((a, b) => asc ? a.v - b.v : b.v - a.v);
    const i = vals.findIndex(x => x.c === who);
    return i < 0 ? null : { n: i + 1, of: vals.length };
  }
  function sparkline(values, { w = 128, hgt = 34, color = '#ffffff', fmt = v => v } = {}) {
    const pts = values.filter(p => p.v != null && !isNaN(p.v));
    if (pts.length < 2) return null;
    const vs = pts.map(p => p.v), lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || Math.abs(hi) || 1;
    const x = i => 4 + i * (w - 8) / (pts.length - 1), y = v => hgt - 5 - (v - lo) / span * (hgt - 10);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
    const svg = s('svg', { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, class: 'tpb-spark', role: 'img',
      'aria-label': pts.map(p => `${p.y} ${fmt(p.v)}`).join(', ') },
      s('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', opacity: 0.95 }),
      s('circle', { cx: x(pts.length - 1), cy: y(pts[pts.length - 1].v), r: 3.5, fill: color }));
    svg.append(s('title', {}, pts.map(p => `${p.y}: ${fmt(p.v)}`).join('  ·  ')));
    return svg;
  }
  const series = (obj, years) => (years || Object.keys(obj || {}).sort((a, b) => +a.slice(2) - +b.slice(2))).map(y => ({ y, v: (obj || {})[y] }));

  function heroKpi(label, value, sub, rank, spark) {
    return h('div', { class: 'tpb-hk' },
      h('div', { class: 'tpb-hk-top' }, h('span', { class: 'k', text: label }), rank ? h('span', { class: 'tpb-rank', text: rank }) : null),
      h('div', { class: 'v' + (/^[₹+−\-\d]/.test(String(value)) ? '' : ' txt'), text: value }),
      h('div', { class: 'tpb-hk-bot' }, h('span', { class: 'd' }, ...(Array.isArray(sub) ? sub : [sub || ''])), spark));
  }
  function hero(title, meta, kpis, accent, actions) {
    return h('section', { class: 'tpb-hero', style: accent ? `--tpb-accent:${accent}` : null },
      h('div', { class: 'tpb-hero-head' },
        h('div', {}, h('div', { class: 'tpb-eyebrow', text: 'Treasury Peer Benchmarking' }), h('h2', { text: title }), h('div', { class: 'tpb-hero-meta', text: meta })),
        actions || null),
      h('div', { class: 'tpb-hero-kpis' }, kpis.filter(Boolean)));
  }

  // 100% stacked bars: one row per company (or per year), segments = instruments
  function mixStack(holder, part, year) {
    return stackRows(holder, companies.map(c => {
      const p = partOf(c, part);
      return { label: c.short, bold: c === base, title: `${c.name} · ${year}`, m: mixValues(c, part, year, 'share'),
        amount: k => p && p.mix.amounts[k] && p.mix.amounts[k][year], missing: `not available for ${year}` };
    }), part);
  }
  function stackRows(holder, rowsC, part) {
    const totals = {};
    rowsC.forEach(({ m }) => m && Object.entries(m).forEach(([k, v]) => { totals[k] = (totals[k] || 0) + (v || 0); }));
    const cats = Object.keys(totals).filter(k => totals[k] > 0).sort((a, b) => totals[b] - totals[a]);
    const top = cats.slice(0, cats.length > 8 ? 7 : 8), rest = cats.filter(k => !top.includes(k));
    const keys = rest.length ? [...top, 'Other'] : top;
    const color = k => k === 'Other' ? OTHER_COLOR : MIX_COLORS[top.indexOf(k)] || OTHER_COLOR;
    const W = width(holder), labelW = Math.min(150, W * 0.24), barH = 26, gap = 14, padT = 4;
    const H = padT + rowsC.length * (barH + gap);
    const svg = s('svg', { width: W, height: H, role: 'img', 'aria-label': `${part === 'borrowing' ? 'Borrowing' : 'Investment'} mix` });
    rowsC.forEach((row, i) => {
      const { m } = row, y = padT + i * (barH + gap);
      svg.append(s('text', { x: labelW - 12, y: y + barH / 2 + 4, 'text-anchor': 'end', 'font-size': 12.5, 'font-weight': row.bold ? 700 : 500, fill: '#1a2030' }, row.label));
      if (!m) { svg.append(s('text', { x: labelW, y: y + barH / 2 + 4, 'font-size': 12, fill: '#898781' }, row.missing || 'not available')); return; }
      const vals = keys.map(k => ({ k, v: k === 'Other' ? rest.reduce((a, r) => a + (m[r] || 0), 0) : (m[k] || 0) })).filter(x => x.v > 0.0005);
      const sum = vals.reduce((a, x) => a + x.v, 0) || 1, avail = W - labelW - 4 - (vals.length - 1) * 2;
      let x = labelW;
      vals.forEach((seg, j) => {
        const w = Math.max(1, seg.v / sum * avail), first = j === 0, last = j === vals.length - 1, r = 5;
        const g = s('g', {});
        const path = first && last ? `M${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + barH - r}Q${x + w},${y + barH} ${x + w - r},${y + barH}H${x + r}Q${x},${y + barH} ${x},${y + barH - r}V${y + r}Q${x},${y} ${x + r},${y}Z`
          : first ? `M${x + r},${y}H${x + w}V${y + barH}H${x + r}Q${x},${y + barH} ${x},${y + barH - r}V${y + r}Q${x},${y} ${x + r},${y}Z`
          : last ? `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + barH - r}Q${x + w},${y + barH} ${x + w - r},${y + barH}H${x}Z`
          : `M${x},${y}H${x + w}V${y + barH}H${x}Z`;
        g.append(s('path', { d: path, fill: color(seg.k), class: 'bar' }));
        if (w > 40) g.append(s('text', { x: x + w / 2, y: y + barH / 2 + 4, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 600, fill: inkOn(color(seg.k)), 'pointer-events': 'none' }, (seg.v / sum * 100).toFixed(0) + '%'));
        const hit = s('rect', { x, y: y - 3, width: w + 2, height: barH + 6, class: 'hit' });
        const amount = row.amount ? (seg.k === 'Other' ? rest.reduce((a, r) => a + (row.amount(r) || 0), 0) : row.amount(seg.k)) : null;
        hit.addEventListener('mousemove', e => { g.classList.add('hl'); showTip(e, row.title || row.label, [{ color: color(seg.k), value: pct(seg.v / sum), label: seg.k + (seg.k === 'Other' ? ` (${rest.join(', ')})` : '') }, ...(amount ? [{ value: cr(amount), label: 'amount' }] : [])]); });
        hit.addEventListener('mouseleave', () => { g.classList.remove('hl'); hideTip(); });
        g.append(hit); svg.append(g);
        x += w + 2;
      });
    });
    holder.replaceChildren(svg);
    return keys.map(k => ({ color: color(k), label: k }));
  }

  // Columns over the years (single series), value on each column, growth below the axis
  function columnChart(holder, { years, values, color, fmt, axisFmt }) {
    const pts = years.map(y => ({ y, v: values[y] })).filter(p => p.v != null);
    if (!pts.length) { holder.replaceChildren(h('div', { class: 'tpb-empty', text: 'No data.' })); return; }
    const W = width(holder), Hh = 230, L = 48, R = 10, Tp = 22, B = 40;
    const max = niceMax(Math.max(...pts.map(p => p.v)) * 1.08), bw = Math.min(56, (W - L - R) / pts.length * 0.56);
    const xs = i => L + (W - L - R) * (i + 0.5) / pts.length, y = v => Tp + (Hh - Tp - B) * (1 - v / max);
    const svg = s('svg', { width: W, height: Hh, role: 'img', 'aria-label': pts.map(p => `${p.y} ${fmt(p.v)}`).join(', ') });
    ticks(max).forEach(t => {
      svg.append(s('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), stroke: t ? '#eef0f3' : '#c3c2b7' }));
      svg.append(s('text', { x: L - 8, y: y(t) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#898781' }, axisFmt(t)));
    });
    pts.forEach((p, i) => {
      const x0 = xs(i) - bw / 2, y0 = y(p.v), base0 = y(0), r = Math.min(5, bw / 2, base0 - y0), g = s('g', {});
      g.append(s('path', { d: `M${x0},${base0}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + bw - r}Q${x0 + bw},${y0} ${x0 + bw},${y0 + r}V${base0}Z`, fill: color, class: 'bar' }));
      g.append(s('text', { x: xs(i), y: y0 - 7, 'text-anchor': 'middle', 'font-size': 11.5, 'font-weight': 600, fill: '#1a2030' }, axisFmt(p.v)));
      g.append(s('text', { x: xs(i), y: Hh - B + 16, 'text-anchor': 'middle', 'font-size': 11.5, fill: '#52514e' }, p.y));
      const prev = pts[i - 1], gr = prev ? p.v / prev.v - 1 : null;
      if (gr != null) g.append(s('text', { x: xs(i), y: Hh - B + 31, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 600, fill: gr >= 0 ? '#006300' : '#b42318' }, (gr >= 0 ? '+' : '−') + Math.abs(gr * 100).toFixed(1) + '%'));
      const hit = s('rect', { x: xs(i) - (W - L - R) / pts.length / 2, y: Tp - 10, width: (W - L - R) / pts.length, height: Hh - Tp - B + 10, class: 'hit' });
      hit.addEventListener('mousemove', e => { g.classList.add('hl'); showTip(e, p.y, [{ color, value: fmt(p.v), label: 'total borrowings' }, ...(gr != null ? [{ value: (gr >= 0 ? '+' : '−') + Math.abs(gr * 100).toFixed(1) + '%', label: `vs ${prev.y}` }] : [])]); });
      hit.addEventListener('mouseleave', () => { g.classList.remove('hl'); hideTip(); });
      g.append(hit); svg.append(g);
    });
    holder.replaceChildren(svg);
  }

  // Scorecard: the CFO table — value, prior year, change, peer average, rank, trend
  function scorecard(c, year) {
    const others = companies.filter(x => x !== c), b = c.borrowing, inv = c.investments;
    const prevOf = y => 'FY' + String(+y.slice(2) - 1).padStart(2, '0'), py = prevOf(year);
    const growthOf = (x, y) => { const t = x.borrowing.total; return t[y] != null && t[prevOf(y)] ? t[y] / t[prevOf(y)] - 1 : null; };
    const top3Of = (x, y) => { const m = mixValues(x, 'borrowing', y, 'share'); return m ? Object.values(m).sort((a, z) => z - a).slice(0, 3).reduce((a, v) => a + (v || 0), 0) : null; };
    const metrics = [
      { name: 'Total borrowings', get: (x, y) => x.borrowing.total[y], fmt: cr, delta: (a, z) => growth(a, z), asc: false },
      { name: 'Borrowing growth (YoY)', get: growthOf, fmt: v => (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + '%', delta: (a, z) => pp(a - z), asc: false },
      { name: 'Average borrowing cost', get: (x, y) => x.borrowing.avg_cost && x.borrowing.avg_cost[y], fmt: v => pct(v, 2), delta: (a, z) => bps(a - z), asc: true, better: 'low' },
      { name: 'Finance cost', get: (x, y) => x.borrowing.finance_cost && x.borrowing.finance_cost[y], fmt: cr, delta: (a, z) => growth(a, z), asc: false },
      { name: 'Investment book', get: (x, y) => x.investments && x.investments.total[y], fmt: cr, delta: (a, z) => growth(a, z), asc: false },
      { name: 'Top-3 funding concentration', get: top3Of, fmt: v => pct(v), delta: (a, z) => pp(a - z), asc: true, better: 'low' },
    ];
    const rows = metrics.map(mt => {
      const v = mt.get(c, year), p = mt.get(c, py);
      const ov = others.map(x => mt.get(x, year)).filter(x => x != null && !isNaN(x));
      const avg = ov.length ? ov.reduce((a, z) => a + z, 0) / ov.length : null;
      const rk = rankOf(c, x => mt.get(x, year), mt.asc);
      const trend = sparkline((b.years || []).map(y => ({ y, v: mt.get(c, y) })), { w: 96, hgt: 26, color: '#0f2d52', fmt: mt.fmt });
      return { mt, v, p, avg, rk, trend };
    }).filter(r => r.v != null && !isNaN(r.v));
    return h('div', { class: 'tpb-table-wrap' }, h('table', { class: 'tpb-score' },
      h('thead', {}, h('tr', {}, ['Metric', year, py, 'Change', `Peer avg (${others.length})`, 'Rank', 'Trend'].map((t, i) => h('th', { class: i && i < 6 ? 'n' : '', text: t })))),
      h('tbody', {}, rows.map(r => {
        const vsAvg = r.avg != null ? r.v - r.avg : null, good = vsAvg == null || !r.mt.better ? null : (r.mt.better === 'low' ? vsAvg <= 0 : vsAvg >= 0); // only where lower/higher is clearly better
        return h('tr', {},
          h('td', {}, h('b', { text: r.mt.name })),
          h('td', { class: 'n tpb-score-v', text: r.mt.fmt(r.v) }),
          h('td', { class: 'n', text: r.p != null && !isNaN(r.p) ? r.mt.fmt(r.p) : '—' }),
          h('td', { class: 'n', text: r.p != null && !isNaN(r.p) ? r.mt.delta(r.v, r.p) : '—' }),
          h('td', { class: 'n' }, r.avg != null ? r.mt.fmt(r.avg) : '—', good != null ? h('span', { class: 'tpb-flag ' + (good ? 'good' : 'bad'), title: good ? 'better than peer average' : 'worse than peer average', text: good ? '▲ better' : '▼ worse' }) : null),
          h('td', { class: 'n' }, r.rk ? h('span', { class: 'tpb-rankpill' + (r.rk.n === 1 ? ' first' : ''), text: `${r.rk.n} / ${r.rk.of}` }) : '—'),
          h('td', {}, r.trend || ''));
      }))));
  }
  function othersAvgMix(c, part, year, cats) {
    const out = {};
    const ms = companies.filter(x => x !== c).map(x => mixValues(x, part, year, 'share')).filter(Boolean);
    cats.forEach(k => { out[k] = ms.length ? ms.reduce((a, m) => a + (m[k] || 0), 0) / ms.length : null; });
    return out;
  }

  // League table: size, growth, cost and investment book of every NBFC, bars inline
  function leagueTable(year) {
    const prev = y => 'FY' + String(+y.slice(2) - 1).padStart(2, '0');
    const rows = companies.map(c => {
      const b = c.borrowing, tot = b.total[year], pv = b.total[prev(year)];
      return { c, tot, growth: tot != null && pv ? tot / pv - 1 : null, cost: b.avg_cost && b.avg_cost[year], inv: c.investments && c.investments.total[year] };
    }).sort((a, b) => (b.tot || 0) - (a.tot || 0));
    const maxTot = Math.max(...rows.map(r => r.tot || 0)) || 1, costs = rows.map(r => r.cost).filter(v => v != null);
    const maxCost = Math.max(...costs, 0) || 1, baseCost = rows.find(r => r.c === base)?.cost;
    const bar = (v, max, color) => v == null ? h('span', { class: 'tpb-na', text: '—' }) : h('div', { class: 'tpb-inbar' }, h('i', { style: `width:${Math.max(2, v / max * 100)}%;background:${color}` }));
    const head = ['NBFC', `Total borrowings, ${year}`, 'Growth YoY', `Avg borrowing cost, ${year}`, `vs ${base.short}`, `Investment book, ${year}`];
    return h('div', { class: 'tpb-table-wrap' }, h('table', { class: 'tpb-league' },
      h('thead', {}, h('tr', {}, head.map((t, i) => h('th', { class: i ? 'n' : '', text: t })))),
      h('tbody', {}, rows.map(r => h('tr', { class: r.c === base ? 'is-base' : '' },
        h('td', {}, h('span', { class: 'tpb-dot', style: `background:${r.c.color}` }), h('b', { text: r.c.short }), r.c === base ? h('span', { class: 'tpb-basetag', text: 'base' }) : null),
        h('td', { class: 'n' }, h('div', { class: 'tpb-cellbar' }, bar(r.tot, maxTot, r.c === base ? '#0f2d52' : '#9ec5f4'), h('span', { text: r.tot != null ? cr(r.tot) : '' }))),
        h('td', { class: 'n ' + (r.growth == null ? '' : r.growth >= 0 ? 'pos' : 'neg'), text: r.growth == null ? '—' : (r.growth >= 0 ? '+' : '−') + Math.abs(r.growth * 100).toFixed(1) + '%' }),
        h('td', { class: 'n' }, h('div', { class: 'tpb-cellbar' }, bar(r.cost, maxCost, r.c === base ? '#0f2d52' : '#9ec5f4'), h('span', { text: pct(r.cost, 2) }))),
        h('td', { class: 'n', text: r.c === base || r.cost == null || baseCost == null ? '—' : bps(r.cost - baseCost) }),
        h('td', { class: 'n', text: r.inv != null ? cr(r.inv) : '—' }))))));
  }

  // Sequential blue ramp (light -> dark) for the heatmap cells
  const BLUES = ['#eef4fc', '#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab'];
  function heatTable(part, year, cats) {
    const vals = companies.map(c => ({ c, m: mixValues(c, part, year, 'share') }));
    const max = Math.max(0.0001, ...vals.flatMap(({ m }) => m ? cats.map(k => m[k] || 0) : []));
    const avg = peerAvg(cats, part, year, 'share');
    const cell = v => {
      if (v == null) return h('td', { class: 'n tpb-heat', text: '—' });
      const i = Math.min(BLUES.length - 1, Math.round(Math.sqrt(v / max) * (BLUES.length - 1)));
      return h('td', { class: 'n tpb-heat', style: `background:${v > 0.0005 ? BLUES[i] : '#fafbfc'};color:${i >= 7 ? '#fff' : '#1a2030'}`, text: v > 0.0005 ? pct(v) : '–' });
    };
    return h('div', { class: 'tpb-table-wrap' }, h('table', { class: 'tpb-heatmap' },
      h('thead', {}, h('tr', {}, h('th', { text: 'Instrument' }), ...vals.map(({ c }) => h('th', { class: 'n' + (c === base ? ' is-base' : ''), text: c.short })), h('th', { class: 'n', text: 'Peer avg' }))),
      h('tbody', {}, cats.filter(k => vals.some(({ m }) => m && (m[k] || 0) > 0.0005)).map(k => h('tr', {}, h('td', { text: k }),
        ...vals.map(({ c, m }) => { const td = cell(m ? (m[k] || 0) : null); if (c === base) td.classList.add('is-base'); return td; }),
        h('td', { class: 'n tpb-heat-avg', text: avg[k] != null ? pct(avg[k]) : '—' }))))));
  }

  // Ranked horizontal bars: one value per company, base company highlighted, optional average line
  // dots: true -> dot plot on a zoomed scale (small differences such as borrowing cost stay visible)
  function rankBars(holder, rows, { fmt, avg, avgLabel, asc = true, dots = false, tickFmt }) {
    rows = rows.filter(r => r.v != null && !isNaN(r.v)).sort((a, b) => asc ? a.v - b.v : b.v - a.v);
    if (!rows.length) { holder.replaceChildren(h('div', { class: 'tpb-empty', text: 'No data for this year.' })); return; }
    const W = width(holder), labelW = Math.min(150, W * 0.26), valW = 96, barH = 22, gap = 12, padT = 22, axisH = 20;
    const vs = rows.map(r => r.v).concat(avg != null ? [avg] : []);
    let lo = 0, hi = niceMax(Math.max(...vs) * 1.04);
    if (dots) { const span = Math.max(...vs) - Math.min(...vs) || Math.abs(vs[0]) * 0.1 || 1, st = niceStep(span * 1.6, 4);
      lo = Math.floor((Math.min(...vs) - span * 0.3) / st) * st; hi = Math.ceil((Math.max(...vs) + span * 0.3) / st) * st; }
    const plotW = W - labelW - valW - 12, x = v => labelW + (v - lo) / (hi - lo) * plotW;
    const H = padT + rows.length * (barH + gap) + axisH;
    const svg = s('svg', { width: W, height: H, role: 'img', 'aria-label': rows.map(r => `${r.c.short} ${fmt(r.v)}`).join(', ') });
    const st = niceStep(hi - lo, 4), tks = []; for (let t = lo; t <= hi + st / 2; t += st) tks.push(+t.toFixed(10));
    tks.forEach(t => {
      svg.append(s('line', { x1: x(t), x2: x(t), y1: padT - 6, y2: H - axisH, stroke: '#eef0f3' }));
      svg.append(s('text', { x: x(t), y: H - 6, 'text-anchor': 'middle', 'font-size': 11, fill: '#898781' }, (tickFmt || fmt)(t)));
    });
    rows.forEach((r, i) => {
      const y = padT + i * (barH + gap), cy = y + barH / 2, isBase = r.c === base, col = isBase ? '#0f2d52' : '#86b6ef', g = s('g', {});
      g.append(s('text', { x: labelW - 12, y: cy + 4, 'text-anchor': 'end', 'font-size': 12.5, 'font-weight': isBase ? 700 : 500, fill: '#1a2030' }, `${i + 1}. ${r.c.short}`));
      if (dots) {
        g.append(s('line', { x1: labelW, x2: x(r.v), y1: cy, y2: cy, stroke: isBase ? '#0f2d52' : '#cde2fb', 'stroke-width': 2 }));
        g.append(s('circle', { cx: x(r.v), cy, r: 7, fill: col, stroke: '#fff', 'stroke-width': 2, class: 'bar' }));
      } else {
        g.append(s('path', { d: hbarPath(labelW, x(r.v), y, barH, 5), fill: col, class: 'bar' }));
      }
      g.append(s('text', { x: W - 4, y: cy + 4, 'text-anchor': 'end', 'font-size': 12.5, 'font-weight': isBase ? 700 : 600, fill: '#1a2030', 'font-variant-numeric': 'tabular-nums' }, fmt(r.v)));
      const hit = s('rect', { x: 0, y: y - gap / 2, width: W, height: barH + gap, class: 'hit' });
      hit.addEventListener('mousemove', e => { g.classList.add('hl'); showTip(e, r.c.name, [{ color: col, value: fmt(r.v), label: r.label || '' }, ...(avg != null ? [{ color: '#52514e', value: fmt(avg), label: avgLabel }] : [])]); });
      hit.addEventListener('mouseleave', () => { g.classList.remove('hl'); hideTip(); });
      g.append(hit); svg.append(g);
    });
    if (avg != null) {
      svg.append(s('line', { x1: x(avg), x2: x(avg), y1: padT - 8, y2: H - axisH, stroke: '#52514e', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }));
      svg.append(s('text', { x: x(avg), y: padT - 11, 'text-anchor': 'middle', 'font-size': 11, fill: '#52514e', 'font-weight': 600 }, `${avgLabel} ${fmt(avg)}`));
    }
    holder.replaceChildren(svg);
  }
  const heroControls = (...kids) => h('div', { class: 'tpb-hero-pick' }, ...kids);

  // ── AI summaries ("how it was generated") and methodology panels ──
  const SECTIONS = T.ai_sections || {};
  const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
  function aiCard(key, title, ruleText, scope) {
    const x = SECTIONS[key];
    const text = x ? x.text : ruleText;
    if (!text) return null;
    const chip = x && x.edited ? h('span', { class: 'chip', text: `edited by ${x.edited.by}` })
      : x ? h('span', { class: 'chip tpb-ai', text: 'AI summary' }) : h('span', { class: 'chip', text: 'Rule-based draft' });
    const how = h('details', { class: 'tpb-how-inline' }, h('summary', { text: 'How this summary was generated' }),
      h('ul', { class: 'tpb-how-list' },
        x ? [h('li', { text: `Written by Azure OpenAI (${x.model || 'model'}) on ${fmtDate(x.at)}, on the Treasury VM, from the figures in ${scope || 'this dashboard'} only.` }),
             h('li', { text: 'Every number in the text is checked against those figures; if the AI quotes a number that is not in the data, the text is rejected and the rule-based draft is shown instead.' }),
             h('li', { text: 'It is redrafted automatically when the figures change (a new annual report), and hidden until then if it no longer matches.' }),
             x.edited ? h('li', { text: `Edited by ${x.edited.by} on ${fmtDate(x.edited.at)}; the edit replaces the AI text.` }) : null]
          : [h('li', { text: 'Built by fixed rules from the figures on this page (largest values, gaps to the peer average, ranks).' }),
             h('li', { text: 'An AI-written version replaces it after the next run of the Treasury AI commentary on the VM.' })],
        CAN_EDIT ? h('li', { text: 'Treasury users can rewrite it with "Edit commentary".' }) : null));
    return h('div', { class: 'tpb-card tpb-aicard' },
      h('div', { class: 'tpb-aicard-head' }, h('span', { class: 'tpb-ai-ico', text: '✦' }), h('h3', { text: title }), chip, h('span', { style: 'flex:1' }), editButton()),
      h('div', { class: 'tpb-summary' }, String(text).split(/\n+/).map(p => h('p', { text: p }))), how);
  }
  const HOW = {
    common: [
      'Source: each NBFC\'s published annual report (standalone financial statements), downloaded automatically from NSE, the company website or BSE every Monday.',
      'Figures are read from the standalone balance sheet and the notes to it; each breakdown must add up to its balance-sheet line (±1.5%), otherwise only the balance-sheet total is used and marked "(not split)".',
      'All amounts are converted to ₹ crore. Each year uses that year\'s own report; if it is missing, the previous-year column of the next report is used.',
      `Peer average = simple (unweighted) average of the peers, excluding ${base ? base.short : 'the base company'}.`,
    ],
    mix: ['Share = instrument ÷ the company\'s total borrowings (or investments) at year end.',
      'Instrument groups: Secured NCDs = public issue + private placement; Bank term loans exclude cash credit / WCDL; Deposits = public, corporate and inter-corporate deposits; Subordinated debt includes perpetual debt.',
      'Top-3 concentration = combined share of the three largest instruments (lower = more diversified).'],
    cost: ['Average borrowing cost = finance cost for the year ÷ average of opening and closing total borrowings.',
      'Total borrowings = debt securities + borrowings (other than debt securities) + deposits + subordinated liabilities.',
      'Ranks: 1 = lowest cost / largest book.'],
    compare: ['Size ratio = BFL\'s total borrowings ÷ the peer\'s. Cost gap = BFL\'s average borrowing cost minus the peer\'s, in basis points (negative = BFL cheaper).',
      'Mix differences are BFL\'s share minus the peer\'s share of the same instrument, in percentage points.'],
  };
  function howCard(...kinds) {
    const items = [...HOW.common, ...kinds.flatMap(k => HOW[k] || [])];
    return h('details', { class: 'tpb-card tpb-how' }, h('summary', { text: 'How these figures are calculated' }),
      h('ul', { class: 'tpb-how-list' }, items.map(t => h('li', { text: t }))),
      h('div', { class: 'foot', text: 'Sources and page numbers for every figure are on each NBFC\'s tab.' }));
  }

  // ── Rule-based drafts (shown until the AI version exists) ──
  const fyBefore = y => 'FY' + String(+y.slice(2) - 1).padStart(2, '0');
  const top3of = m => m ? Object.values(m).sort((a, b) => b - a).slice(0, 3).reduce((a, v) => a + (v || 0), 0) : null;
  function ruleMix(part, year) {
    const bm = mixValues(base, part, year, 'share'); if (!bm) return '';
    const cats = Object.keys(bm), avg = peerAvg(cats, part, year, 'share'), what = part === 'borrowing' ? 'borrowings' : 'investments';
    const top = cats.slice().sort((a, b) => bm[b] - bm[a]).slice(0, 3);
    const gaps = cats.filter(k => avg[k] != null).map(k => ({ k, g: bm[k] - avg[k] })).sort((a, b) => Math.abs(b.g) - Math.abs(a.g)).slice(0, 2);
    return `${base.short}'s ${what} in ${year} are led by ${top.map(k => `${k} (${pct(bm[k])})`).join(', ')}. ` +
      (gaps.length ? `The biggest differences from the peer average are ${gaps.map(x => `${x.k} (${pp(x.g)})`).join(' and ')}. ` : '') +
      `Its top three instruments make up ${pct(top3of(bm))} of ${what}.`;
  }
  function ruleCost(year) {
    const r = companies.filter(c => c.borrowing.avg_cost && c.borrowing.avg_cost[year] != null).sort((a, b) => a.borrowing.avg_cost[year] - b.borrowing.avg_cost[year]);
    if (!r.length) return '';
    const i = r.indexOf(base), pc = peers.map(c => c.borrowing.avg_cost && c.borrowing.avg_cost[year]).filter(v => v != null);
    const pa = pc.length ? pc.reduce((a, v) => a + v, 0) / pc.length : null;
    return `In ${year}, ${r[0].short} has the lowest average borrowing cost (${pct(r[0].borrowing.avg_cost[year], 2)}) and ${r[r.length - 1].short} the highest (${pct(r[r.length - 1].borrowing.avg_cost[year], 2)}). ` +
      (i >= 0 ? `${base.short} ranks ${ord(i + 1)} of ${r.length} at ${pct(base.borrowing.avg_cost[year], 2)}` + (pa != null ? `, ${bps(base.borrowing.avg_cost[year] - pa)} against the peer average of ${pct(pa, 2)}.` : '.') : '');
  }
  function ruleCompany(c, year) {
    const b = c.borrowing, py = fyBefore(year), g = b.total[year] && b.total[py] ? b.total[year] / b.total[py] - 1 : null;
    const m = mixValues(c, 'borrowing', year, 'share'), top = m ? Object.keys(m).sort((a, z) => m[z] - m[a])[0] : null;
    const cr_ = rankOf(c, x => x.borrowing.avg_cost && x.borrowing.avg_cost[year], true);
    return `${c.name} had total borrowings of ${cr(b.total[year])} in ${year}` + (g != null ? ` (${g >= 0 ? '+' : '−'}${Math.abs(g * 100).toFixed(1)}% on ${py})` : '') + '. ' +
      (b.avg_cost && b.avg_cost[year] != null ? `Its average borrowing cost was ${pct(b.avg_cost[year], 2)}` + (cr_ ? `, ${ord(cr_.n)} lowest of ${cr_.of}` : '') + '. ' : '') +
      (top ? `The largest funding source is ${top} at ${pct(m[top])} of borrowings.` : '');
  }
  function compareFacts(c, year) {
    const b1 = base.borrowing, b2 = c.borrowing, py = fyBefore(year);
    const gr = b => b.total[year] != null && b.total[py] ? b.total[year] / b.total[py] - 1 : null;
    const c1 = b1.avg_cost && b1.avg_cost[year], c2 = b2.avg_cost && b2.avg_cost[year];
    const m1 = mixValues(base, 'borrowing', year, 'share'), m2 = mixValues(c, 'borrowing', year, 'share');
    const diffs = m1 && m2 ? [...new Set([...Object.keys(m1), ...Object.keys(m2)])].map(k => ({ k, a: m1[k] || 0, b: m2[k] || 0, d: (m1[k] || 0) - (m2[k] || 0) })).sort((a, z) => Math.abs(z.d) - Math.abs(a.d)) : [];
    return { ratio: b1.total[year] && b2.total[year] ? b1.total[year] / b2.total[year] : null, g1: gr(b1), g2: gr(b2), c1, c2,
      gap: c1 != null && c2 != null ? c1 - c2 : null, diffs, t1: top3of(m1), t2: top3of(m2) };
  }
  function ruleCompare(c, year) {
    const f = compareFacts(c, year);
    const parts = [];
    if (f.ratio) parts.push(`${base.short}'s borrowing book is ${f.ratio.toFixed(1)}x ${c.short}'s in ${year}.`);
    if (f.gap != null) parts.push(`Its average borrowing cost is ${pct(f.c1, 2)} against ${pct(f.c2, 2)} for ${c.short} (${bps(f.gap)}).`);
    if (f.diffs.length) parts.push(`The biggest funding-mix differences are ${f.diffs.slice(0, 2).map(x => `${x.k} (${pct(x.a)} vs ${pct(x.b)})`).join(' and ')}.`);
    if (f.g1 != null && f.g2 != null) parts.push(`Borrowings grew ${pct(f.g1)} at ${base.short} and ${pct(f.g2)} at ${c.short} on ${fyBefore(year)}.`);
    return parts.join(' ');
  }

  // ── BFL vs Peers ──
  function renderCompare() {
    const yr = T.default_year;
    if (!state.peer || !peers.includes(state.peer)) state.peer = peers[0];
    const c = state.peer, f = compareFacts(c, yr);

    view.append(hero(`${base.name} vs ${c.name} · ${yr}`, 'Head-to-head comparison from the standalone annual reports. Pick a peer:', [
      f.ratio ? heroKpi('Size of borrowing book', `${f.ratio.toFixed(1)}x`, `${base.short} ${cr(base.borrowing.total[yr])} · ${c.short} ${cr(c.borrowing.total[yr])}`, null, null) : null,
      f.gap != null ? heroKpi('Borrowing cost gap', bps(f.gap), `${base.short} ${pct(f.c1, 2)} · ${c.short} ${pct(f.c2, 2)}`, f.gap <= 0 ? `${base.short} cheaper` : `${c.short} cheaper`, null) : null,
      f.g1 != null && f.g2 != null ? heroKpi('Borrowing growth', pp(f.g1 - f.g2), `${base.short} ${pct(f.g1)} · ${c.short} ${pct(f.g2)}`, f.g1 >= f.g2 ? `${base.short} faster` : `${c.short} faster`, null) : null,
      f.t1 != null && f.t2 != null ? heroKpi('Top-3 concentration', pp(f.t1 - f.t2), `${base.short} ${pct(f.t1)} · ${c.short} ${pct(f.t2)}`, f.t1 <= f.t2 ? `${base.short} more diversified` : `${c.short} more diversified`, null) : null,
    ], c.color, heroControls(h('div', { class: 'tpb-seg' }, peers.map(p => h('button', { type: 'button', 'aria-pressed': String(p === c), onclick: () => { state.peer = p; render(); }, text: p.short }))))));

    view.append(aiCard(`compare:${c.key}`, `${base.short} vs ${c.short}: summary`, ruleCompare(c, yr), `the ${base.short} and ${c.short} annual reports`));

    // every peer at once
    const all = peers.map(p => ({ p, f: compareFacts(p, yr) }));
    view.append(card(`${base.short} against every peer, ${yr}`, 'Click a row to open that comparison. Negative cost gap = ' + base.short + ' borrows cheaper.',
      h('div', { class: 'tpb-table-wrap' }, h('table', { class: 'tpb-league' },
        h('thead', {}, h('tr', {}, ['Peer', `${base.short} size vs peer`, 'Cost gap', 'Growth gap', 'Biggest funding-mix difference', 'Top-3 concentration gap'].map((t, i) => h('th', { class: i && i < 4 ? 'n' : '', text: t })))),
        h('tbody', {}, all.map(({ p, f: g }) => h('tr', { class: p === c ? 'is-base' : '', style: 'cursor:pointer', onclick: () => { state.peer = p; render(); } },
          h('td', {}, h('span', { class: 'tpb-dot', style: `background:${p.color}` }), h('b', { text: p.short })),
          h('td', { class: 'n', text: g.ratio ? `${g.ratio.toFixed(1)}x` : '—' }),
          h('td', { class: 'n ' + (g.gap == null ? '' : g.gap <= 0 ? 'pos' : 'neg'), text: g.gap == null ? '—' : bps(g.gap) }),
          h('td', { class: 'n', text: g.g1 != null && g.g2 != null ? pp(g.g1 - g.g2) : '—' }),
          h('td', { text: g.diffs[0] ? `${g.diffs[0].k}: ${pct(g.diffs[0].a)} vs ${pct(g.diffs[0].b)} (${pp(g.diffs[0].d)})` : '—' }),
          h('td', { text: g.t1 != null && g.t2 != null ? pp(g.t1 - g.t2) : '—' }))))))));

    // side-by-side metrics
    const rowsM = [
      ['Total borrowings', x => x.borrowing.total[yr], cr, (a, b) => `${(a / b).toFixed(1)}x`],
      ['Borrowing growth (YoY)', x => { const t = x.borrowing.total; return t[yr] != null && t[fyBefore(yr)] ? t[yr] / t[fyBefore(yr)] - 1 : null; }, v => pct(v), (a, b) => pp(a - b)],
      ['Average borrowing cost', x => x.borrowing.avg_cost && x.borrowing.avg_cost[yr], v => pct(v, 2), (a, b) => bps(a - b)],
      ['Finance cost', x => x.borrowing.finance_cost && x.borrowing.finance_cost[yr], cr, (a, b) => `${(a / b).toFixed(1)}x`],
      ['Investment book', x => x.investments && x.investments.total[yr], cr, (a, b) => `${(a / b).toFixed(1)}x`],
      ['Top-3 funding concentration', x => top3of(mixValues(x, 'borrowing', yr, 'share')), v => pct(v), (a, b) => pp(a - b)],
    ];
    const costHolder = h('div', { class: 'tpb-chart' });
    view.append(h('div', { class: 'tpb-grid2' },
      card('Side by side', `${yr}. Difference = ${base.short} relative to ${c.short}.`, h('div', { class: 'tpb-table-wrap' }, h('table', { class: 'tpb-score' },
        h('thead', {}, h('tr', {}, ['Metric', base.short, c.short, 'Difference'].map((t, i) => h('th', { class: i ? 'n' : '', text: t })))),
        h('tbody', {}, rowsM.map(([name, get, fmt, diff]) => { const a = get(base), b = get(c); return h('tr', {},
          h('td', {}, h('b', { text: name })), h('td', { class: 'n tpb-score-v', text: a != null ? fmt(a) : '—' }), h('td', { class: 'n', text: b != null ? fmt(b) : '—' }),
          h('td', { class: 'n', text: a != null && b != null && b !== 0 ? diff(a, b) : '—' })); }))))),
      card('Borrowing cost over time', `${base.short} and ${c.short}.`, legend([{ color: base.color, label: base.short, kind: 'line' }, { color: c.color, label: c.short, kind: 'line' }]), costHolder)));
    const cy = T.years.filter(y => (base.borrowing.avg_cost || {})[y] != null || (c.borrowing.avg_cost || {})[y] != null);
    requestAnimationFrame(() => lineChart(costHolder, { years: cy, series: [{ name: base.short, color: base.color, values: base.borrowing.avg_cost || {} }, { name: c.short, color: c.color, values: c.borrowing.avg_cost || {} }], fmt: v => pct(v, 2), axisFmt: v => +(v * 100).toFixed(2) + '%', minZero: false, height: 230 }));

    // mix side by side
    const grid2 = h('div', { class: 'tpb-grid2' });
    [['borrowing', 'Borrowing mix'], ['investments', 'Investment mix']].forEach(([part, label]) => {
      const m1 = mixValues(base, part, yr, 'share'), m2 = mixValues(c, part, yr, 'share'); if (!m1 || !m2) return;
      const cats = [...new Set([...Object.keys(m1), ...Object.keys(m2)])].filter(k => (m1[k] || 0) + (m2[k] || 0) > 0.0005).sort((a, z) => ((m1[z] || 0) + (m2[z] || 0)) - ((m1[a] || 0) + (m2[a] || 0)));
      const holder = h('div', { class: 'tpb-chart' });
      const ser = [{ name: base.short, color: base.color, values: m1 }, { name: c.short, color: c.color, values: m2 }];
      grid2.append(card(`${label}, ${yr}`, `Share of total ${part === 'borrowing' ? 'borrowings' : 'investments'}.`, legend(ser.map(x => ({ color: x.color, label: x.name }))), holder,
        table([{ label: 'Instrument', get: r => r }, { label: base.short, num: 1, get: r => pct(m1[r] || 0) }, { label: c.short, num: 1, get: r => pct(m2[r] || 0) },
               { label: 'Difference', num: 1, get: r => pp((m1[r] || 0) - (m2[r] || 0)), cls: r => (m1[r] || 0) >= (m2[r] || 0) ? 'pos' : 'neg' }], cats)));
      requestAnimationFrame(() => groupedBars(holder, { categories: cats, series: ser, fmt: pct, axisFmt: v => Math.round(v * 100) + '%', labelSeries: ser[0] }));
    });
    view.append(grid2);
    view.append(howCard('compare', 'mix', 'cost'));
  }

  function renderOverview() {
    const bt = T.summary.find(t => t.kind === 'borrowing'), it = T.summary.find(t => t.kind === 'investment');
    const yr = (bt && bt.fy) || T.default_year;
    const costRow = bt && bt.rows.find(r => /cost/i.test(r.metric));
    const b = base.borrowing, inv = base.investments;
    const py = prevYear(b.years, yr);
    const costRank = rankOf(base, c => c.borrowing.avg_cost && c.borrowing.avg_cost[yr], true);
    const sizeRank = rankOf(base, c => c.borrowing.total[yr]);
    const gRank = rankOf(base, c => { const p = c.borrowing.total['FY' + String(+yr.slice(2) - 1).padStart(2, '0')]; return p ? c.borrowing.total[yr] / p - 1 : null; });
    const g = py && b.total[py] ? b.total[yr] / b.total[py] - 1 : null;
    view.append(hero(`${base.name} vs ${peers.length} peers · ${yr}`,
      AUTO ? `Standalone annual reports · ${peers.map(p => p.short).join(', ')} · updated ${String(T.generated_at || '').slice(0, 10)}` : `Source: ${T.source}`,
      [costRow ? heroKpi('Average borrowing cost', pct(costRow.bfl, 2), [`Peer avg ${pct(costRow.peer, 2)} · `, h('b', { text: bps(costRow.gap) })],
          costRank ? (costRank.n === 1 ? 'Lowest' : `${ord(costRank.n)} lowest`) + ` of ${costRank.of}` : null, sparkline(series(b.avg_cost), { fmt: v => pct(v, 2) })) : null,
       heroKpi('Total borrowings', cr(b.total[yr]), g != null ? [h('b', { text: growth(b.total[yr], b.total[py]) }), ` vs ${py}`] : '',
          sizeRank ? (sizeRank.n === 1 ? 'Largest' : `${ord(sizeRank.n)} largest`) + ` of ${sizeRank.of}` : null, sparkline(series(b.total, b.years), { fmt: cr })),
       g != null ? heroKpi('Borrowing growth', (g >= 0 ? '+' : '−') + Math.abs(g * 100).toFixed(1) + '%', `${py} → ${yr}`,
          gRank ? (gRank.n === 1 ? 'Fastest' : `${ord(gRank.n)} fastest`) + ` of ${gRank.of}` : null, null) : null,
       inv ? heroKpi('Investment book', cr(inv.total[yr]), inv.total[prevYear(inv.years, yr)] ? [h('b', { text: growth(inv.total[yr], inv.total[prevYear(inv.years, yr)]) }), ` vs ${prevYear(inv.years, yr)}`] : '',
          null, sparkline(series(inv.total, inv.years), { fmt: cr })) : null],
      null, editButton()));
    const missing = Object.entries(T.missing || {}).filter(([, v]) => v && v.length);
    if (missing.length) {
      const names = Object.fromEntries((T.companies || []).map(c => [c.key, c.short]));
      view.append(h('details', { class: 'tpb-card', style: 'padding:10px 16px' },
        h('summary', { text: `Data not yet available for some NBFCs / years (${missing.length})` }),
        h('ul', { class: 'tpb-obs' }, missing.map(([k, v]) => h('li', {}, h('b', { text: names[k] || k }), h('div', { text: v.join(', ') })))),
        h('div', { class: 'foot', text: 'Years are filled in automatically when the report is found. For anything not on NSE/BSE, a direct PDF link can be added in scraper/treasury-sources.js.' })));
    }

    if (T.overview_summary && T.overview_summary.text) SECTIONS['summary:overview'] = T.overview_summary;
    view.append(aiCard('summary:overview', 'Executive summary', [ruleMix('borrowing', yr), ruleCost(yr)].filter(Boolean).join(' '), 'all the dashboards'));

    // Funding mix of every NBFC side by side
    const stackHolder = h('div', { class: 'tpb-chart' }), stackLegend = h('div');
    view.append(card(`Funding mix at a glance, ${yr}`, 'Share of total borrowings by instrument, every NBFC on the same scale. Hover a segment for the amount.',
      stackLegend, stackHolder,
      table([{ label: 'NBFC', get: r => r.c.short }, ...base.borrowing.mix.categories.map(k => ({ label: k, num: 1, get: r => { const m = mixValues(r.c, 'borrowing', yr, 'share'); return m && m[k] ? pct(m[k]) : '—'; } }))],
        companies.map(c => ({ c })))));
    requestAnimationFrame(() => stackLegend.replaceChildren(legend(mixStack(stackHolder, 'borrowing', yr))));

    view.append(card('Peer league table', `Sorted by size of borrowing book. ${base.short} highlighted; "vs ${base.short}" is each peer's borrowing cost minus ${base.short}'s.`, leagueTable(yr)));

    view.append(h('h4', { class: 'tpb-section', text: `Where ${base.short} differs from the peer average` }));
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
    view.append(howCard('mix', 'cost'));
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

    const what = part === 'borrowing' ? 'Borrowing mix' : 'Investment mix', book = part === 'borrowing' ? 'borrowings' : 'investments';
    // headline numbers for the base company
    const bShare = mixValues(base, part, year, 'share');
    const shAvg = peerAvg(cats, part, year, 'share');
    const sorted = bShare ? cats.slice().sort((a, b) => (bShare[b] || 0) - (bShare[a] || 0)) : [];
    const gaps = bShare ? cats.map(k => ({ k, g: (bShare[k] || 0) - (shAvg[k] || 0) })).filter(x => shAvg[x.k] != null).sort((a, b) => Math.abs(b.g) - Math.abs(a.g)) : [];
    const top3 = m => m ? Object.values(m).sort((a, b) => b - a).slice(0, 3).reduce((a, v) => a + (v || 0), 0) : null;
    const peerTop3 = peers.map(c => top3(mixValues(c, part, year, 'share'))).filter(v => v != null);
    const pTop3 = peerTop3.length ? peerTop3.reduce((a, v) => a + v, 0) / peerTop3.length : null;
    const used = bShare ? cats.filter(k => (bShare[k] || 0) > 0.0005).length : 0;
    view.append(hero(`${what} · ${year}`,
      (part === 'borrowing' ? `How ${base.short} and ${peers.length} peers fund themselves` : `Where ${base.short} and ${peers.length} peers hold their investments`) + (missing.length ? ` · no ${year} data for ${missing.map(c => c.short).join(', ')}` : ''),
      [sorted[0] ? heroKpi(`${base.short}'s largest ${part === 'borrowing' ? 'source' : 'holding'}`, sorted[0], `${pct(bShare[sorted[0]])} of ${book} · peers ${pct(shAvg[sorted[0]])}`, null, null) : null,
       gaps[0] ? heroKpi('Biggest gap vs peers', gaps[0].k, [h('b', { text: pp(gaps[0].g) }), ` · ${base.short} ${pct(bShare[gaps[0].k])} vs ${pct(shAvg[gaps[0].k])}`], null, null) : null,
       bShare ? heroKpi('Top-3 concentration', pct(top3(bShare)), pTop3 != null ? [`Peer avg ${pct(pTop3)} · `, h('b', { text: pp(top3(bShare) - pTop3) })] : '', null, null) : null,
       bShare ? heroKpi('Instruments in use', String(used), `of ${cats.length} categories across peers`, null, null) : null],
      null, heroControls(...yearSelect(years, year, v => { state.year = v; render(); }),
        seg([{ value: 'share', label: '% of total' }, { value: 'amount', label: '₹ crore' }], unit, v => { state.unit = v; render(); }))));

    view.append(aiCard(part === 'borrowing' ? 'summary:borrowing_mix' : 'summary:investment_mix', `${what}: summary`, ruleMix(part, year), `the ${what.toLowerCase()} dashboard`));
    const stackHolder = h('div', { class: 'tpb-chart' }), stackLegend = h('div');
    view.append(card(`${what} at a glance, ${year}`, `Share of each NBFC's total ${book}, on the same 0–100% scale. Hover a segment for the amount.`, stackLegend, stackHolder));
    requestAnimationFrame(() => stackLegend.replaceChildren(legend(mixStack(stackHolder, part, year))));

    view.append(card(`Instrument heatmap, ${year}`, `Darker = larger share of the company's ${book}. ${base.short}'s column is outlined.`, heatTable(part, year, cats)));

    const chart = h('div', { class: 'tpb-chart' });
    view.append(card(`${what} by instrument, ${year}${unit === 'amount' ? ' (₹ crore)' : ''}`,
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
    view.append(howCard('mix'));
  }

  function renderKpi() {
    const years = T.years;
    const mk = (get) => companies.map(c => ({ name: c.short, color: c.color, values: Object.fromEntries(years.map(y => [y, get(c, y)])) }));
    const costSeries = mk((c, y) => c.borrowing.avg_cost[y] ?? null);
    const totSeries = mk((c, y) => c.borrowing.total[y] ?? null);
    const fcSeries = mk((c, y) => c.borrowing.finance_cost[y] ?? null);
    const invSeries = mk((c, y) => c.investments ? (c.investments.total[y] ?? null) : null);
    const latest = c => { if (c.borrowing.avg_cost[T.default_year] != null) return T.default_year; const ys = c.borrowing.years.filter(y => c.borrowing.avg_cost[y] != null); return ys[ys.length - 1]; };

    const yr = T.default_year, b = base.borrowing;
    const pyr = 'FY' + String(+yr.slice(2) - 1).padStart(2, '0');
    const costOf = c => c.borrowing.avg_cost && c.borrowing.avg_cost[yr];
    const peerCosts = peers.map(costOf).filter(v => v != null);
    const peerAvgCost = peerCosts.length ? peerCosts.reduce((a, v) => a + v, 0) / peerCosts.length : null;
    const cheapest = peers.filter(c => costOf(c) != null).sort((a, z) => costOf(a) - costOf(z))[0];
    const costRank = rankOf(base, costOf, true);
    const fcg = b.finance_cost[yr] && b.finance_cost[pyr] ? b.finance_cost[yr] / b.finance_cost[pyr] - 1 : null;
    view.append(hero(`Cost & KPIs · ${yr}`, `Borrowing cost, size and investment book across ${companies.length} NBFCs · ${years[0]}–${years[years.length - 1]}`, [
      costOf(base) != null ? heroKpi(`${base.short} borrowing cost`, pct(costOf(base), 2), b.avg_cost[pyr] != null ? [h('b', { text: bps(costOf(base) - b.avg_cost[pyr]) }), ` vs ${pyr}`] : '',
        costRank ? (costRank.n === 1 ? 'Lowest' : `${ord(costRank.n)} lowest`) + ` of ${costRank.of}` : null, sparkline(series(b.avg_cost), { fmt: v => pct(v, 2) })) : null,
      peerAvgCost != null ? heroKpi('Peer average cost', pct(peerAvgCost, 2), costOf(base) != null ? [`${base.short} is `, h('b', { text: bps(costOf(base) - peerAvgCost) }), ' vs peers'] : '', null, null) : null,
      cheapest ? heroKpi('Cheapest peer', `${cheapest.short} · ${pct(costOf(cheapest), 2)}`, costOf(base) != null ? [`${base.short} `, h('b', { text: bps(costOf(base) - costOf(cheapest)) }), ' vs it'] : '', null, null) : null,
      fcg != null ? heroKpi(`${base.short} finance cost`, cr(b.finance_cost[yr]), [h('b', { text: (fcg >= 0 ? '+' : '−') + Math.abs(fcg * 100).toFixed(1) + '%' }), ` vs ${pyr}`], null, sparkline(series(b.finance_cost, b.years), { fmt: cr })) : null,
    ]));

    view.append(aiCard('summary:cost_kpis', 'Cost & KPIs: summary', ruleCost(yr), 'the Cost & KPIs dashboard'));
    const rankHolder = h('div', { class: 'tpb-chart' }), sizeHolder = h('div', { class: 'tpb-chart' });
    const top = h('div', { class: 'tpb-grid2' },
      card(`Borrowing cost ranking, ${yr}`, 'Lowest cost first, on a zoomed scale. Dashed line = peer average (excluding ' + base.short + ').', rankHolder),
      card(`Borrowing book ranking, ${yr}`, 'Total borrowings at year end, largest first.', sizeHolder));
    view.append(top);
    requestAnimationFrame(() => {
      rankBars(rankHolder, companies.map(c => ({ c, v: costOf(c), label: 'avg borrowing cost' })), { fmt: v => pct(v, 2), tickFmt: v => +(v * 100).toFixed(2) + '%', avg: peerAvgCost, avgLabel: 'Peer avg', dots: true });
      rankBars(sizeHolder, companies.map(c => ({ c, v: c.borrowing.total[yr], label: 'total borrowings' })), { fmt: cr, tickFmt: crAxis, asc: false });
    });
    view.append(h('h4', { class: 'tpb-section', text: 'Trends' }));

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
    view.append(howCard('cost'));
  }

  function renderCompany(tab) {
    const c = tab.company, b = c.borrowing, inv = c.investments;
    const years = b.years;
    const year = years.includes(state.companyYear[c.name]) ? state.companyYear[c.name] : (years.includes(T.default_year) ? T.default_year : years[years.length - 1]);
    const pv = prevYear(years, year);
    const shares = b.mix.shares;
    const topCat = b.mix.categories.slice().sort((a, z) => (shares[z][year] || 0) - (shares[a][year] || 0))[0];
    const cost = b.avg_cost[year], pcost = b.avg_cost[pv];
    const costRank = rankOf(c, x => x.borrowing.avg_cost && x.borrowing.avg_cost[year], true);
    const sizeRank = rankOf(c, x => x.borrowing.total[year]);
    const yearPick = h('div', { class: 'tpb-hero-pick' }, ...yearSelect(years, year, v => { state.companyYear[c.name] = v; render(); }));
    view.append(hero(c.name + (c === base ? ' (base)' : ''), `Standalone annual reports · ${years[0]}–${years[years.length - 1]}`, [
      heroKpi(`Total borrowings, ${year}`, cr(b.total[year]), b.total[pv] ? [h('b', { text: growth(b.total[year], b.total[pv]) }), ` vs ${pv}`] : '',
        sizeRank ? (sizeRank.n === 1 ? 'Largest' : `${ord(sizeRank.n)} largest`) + ` of ${sizeRank.of}` : null, sparkline(series(b.total, years), { fmt: cr })),
      heroKpi(`Average borrowing cost, ${year}`, pct(cost, 2), pcost != null && cost != null ? [h('b', { text: bps(cost - pcost) }), ` vs ${pv}`] : '',
        costRank ? (costRank.n === 1 ? 'Lowest' : `${ord(costRank.n)} lowest`) + ` of ${costRank.of}` : null, sparkline(series(b.avg_cost), { fmt: v => pct(v, 2) })),
      topCat ? heroKpi(`Largest funding source, ${year}`, topCat, `${pct(shares[topCat][year])} of borrowings`, null, null) : null,
      inv ? heroKpi(`Investment book, ${year}`, cr(inv.total[year]), inv.total[pv] ? [h('b', { text: growth(inv.total[year], inv.total[pv]) }), ` vs ${pv}`] : '', null, sparkline(series(inv.total, inv.years), { fmt: cr })) : null,
    ], c.color, yearPick));

    view.append(aiCard(`summary:company:${c.key}`, `${c.short}: summary`, ruleCompany(c, year), `${c.short}'s annual reports`));
    if (c !== base) {
      const f = compareFacts(c, year);
      view.append(h('div', { class: 'tpb-card tpb-cmp' },
        h('div', { class: 'tpb-aicard-head' }, h('h3', { text: `Compared with ${base.short}, ${year}` }), h('span', { style: 'flex:1' }),
          h('button', { type: 'button', class: 'tpb-edit', onclick: () => { state.peer = c; const i = TABS.findIndex(t => t.kind === 'compare'); const btn = document.querySelectorAll('#subtabBar .subtab')[i]; if (btn) btn.click(); }, text: 'Open full comparison →' })),
        h('div', { class: 'tpb-cmp-grid' },
          h('div', {}, h('div', { class: 'k', text: 'Size of borrowing book' }), h('div', { class: 'v', text: f.ratio ? `${base.short} is ${f.ratio.toFixed(1)}x` : '—' })),
          h('div', {}, h('div', { class: 'k', text: 'Borrowing cost gap' }), h('div', { class: 'v', text: f.gap != null ? `${bps(f.gap)} (${f.gap <= 0 ? base.short + ' cheaper' : c.short + ' cheaper'})` : '—' })),
          h('div', {}, h('div', { class: 'k', text: 'Biggest funding-mix difference' }), h('div', { class: 'v', text: f.diffs[0] ? `${f.diffs[0].k} ${pp(f.diffs[0].d)}` : '—' }))),
        h('div', { class: 'tpb-summary' }, h('p', { text: (SECTIONS[`compare:${c.key}`] || {}).text || ruleCompare(c, year) })),
        h('div', { class: 'foot', text: SECTIONS[`compare:${c.key}`] ? 'AI summary — see "How this summary was generated" on the comparison tab.' : 'Rule-based draft; the AI version appears after the next AI commentary run.' })));
    }
    // Scorecard
    view.append(card(`Scorecard, ${year}`, `${c.short} against the other ${companies.length - 1} NBFCs. Rank 1 = largest; for cost and concentration rank 1 = lowest. ▲/▼ marks better or worse than peers where lower is clearly better.`, scorecard(c, year)));

    // Trends: borrowing book and cost vs peers
    const others = companies.filter(x => x !== c);
    const bookHolder = h('div', { class: 'tpb-chart' }), costHolder = h('div', { class: 'tpb-chart' });
    const peerCost = Object.fromEntries(T.years.map(y => { const v = others.map(x => x.borrowing.avg_cost && x.borrowing.avg_cost[y]).filter(v => v != null); return [y, v.length ? v.reduce((a, z) => a + z, 0) / v.length : null]; }));
    const costYears = T.years.filter(y => (b.avg_cost && b.avg_cost[y] != null) || peerCost[y] != null);
    view.append(h('div', { class: 'tpb-grid2' },
      card('Borrowing book', 'Total borrowings at year end, ₹ crore; growth on the previous year below each column.', bookHolder),
      card('Borrowing cost vs peers', `${c.short} against the simple average of the other NBFCs.`,
        legend([{ color: c.color, label: c.short, kind: 'line' }, { color: '#52514e', label: 'Peer average', kind: 'line' }]), costHolder)));
    requestAnimationFrame(() => {
      columnChart(bookHolder, { years, values: b.total, color: c.color, fmt: cr, axisFmt: crAxis });
      lineChart(costHolder, { years: costYears, series: [{ name: c.short, color: c.color, values: b.avg_cost || {} }, { name: 'Peer average', color: '#52514e', values: peerCost }], fmt: v => pct(v, 2), axisFmt: v => +(v * 100).toFixed(2) + '%', minZero: false, height: 230 });
    });

    // Funding mix over time
    const mixYears = years.filter(y => mixValues(c, 'borrowing', y, 'share'));
    if (mixYears.length) {
      const mtHolder = h('div', { class: 'tpb-chart' }), mtLegend = h('div');
      view.append(card('Funding mix over time', `Share of ${c.short}'s total borrowings by instrument, each year. Hover a segment for the amount.`, mtLegend, mtHolder));
      requestAnimationFrame(() => mtLegend.replaceChildren(legend(stackRows(mtHolder, mixYears.slice().reverse().map(y => ({
        label: y, bold: y === year, title: `${c.name} · ${y}`, m: mixValues(c, 'borrowing', y, 'share'),
        amount: k => b.mix.amounts[k] && b.mix.amounts[k][y] })), 'borrowing'))));
    }

    // Mix vs the peer average (other NBFCs)
    const grid2 = h('div', { class: 'tpb-grid2' });
    const vsPeers = (part, label) => {
      const p = partOf(c, part); if (!p || !p.years.includes(year)) return;
      const cats = p.mix.categories.filter(cat => (p.mix.shares[cat][year] || 0) >= 0.0005);
      const avg = othersAvgMix(c, part, year, cats);
      const holder = h('div', { class: 'tpb-chart' });
      grid2.append(card(`${label} vs peer average, ${year}`, `Share of total ${part === 'borrowing' ? 'borrowings' : 'investments'} by instrument; the tick is the average of the other NBFCs.`,
        legend([{ color: c.color, label: c.short }, { color: '#52514e', label: 'Peer average', kind: 'tick' }]), holder,
        table([{ label: 'Instrument', get: r => r }, { label: 'Share', num: 1, get: r => pct(p.mix.shares[r][year]) }, { label: 'Peer avg', num: 1, get: r => pct(avg[r]) },
               { label: 'Gap', num: 1, get: r => avg[r] == null ? '—' : pp(p.mix.shares[r][year] - avg[r]), cls: r => (p.mix.shares[r][year] - (avg[r] || 0)) >= 0 ? 'pos' : 'neg' },
               { label: '₹ crore', num: 1, get: r => cr(p.mix.amounts[r][year]) }], cats)));
      const only = { name: c.short, color: c.color, values: Object.fromEntries(cats.map(cat => [cat, p.mix.shares[cat][year]])) };
      requestAnimationFrame(() => groupedBars(holder, { categories: cats, series: [only], fmt: pct, axisFmt: v => Math.round(v * 100) + '%', avg: others.length ? avg : null, labelSeries: only }));
    };
    vsPeers('borrowing', 'Borrowing mix'); vsPeers('investments', 'Investment mix');
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
    view.append(howCard('mix', 'cost'));
  }

  function renderEmpty() {
    if (NO_BASE) {
      view.append(card('Bajaj Finance figures not available yet', '',
        h('div', { class: 'tpb-empty', text: `Annual reports have been read for ${companies.map(c => c.short).join(', ')}, but not yet for Bajaj Finance, so there is nothing to compare against. The dashboards appear once the next run reads Bajaj Finance's report.` })));
      return;
    }
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
